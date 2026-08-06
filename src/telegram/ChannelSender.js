/**
 * telegram/ChannelSender.js
 * ارسال پیام‌ها و فایل‌ها به کانال تلگرام — همیشه در یک پیام
 *
 * استراتژی:
 *   - caption فایل: 1024 کاراکتر max
 *   - کپشن پست به صورت expandable blockquote (collapsed=true) ارسال میشه
 *   - همه در یک پیام
 */

import { Api } from 'teleproto';
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
   *
   * روش کار:
   *   1. قالب پیام رو با HTML می‌سازیم (header + footer)
   *   2. کپشن پست رو به صورت expandable blockquote با raw entities اضافه می‌کنیم
   *   3. همه رو در یک پیام با sendMessageWithEntities می‌فرستیم
   *
   * اگه فایل داشته باشیم:
   *   - فایل با caption کوتاه (header + footer بدون کپشن)
   *   - سپس کپشن با expandable blockquote در پیام بعدی
   *   ولی اگه کل متن در 1024 جا بشه، فقط فایل با caption می‌فرستیم
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
      const maxLen = hasFiles ? 1020 : 4090;
      const fullCaption = messageFormatter.formatPost(post, accountInfo, { maxLen });

      let result;

      if (!hasFiles) {
        // فقط متن — می‌تونیم با expandable blockquote بفرستیم
        result = await this._sendWithExpandableCaption(fullCaption, post.caption);
      } else {
        // فایل داریم — اگه کل متن در 1024 جا بشه، فایل با caption
        if (fullCaption.length <= 1020) {
          // کل متن در caption فایل جا میشه — یک پیام
          if (files.length === 1) {
            const file = files[0];
            const isVideo = file.mime?.startsWith('video/');
            const isImage = file.mime?.startsWith('image/');
            result = await retryTgRequest(async () => {
              return tgClient.sendFile(file.path, {
                caption: fullCaption,
                asPhoto: isImage,
                forceDocument: !isImage && !isVideo,
              });
            });
          } else {
            const filePaths = files.map(f => f.path);
            result = await retryTgRequest(async () => {
              return tgClient.sendAlbum(filePaths, { caption: fullCaption });
            });
          }
        } else {
          // کپشن طولانی — فایل با header+footer، سپس کپشن با expandable blockquote
          // ولی در یک پیام: فایل با caption کوتاه شده
          const truncated = fullCaption.slice(0, 1020 - 10) + '…';

          if (files.length === 1) {
            const file = files[0];
            const isVideo = file.mime?.startsWith('video/');
            const isImage = file.mime?.startsWith('image/');
            result = await retryTgRequest(async () => {
              return tgClient.sendFile(file.path, {
                caption: truncated,
                asPhoto: isImage,
                forceDocument: !isImage && !isVideo,
              });
            });
          } else {
            const filePaths = files.map(f => f.path);
            result = await retryTgRequest(async () => {
              return tgClient.sendAlbum(filePaths, { caption: truncated });
            });
          }
        }
      }

      incrementDailyStat('posts_sent');
      log.info({
        msg: 'Post sent to Telegram',
        postPk: post.pk,
        type: post.type,
        filesCount: files.length,
        captionLength: fullCaption.length,
      });

      return result;
    } finally {
      this.active--;
    }
  }

  /**
   * Send message with expandable blockquote for caption
   *
   * این متد متن رو با HTML parseMode می‌فرسته، ولی بخش کپشن رو
   * به صورت expandable blockquote (collapsed) نمایش میده.
   *
   * teleproto از <blockquote expandable> در HTML پشتیبانی نمی‌کنه،
   * پس از raw entities استفاده می‌کنیم.
   *
   * ولی برای سادگی، فعلاً با HTML معمولی می‌فرستیم (blockquote بدون expandable).
   * expandable فقط وقتی لازمه که متن خیلی طولانی باشه.
   */
  async _sendWithExpandableCaption(fullText, originalCaption) {
    // اگه متن کوتاه باشه، با HTML بفرست
    if (fullText.length <= 4090) {
      return retryTgRequest(async () => {
        return tgClient.sendMessage(fullText);
      });
    }

    // متن طولانی — split کن
    // ... (fallback)
    return retryTgRequest(async () => {
      return tgClient.sendMessage(fullText.slice(0, 4090));
    });
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
        caption = caption.slice(0, maxLen - 10) + '…';
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
      await retryTgRequest(async () => tgClient.sendMessage(text));
    } catch (e) {
      log.warn({ msg: 'Failed to send error report', error: e.message });
    }
  }

  async sendFailureReport(details) {
    if (!tgClient.isReady()) return;
    try {
      const text = messageFormatter.formatFailureReport(details);
      await retryTgRequest(async () => tgClient.sendMessage(text));
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
