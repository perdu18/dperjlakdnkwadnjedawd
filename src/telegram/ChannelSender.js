/**
 * telegram/ChannelSender.js
 * ارسال پیام‌ها و فایل‌ها به کانال تلگرام
 */

import { resolve } from 'path';
import { tgLogger as log } from '../utils/Logger.js';
import { retryTgRequest } from '../utils/Retry.js';
import { formatBytes, truncate } from '../utils/Helpers.js';
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
      const files = downloadResult.items;

      // استراتژی برای کپشن‌های طولانی (طبق مستندات تلگرام core.telegram.org):
      // - محدودیت caption فایل: 1024 کاراکتر
      // - محدودیت پیام متنی: 4096 کاراکتر
      //
      // اگه کپشن طولانی‌تر از 1024 باشه و فایل داشته باشیم:
      // ۱. فایل رو با یه caption کوتاه (header + آمار) می‌فرستیم
      // ۲. بقیه متن (کپشن کامل + جزئیات) رو به‌عنوان پیام جداگانه می‌فرستیم

      let fileCaption = fullCaption;
      let extraTextMessage = null;

      if (fullCaption.length > 1024 && files.length > 0) {
        // Split: فایل با header + آمار، پیام متنی با کپشن + جزئیات
        const lines = fullCaption.split('\n');
        const headerLines = [];
        const restLines = [];

        let inHeader = true;
        for (const line of lines) {
          if (inHeader) {
            headerLines.push(line);
            if (line.includes('</blockquote>') && headerLines.length > 2) {
              inHeader = false;
              continue;
            }
          } else {
            restLines.push(line);
          }
        }

        fileCaption = headerLines.join('\n').slice(0, 1024);
        extraTextMessage = restLines.join('\n').slice(0, 4096);
      } else if (fullCaption.length > 4096) {
        fileCaption = this._smartTruncateCaption(fullCaption, 4096);
      }

      let result;

      if (files.length === 0) {
        // No media - just text (can be up to 4096)
        result = await retryTgRequest(async () => {
          return tgClient.sendMessage(fileCaption);
        });
      } else if (files.length === 1) {
        const file = files[0];
        const isVideo = file.mime?.startsWith('video/');
        const isImage = file.mime?.startsWith('image/');

        result = await retryTgRequest(async () => {
          return tgClient.sendFile(file.path, {
            caption: fileCaption,
            asPhoto: isImage,
            forceDocument: !isImage && !isVideo,
          });
        });
      } else {
        const filePaths = files.map(f => f.path);
        result = await retryTgRequest(async () => {
          return tgClient.sendAlbum(filePaths, {
            caption: fileCaption,
          });
        });
      }

      // اگه کپشن طولانی بود، بقیه متن رو به‌عنوان پیام جداگانه بفرست
      if (extraTextMessage) {
        try {
          await retryTgRequest(async () => {
            return tgClient.sendMessage(extraTextMessage);
          });
        } catch (e) {
          log.warn({ msg: 'Could not send extra text message', error: e.message });
        }
      }

      incrementDailyStat('posts_sent');
      log.info({
        msg: 'Post sent to Telegram',
        postPk: post.pk,
        type: post.type,
        filesCount: files.length,
        totalSize: formatBytes(files.reduce((s, f) => s + (f.size || 0), 0)),
        captionLength: fileCaption.length,
        hasExtraText: !!extraTextMessage,
        extraTextLength: extraTextMessage?.length || 0,
      });

      return result;
    } finally {
      this.active--;
    }
  }

  /**
   * Smart truncate caption to fit Telegram's 1024 char limit
   * حفظ کردن بخش‌های مهم: header, آمار اکانت, لینک، زمان، footer
   */
  _smartTruncateCaption(fullCaption, maxLength = 1024) {
    if (fullCaption.length <= maxLength) return fullCaption;

    const lines = fullCaption.split('\n');
    const result = [];

    // همیشه header (خط اول) و footer (خط آخر) رو نگه دار
    // و بخش‌های مهم (🔗, 🕐, 📊, 📈) رو حفظ کن
    const importantKeywords = ['━━━', '👤', '📊', '🔗', '🕐', '🤖', '📈', '🎵', '📍'];

    for (const line of lines) {
      const isImportant = importantKeywords.some(kw => line.includes(kw));
      const currentLength = result.join('\n').length;

      if (isImportant) {
        // همیشه اضافه کن
        result.push(line);
      } else if (currentLength + line.length + 1 < maxLength - 100) {
        // اضافه کن اگه جا داره
        result.push(line);
      }
      // اگه جا نداره، skip کن
    }

    let truncated = result.join('\n');
    if (truncated.length > maxLength) {
      truncated = truncated.slice(0, maxLength - 10) + '...';
    }

    return truncated;
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
      const caption = messageFormatter.formatStory(story, accountInfo);
      const files = downloadResult.items;

      if (files.length === 0) {
        // Story with no media? send just text
        const result = await retryTgRequest(async () => {
          return tgClient.sendMessage(caption);
        });
        incrementDailyStat('stories_sent');
        return result;
      }

      const file = files[0];
      const isVideo = file.mime?.startsWith('video/');
      const isImage = file.mime?.startsWith('image/');

      // Story captions must be short (1024 max)
      const truncatedCaption = truncate(caption, 1024);

      const result = await retryTgRequest(async () => {
        return tgClient.sendFile(file.path, {
          caption: truncatedCaption,
          asPhoto: isImage,
          forceDocument: !isImage && !isVideo,
        });
      });

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
