/**
 * workers/SendWorker.js
 * Worker ارسال: دریافت آیتم از صف، دانلود مدیا، ارسال به تلگرام
 *
 * با محدودیت concurrency کار می‌کنه تا همزمان چند فایل دانلود و ارسال نشه
 */

import { Mutex } from 'async-mutex';
import { workerLogger as log } from '../utils/Logger.js';
import { sleep, formatBytes } from '../utils/Helpers.js';
import { incrementDailyStat } from '../database/db.js';
import SentItemsRepository from '../database/SentItemsRepository.js';
import TrackedAccountsRepository from '../database/TrackedAccountsRepository.js';
import igClient from '../instagram/IgClient.js';
import mediaDownloader from '../instagram/MediaDownloader.js';
import channelSender from '../telegram/ChannelSender.js';
import config from '../config/env.js';

class SendWorker {
  constructor() {
    this.queue = [];
    this.queuedJobKeys = new Set();
    this.mutex = new Mutex();
    this.isProcessing = false;
    this.maxConcurrent = config.workers.maxConcurrentSends;
    this.active = 0;
    this.processedCount = 0;
    this.failedCount = 0;
  }

  /**
   * Add an item to the queue
   */
  async enqueue(job) {
    const jobKey = job.sentItemId ? `sent-item:${job.sentItemId}` : null;
    if (jobKey && this.queuedJobKeys.has(jobKey)) {
      log.debug({ msg: 'Duplicate queue job ignored', jobKey });
      return false;
    }
    if (jobKey) this.queuedJobKeys.add(jobKey);
    this.queue.push({ ...job, jobKey });
    log.debug({
      msg: 'Job enqueued',
      type: job.type,
      account: job.account?.username,
      mediaPk: job.item?.pk,
      queueSize: this.queue.length,
    });

    // Trigger processing
    this._processNext();
    return true;
  }

  /**
   * Restore durable pending jobs after a restart or manual retry request.
   */
  async recoverPending(limit = 1000, { recoverInterrupted = false } = {}) {
    const recovered = recoverInterrupted
      ? SentItemsRepository.recoverInterrupted()
      : { changes: 0 };
    const pending = SentItemsRepository.getPending(limit);
    const enqueued = await this.recoverRows(pending);

    log.info({
      msg: 'Durable send jobs recovered',
      interrupted: recovered.changes,
      pending: pending.length,
      enqueued,
    });
    return enqueued;
  }

  async recoverRows(rows) {
    let enqueued = 0;
    for (const row of rows) {
      const account = TrackedAccountsRepository.getByUsername(row.account_username);
      if (!account) continue;
      let mediaUrls = [];
      try {
        mediaUrls = row.media_urls ? JSON.parse(row.media_urls) : [];
      } catch {}

      const added = await this.enqueue({
        sentItemId: row.id,
        type: row.media_type,
        account,
        item: {
          pk: row.media_pk,
          id: row.media_id || row.media_pk,
          type: row.media_type,
          isReel: row.media_type === 'reel',
          shortcode: row.shortcode,
          takenAt: row.taken_at,
          caption: row.caption || '',
          mediaUrls,
          mediaUrl: mediaUrls[0] || null,
        },
      });
      if (added) enqueued++;
    }
    return enqueued;
  }

  /**
   * Process queue items
   */
  async _processNext() {
    if (this.isProcessing) return;

    this.isProcessing = true;
    try {
      while (this.queue.length > 0 && this.active < this.maxConcurrent) {
        const job = this.queue.shift();
        this.active++;

        // Fire and forget - errors handled inside
        this._processJob(job)
          .catch(e => {
            log.error({ msg: 'Job processing error', error: e.message, job: job.type });
          })
          .finally(() => {
            this.active--;
            if (job.jobKey) this.queuedJobKeys.delete(job.jobKey);
            this._processNext();
          });
      }
    } finally {
      this.isProcessing = false;
    }

    // If more jobs are queued but we're at capacity, schedule a retry
    if (this.queue.length > 0 && this.active >= this.maxConcurrent) {
      setTimeout(() => this._processNext(), 1000);
    }
  }

  /**
   * Process a single job
   */
  async _processJob(job) {
    const { sentItemId, type, account, item } = job;
    log.info({
      msg: '🚀 Processing job started',
      type,
      account: account.username,
      mediaPk: item.pk,
      shortcode: item.shortcode,
      sentItemId,
      mediaUrlsCount: item.mediaUrls?.length || 0,
    });

    // Mark as processing
    if (sentItemId) {
      SentItemsRepository.updateStatus(sentItemId, 'processing');
    }

    let downloadResult = null;
    let currentStage = 'refresh';

    try {
      // Refresh statistics immediately before sending. Failures use the queued
      // snapshot so a temporary Instagram API issue does not discard the post.
      try {
        const profile = await igClient.getUserByUsername(account.username, { force: false });
        TrackedAccountsRepository.updateProfile(account.username, profile);
        Object.assign(account, {
          pk: profile.pk,
          full_name: profile.fullName,
          profile_pic_url: profile.profilePicUrl,
          is_private: profile.isPrivate ? 1 : 0,
          is_verified: profile.isVerified ? 1 : 0,
          follower_count: profile.followerCount,
          following_count: profile.followingCount,
          media_count: profile.mediaCount,
          biography: profile.biography,
        });
      } catch (e) {
        log.warn({
          msg: 'Send-time profile refresh failed; using queued statistics',
          username: account.username,
          error: e.message,
        });
      }

      if (type === 'post' || type === 'reel') {
        try {
          const freshItem = await igClient.getMediaInfo(item.pk);
          Object.assign(item, freshItem, {
            user: { ...(item.user || {}), ...(freshItem.user || {}) },
          });
        } catch (e) {
          log.warn({
            msg: 'Send-time media refresh failed; using queued post data',
            mediaPk: item.pk,
            error: e.message,
          });
        }
      }

      currentStage = 'download';
      // Step 1: Download media
      log.info({
        msg: '📥 Step 1: Downloading media',
        type,
        account: account.username,
        mediaPk: item.pk,
      });

      if (type === 'post' || type === 'reel') {
        downloadResult = await mediaDownloader.downloadPost(item);
      } else if (type === 'story') {
        downloadResult = await mediaDownloader.downloadStory(item);
      }

      if (!downloadResult || downloadResult.items.length === 0) {
        throw new Error('No media downloaded (downloadResult is empty)');
      }

      log.info({
        msg: '✓ Media downloaded',
        itemCount: downloadResult.items.length,
        totalSize: formatBytes(downloadResult.items.reduce((s, f) => s + (f.size || 0), 0)),
        files: downloadResult.items.map(f => ({ path: f.path, size: f.size, mime: f.mime })),
      });

      // Save file info to DB
      if (sentItemId) {
        const totalSize = downloadResult.items.reduce((s, f) => s + (f.size || 0), 0);
        SentItemsRepository.updateStatus(sentItemId, 'processing', {
          filePath: downloadResult.items.map(f => f.path).join('|'),
          fileSize: totalSize,
        });
      }

      // Step 2: Send to Telegram
      currentStage = 'send';
      log.info({
        msg: '📤 Step 2: Sending to Telegram',
        type,
        account: account.username,
        mediaPk: item.pk,
        filesCount: downloadResult.items.length,
      });

      const accountInfo = {
        username: account.username,
        fullName: account.full_name,
        isVerified: account.is_verified === 1,
        pk: account.pk,
        followerCount: account.follower_count,
        followingCount: account.following_count,
        mediaCount: account.media_count,
      };

      let result;
      if (type === 'post' || type === 'reel') {
        result = await channelSender.sendPost(item, downloadResult, accountInfo);
      } else if (type === 'story') {
        result = await channelSender.sendStory(item, downloadResult, accountInfo);
      }

      log.info({
        msg: '✓ Sent to Telegram',
        messageId: Array.isArray(result) ? result[0]?.id : result?.id,
        chatId: Array.isArray(result) ? result[0]?.chatId : result?.chatId,
      });

      // Mark as sent
      if (sentItemId) {
        const messageId = Array.isArray(result) ? result[0]?.id : result?.id;
        const chatId = Array.isArray(result) ? result[0]?.chatId : result?.chatId;
        SentItemsRepository.updateStatus(sentItemId, 'sent', {
          tgMessageId: messageId,
          tgChatId: chatId,
        });
      }

      this.processedCount++;
      log.info({
        msg: '🎉 Job completed successfully',
        type,
        account: account.username,
        mediaPk: item.pk,
        processedCount: this.processedCount,
      });

    } catch (e) {
      log.error({
        msg: '❌ Job failed',
        type,
        account: account.username,
        mediaPk: item.pk,
        shortcode: item.shortcode,
        stage: currentStage,
        error: e.message,
        stack: e.stack?.split('\n').slice(0, 5),
        mediaUrls: item.mediaUrls,
      });

      if (sentItemId) {
        SentItemsRepository.updateStatus(sentItemId, 'failed', {
          error: e.message?.slice(0, 500),
        });
      }

      incrementDailyStat('failed_count');
      this.failedCount++;

      // Send detailed failure report to Telegram
      // (always send, with rate limit per item to avoid spam)
      const alertKey = `${account.username}:${type}:${item.pk}`;
      const now = Date.now();
      if (!this._lastAlertTime) this._lastAlertTime = new Map();
      const lastAlert = this._lastAlertTime.get(alertKey) || 0;

      // Rate limit: 1 alert per item per 5 minutes
      if (now - lastAlert > 5 * 60 * 1000) {
        this._lastAlertTime.set(alertKey, now);

        // Send detailed failure report
        await channelSender.sendFailureReport({
          type,
          account: account.username,
          mediaPk: item.pk,
          shortcode: item.shortcode,
          caption: item.caption,
          mediaUrls: item.mediaUrls,
          error: e,
          downloadStage: currentStage,
        }).catch((alertErr) => {
          log.warn({ msg: 'Could not send failure report to Telegram', error: alertErr.message });
        });
      }

    } finally {
      // Cleanup downloaded files
      if (downloadResult) {
        mediaDownloader.cleanup(downloadResult);
      }
    }
  }

  /**
   * Get queue stats
   */
  getStats() {
    return {
      queueSize: this.queue.length,
      active: this.active,
      processed: this.processedCount,
      failed: this.failedCount,
    };
  }
}

const sendWorker = new SendWorker();
export default sendWorker;
