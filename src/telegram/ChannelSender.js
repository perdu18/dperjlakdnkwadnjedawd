/**
 * telegram/ChannelSender.js
 * ارسال پیام‌ها و فایل‌ها به کانال تلگرام
 */

import { tgLogger as log } from '../utils/Logger.js';
import { retryTgRequest } from '../utils/Retry.js';
import { formatBytes } from '../utils/Helpers.js';
import { incrementDailyStat } from '../database/db.js';
import config from '../config/env.js';           // FIX: قبلاً import نشده بود -> ReferenceError
import messageFormatter from './MessageFormatter.js';
import tgClient from './TgClient.js';

class ChannelSender {
  constructor() {
    // FIX: به‌جای هک config_import_maxConcurrentSends() از مقدار واقعی env استفاده می‌کنیم
    this.maxConcurrent = config.workers.maxConcurrentSends;
    this.active = 0;
  }

  async sendPost(post, downloadResult, accountInfo) {
    if (!tgClient.isReady()) throw new Error('Telegram client not connected');

    this.active++;
    try {
      const fullCaption = messageFormatter.formatPost(post, accountInfo);
      const { html: caption, captionTruncated } =
        messageFormatter.formatPostForMedia(post, accountInfo, 1024);
      const files = downloadResult.items;

      let result;

      if (files.length === 0) {
        // بدون مدیا -> پیام متنی (tgClient خودش روی 4096 تکه می‌کند)
        result = await retryTgRequest(() => tgClient.sendMessage(fullCaption));
        incrementDailyStat('posts_sent');
        return result;
      }

      if (files.length === 1) {
        const file = files[0];
        const isVideo = file.mime?.startsWith('video/');
        const isImage = file.mime?.startsWith('image/');

        result = await retryTgRequest(() => tgClient.sendFile(file.path, {
          caption,
          asPhoto: isImage,
          forceDocument: !isImage && !isVideo,
          supportsStreaming: isVideo,
        }));
      } else {
        // آلبوم (carousel) — sendAlbum خودش هر batch را جدا retry می‌کند
        result = await tgClient.sendAlbum(files.map(f => f.path), { caption });
      }

      const firstMessageId = Array.isArray(result) ? result[0]?.id : result?.id;
      let fullCaptionAttached = false;

      if (captionTruncated && post.caption && firstMessageId) {
        const identifier = String(post.shortcode || post.pk || 'post')
          .replace(/[^a-zA-Z0-9_-]/g, '_');
        try {
          await retryTgRequest(() => tgClient.sendTextFile(post.caption, {
            filename: `instagram-caption-${identifier}.txt`,
            replyTo: firstMessageId,
            caption: '📄 کپشن کامل و اصلی اینستاگرام',
          }));
          fullCaptionAttached = true;
        } catch (e) {
          // پست اصلی ارسال شده؛ نباید کل job به‌خاطر فایل ضمیمه fail و دوباره ارسال شود
          log.error({
            msg: 'Post sent, but full-caption document failed',
            postPk: post.pk, messageId: firstMessageId, error: e.message,
          });
        }
      }

      incrementDailyStat('posts_sent');
      log.info({
        msg: 'Post sent to Telegram',
        postPk: post.pk,
        type: post.type,
        filesCount: files.length,
        totalSize: formatBytes(files.reduce((s, f) => s + (f.size || 0), 0)),
        captionLength: messageFormatter.getRenderedLength(caption),
        fullCaptionAttached,
      });

      return result;
    } finally {
      this.active--;
    }
  }

  async sendStory(story, downloadResult, accountInfo) {
    if (!tgClient.isReady()) throw new Error('Telegram client not connected');

    this.active++;
    try {
      const fullCaption = messageFormatter.formatStory(story, accountInfo);
      const { html: caption, captionTruncated } =
        messageFormatter.formatStoryForMedia(story, accountInfo, 1024);
      const files = downloadResult.items;

      if (files.length === 0) {
        const result = await retryTgRequest(() => tgClient.sendMessage(fullCaption));
        incrementDailyStat('stories_sent');
        return result;
      }

      const file = files[0];
      const isVideo = file.mime?.startsWith('video/');
      const isImage = file.mime?.startsWith('image/');

      const result = await retryTgRequest(() => tgClient.sendFile(file.path, {
        caption,
        asPhoto: isImage,
        forceDocument: !isImage && !isVideo,
        supportsStreaming: isVideo,
      }));

      if (captionTruncated && story.caption && result?.id) {
        try {
          const identifier = String(story.pk || 'story').replace(/[^a-zA-Z0-9_-]/g, '_');
          await retryTgRequest(() => tgClient.sendTextFile(story.caption, {
            filename: `instagram-story-caption-${identifier}.txt`,
            replyTo: result.id,
            caption: '📄 کپشن کامل و اصلی اینستاگرام',
          }));
        } catch (e) {
          log.error({
            msg: 'Story sent, but full-caption document failed',
            storyPk: story.pk, messageId: result.id, error: e.message,
          });
        }
      }

      incrementDailyStat('stories_sent');
      log.info({
        msg: 'Story sent to Telegram',
        storyPk: story.pk, isVideo, size: formatBytes(file.size),
      });

      return result;
    } finally {
      this.active--;
    }
  }

  async sendAlert(title, details) {
    if (!tgClient.isReady()) return;
    try {
      await tgClient.sendAlert(messageFormatter.formatAlert(title, details));
    } catch (e) {
      log.warn({ msg: 'Failed to send alert', error: e.message });
    }
  }

  async sendDailyStats(stats) {
    if (!tgClient.isReady()) return;
    try {
      await tgClient.sendMessage(messageFormatter.formatDailyStats(stats));
    } catch (e) {
      log.warn({ msg: 'Failed to send daily stats', error: e.message });
    }
  }

  /**
   * اگر ALERT_CHAT_ID ست باشد به آن، وگرنه به کانال اصلی.
   * FIX: قبلاً به‌خاطر نبودِ import config اینجا ReferenceError می‌داد و
   * هیچ گزارش خطایی به تلگرام نمی‌رسید.
   */
  async sendError(error, context = {}) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatError(error, context);
      if (config.telegram.alertChatId) await tgClient.sendAlert(text);
      else await tgClient.sendMessage(text);
    } catch (e) {
      log.warn({ msg: 'Failed to send error report', error: e.message });
    }
  }

  async sendFailureReport(details) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatFailureReport(details);
      if (config.telegram.alertChatId) await tgClient.sendAlert(text);
      else await tgClient.sendMessage(text);
    } catch (e) {
      log.warn({ msg: 'Failed to send failure report', error: e.message });
    }
  }

  async sendText(text) {
    if (!tgClient.isReady()) throw new Error('Telegram client not connected');
    return retryTgRequest(() => tgClient.sendMessage(text));
  }

  getActiveCount() {
    return this.active;
  }
}

const channelSender = new ChannelSender();
export default channelSender;