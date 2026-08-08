/**
 * telegram/ChannelSender.js
 * ارسال پیام‌ها و فایل‌ها به کانال تلگرام
 */

import { resolve } from 'path';
import { tgLogger as log } from '../utils/Logger.js';
import { retryTgRequest } from '../utils/Retry.js';
import { formatBytes } from '../utils/Helpers.js';
import { incrementDailyStat } from '../database/db.js';
import messageFormatter from './MessageFormatter.js';
import tgClient from './TgClient.js';

class ChannelSender {
  constructor() {
    this.maxConcurrent = config_import_maxConcurrentSends();
    this.active = 0;
  }

  /**
   * Send a post (with media)
   */
  async sendPost(post, downloadResult, accountInfo) {
    if (!tgClient.isReady()) {
      throw new Error('Telegram client not connected');
    }

    this.active++;
    try {
      const fullCaption = messageFormatter.formatPost(post, accountInfo);
      const { html: caption, captionTruncated } =
        messageFormatter.formatPostForMedia(post, accountInfo, 1024);
      const files = downloadResult.items;

      let result;

      if (files.length === 0) {
        // No media - just text (can be longer)
        result = await retryTgRequest(async () => {
          return tgClient.sendMessage(fullCaption);
        });
        incrementDailyStat('posts_sent');
        return result;
      }

      if (files.length === 1) {
        // Single media
        const file = files[0];
        const isVideo = file.mime?.startsWith('video/');
        const isImage = file.mime?.startsWith('image/');

        result = await retryTgRequest(async () => {
          return tgClient.sendFile(file.path, {
            caption,
            asPhoto: isImage,
            forceDocument: !isImage && !isVideo,
            supportsStreaming: isVideo,
          });
        });
      } else {
        // Album (carousel)
        const filePaths = files.map(f => f.path);
        result = await tgClient.sendAlbum(filePaths, { caption });
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
            caption: '📄 <b>کپشن کامل و اصلی اینستاگرام</b>',
          }));
          fullCaptionAttached = true;
        } catch (e) {
          // The media post already exists. Do not fail/repost it only because
          // its supplemental caption document exhausted its retries.
          log.error({
            msg: 'Post sent, but full-caption document failed',
            postPk: post.pk,
            messageId: firstMessageId,
            error: e.message,
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


  /**
   * Send a story (with media)
   */
  async sendStory(story, downloadResult, accountInfo) {
    if (!tgClient.isReady()) {
      throw new Error('Telegram client not connected');
    }

    this.active++;
    try {
      const fullCaption = messageFormatter.formatStory(story, accountInfo);
      const { html: caption, captionTruncated } =
        messageFormatter.formatStoryForMedia(story, accountInfo, 1024);
      const files = downloadResult.items;

      if (files.length === 0) {
        // Story with no media? send just text
        const result = await retryTgRequest(async () => {
          return tgClient.sendMessage(fullCaption);
        });
        incrementDailyStat('stories_sent');
        return result;
      }

      const file = files[0];
      const isVideo = file.mime?.startsWith('video/');
      const isImage = file.mime?.startsWith('image/');

      const result = await retryTgRequest(async () => {
        return tgClient.sendFile(file.path, {
          caption,
          asPhoto: isImage,
          forceDocument: !isImage && !isVideo,
          supportsStreaming: isVideo,
        });
      });

      if (captionTruncated && story.caption && result?.id) {
        try {
          const identifier = String(story.pk || 'story').replace(/[^a-zA-Z0-9_-]/g, '_');
          await retryTgRequest(() => tgClient.sendTextFile(story.caption, {
            filename: `instagram-story-caption-${identifier}.txt`,
            replyTo: result.id,
            caption: '📄 <b>کپشن کامل و اصلی اینستاگرام</b>',
          }));
        } catch (e) {
          log.error({
            msg: 'Story sent, but full-caption document failed',
            storyPk: story.pk,
            messageId: result.id,
            error: e.message,
          });
        }
      }

      incrementDailyStat('stories_sent');
      log.info({
        msg: 'Story sent to Telegram',
        storyPk: story.pk,
        isVideo,
        size: formatBytes(file.size),
      });

      return result;
    } finally {
      this.active--;
    }
  }

  /**
   * Send alert message
   */
  async sendAlert(title, details) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatAlert(title, details);
      await tgClient.sendAlert(text);
    } catch (e) {
      log.warn({ msg: 'Failed to send alert', error: e.message });
    }
  }

  /**
   * Send daily stats message
   */
  async sendDailyStats(stats) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatDailyStats(stats);
      await tgClient.sendMessage(text);
    } catch (e) {
      log.warn({ msg: 'Failed to send daily stats', error: e.message });
    }
  }

  /**
   * Send error message
   *
   * اگه ALERT_CHAT_ID تنظیم شده باشه، خطا به اون چت ارسال میشه.
   * در غیر این صورت، به کانال اصلی (TG_CHANNEL_ID) ارسال میشه تا
   * کاربر همیشه از خطاها باخبر بشه.
   */
  async sendError(error, context = {}) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatError(error, context);

      // اگر ALERT_CHAT_ID تنظیم شده، به اون ارسال کن
      if (config.telegram.alertChatId) {
        await tgClient.sendAlert(text);
      } else {
        // در غیر این صورت، به کانال اصلی ارسال کن
        await tgClient.sendMessage(text);
      }
    } catch (e) {
      log.warn({ msg: 'Failed to send error report', error: e.message });
    }
  }

  /**
   * Send detailed failure report for a post/story that failed to send
   *
   * این متد یه گزارش کامل از شکست ارسال یه پست می‌فرسته به تلگرام، شامل:
   * - نوع محتوا (پست/استوری/reel)
   * - اکانت منبع
   * - shortcode و URL
   * - متن خطا
   * - stack trace (اگه موجود باشه)
   * - URLهای مدیا (برای دیباگ)
   */
  async sendFailureReport(details) {
    if (!tgClient.isReady()) return;

    const text = messageFormatter.formatFailureReport(details);

    try {
      if (config.telegram.alertChatId) {
        await tgClient.sendAlert(text);
      } else {
        await tgClient.sendMessage(text);
      }
    } catch (e) {
      log.warn({ msg: 'Failed to send failure report', error: e.message });
    }
  }

  /**
   * Send a plain text message
   */
  async sendText(text) {
    if (!tgClient.isReady()) {
      throw new Error('Telegram client not connected');
    }
    return retryTgRequest(async () => {
      return tgClient.sendMessage(text);
    });
  }

  /**
   * Get active send count
   */
  getActiveCount() {
    return this.active;
  }
}

// Helper to avoid circular imports
function config_import_maxConcurrentSends() {
  // Lazy import to avoid issues
  try {
    // We can't dynamically import in a sync function easily - just default
    return 2;
  } catch {
    return 2;
  }
}

const channelSender = new ChannelSender();
export default channelSender;
