/**
 * telegram/ChannelSender.js
 * ارسال پیام‌ها و فایل‌ها به کانال تلگرام — همیشه در یک پیام
 *
 * محدودیت‌ها:
 *   - caption فایل: 1024 کاراکتر
 *   - پیام متنی: 4096 کاراکتر
 *
 * استراتژی: قالب پیام طوری طراحی شده که همیشه در 1024 جا بشه.
 * اگه کپشن پست طولانی باشه، به‌صورت هوشمند کوتاه میشه.
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
    this.maxConcurrent = 2;
    this.active = 0;
  }

  /**
   * Send a post — همیشه در یک پیام
   */
  async sendPost(post, downloadResult, accountInfo) {
    if (!tgClient.isReady()) {
      throw new Error('Telegram client not connected');
    }

    this.active++;
    try {
      const files = downloadResult.items;
      const hasFiles = files.length > 0;

      // قالب پیام رو بساز
      // اگه فایل داریم: max 1024 chars
      // اگه فقط متن: max 4096 chars
      const maxLen = hasFiles ? 1020 : 4090;
      let caption = messageFormatter.formatPost(post, accountInfo, { maxLen });

      // اطمینان از حد مجاد
      if (caption.length > maxLen) {
        caption = caption.slice(0, maxLen - 20) + '\n\n<i>…</i>';
      }

      let result;

      if (!hasFiles) {
        // فقط متن
        result = await retryTgRequest(async () => {
          return tgClient.sendMessage(caption);
        });
      } else if (files.length === 1) {
        // یک فایل
        const file = files[0];
        const isVideo = file.mime?.startsWith('video/');
        const isImage = file.mime?.startsWith('image/');

        result = await retryTgRequest(async () => {
          return tgClient.sendFile(file.path, {
            caption,
            asPhoto: isImage,
            forceDocument: !isImage && !isVideo,
          });
        });
      } else {
        // آلبوم (carousel)
        const filePaths = files.map(f => f.path);
        result = await retryTgRequest(async () => {
          return tgClient.sendAlbum(filePaths, { caption });
        });
      }

      incrementDailyStat('posts_sent');
      log.info({
        msg: 'Post sent to Telegram',
        postPk: post.pk,
        type: post.type,
        filesCount: files.length,
        captionLength: caption.length,
      });

      return result;
    } finally {
      this.active--;
    }
  }

  /**
   * Send a story
   */
  async sendStory(story, downloadResult, accountInfo) {
    if (!tgClient.isReady()) {
      throw new Error('Telegram client not connected');
    }

    this.active++;
    try {
      const files = downloadResult.items;
      const hasFiles = files.length > 0;
      const maxLen = hasFiles ? 1020 : 4090;
      let caption = messageFormatter.formatStory(story, accountInfo, { maxLen });

      if (caption.length > maxLen) {
        caption = caption.slice(0, maxLen - 20) + '\n\n<i>…</i>';
      }

      let result;

      if (!hasFiles) {
        result = await retryTgRequest(async () => {
          return tgClient.sendMessage(caption);
        });
      } else {
        const file = files[0];
        const isVideo = file.mime?.startsWith('video/');
        const isImage = file.mime?.startsWith('image/');

        result = await retryTgRequest(async () => {
          return tgClient.sendFile(file.path, {
            caption,
            asPhoto: isImage,
            forceDocument: !isImage && !isVideo,
          });
        });
      }

      incrementDailyStat('stories_sent');
      log.info({
        msg: 'Story sent to Telegram',
        storyPk: story.pk,
        captionLength: caption.length,
      });

      return result;
    } finally {
      this.active--;
    }
  }

  /**
   * Send highlight
   */
  async sendHighlight(highlight, accountInfo) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatHighlight(highlight, accountInfo);
      await retryTgRequest(async () => tgClient.sendMessage(text));
      incrementDailyStat('highlights_sent');
    } catch (e) {
      log.warn({ msg: 'Failed to send highlight', error: e.message });
    }
  }

  async sendBanAlert(username, reason) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatBanAlert(username, reason);
      await retryTgRequest(async () => tgClient.sendMessage(text));
    } catch (e) {
      log.warn({ msg: 'Failed to send ban alert', error: e.message });
    }
  }

  async sendDailyStats(stats) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatDailyStats(stats);
      await retryTgRequest(async () => tgClient.sendMessage(text));
    } catch (e) {
      log.warn({ msg: 'Failed to send daily stats', error: e.message });
    }
  }

  async sendError(error, context = {}) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatError(error, context);
      if (config.telegram.alertChatId) {
        await tgClient.sendAlert(text);
      } else {
        await tgClient.sendMessage(text);
      }
    } catch (e) {
      log.warn({ msg: 'Failed to send error report', error: e.message });
    }
  }

  async sendFailureReport(details) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatFailureReport(details);
      if (config.telegram.alertChatId) {
        await tgClient.sendAlert(text);
      } else {
        await tgClient.sendMessage(text);
      }
    } catch (e) {
      log.warn({ msg: 'Failed to send failure report', error: e.message });
    }
  }

  async sendText(text) {
    if (!tgClient.isReady()) {
      throw new Error('Telegram client not connected');
    }
    return retryTgRequest(async () => {
      return tgClient.sendMessage(text);
    });
  }

  getActiveCount() {
    return this.active;
  }
}

const channelSender = new ChannelSender();
export default channelSender;
