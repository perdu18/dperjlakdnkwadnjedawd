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
import { resolve, join } from 'path';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
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
      const maxLen = hasFiles ? 1020 : 4090;

      // قالب پیام رو بساز — برمی‌گردونه { text, entities }
      const formatted = messageFormatter.formatPost(post, accountInfo, { maxLen });

      let result;

      if (!hasFiles) {
        // فقط متن — با entities
        result = await retryTgRequest(async () => {
          return tgClient.sendMessageWithEntities(formatted.text, formatted.entities);
        });
      } else if (files.length === 1) {
        // یک فایل — با entities به‌عنوان caption
        const file = files[0];
        const isVideo = file.mime?.startsWith('video/');
        const isImage = file.mime?.startsWith('image/');

        result = await retryTgRequest(async () => {
          return tgClient.sendFile(file.path, {
            caption: formatted.text,
            entities: formatted.entities,
            asPhoto: isImage,
            forceDocument: !isImage && !isVideo,
          });
        });
      } else {
        // آلبوم — teleproto از formattingEntities در album پشتیبانی می‌کنه
        const filePaths = files.map(f => f.path);
        result = await retryTgRequest(async () => {
          return tgClient.sendAlbum(filePaths, {
            caption: formatted.text,
            entities: formatted.entities,
          });
        });
      }

      incrementDailyStat('posts_sent');
      log.info({
        msg: 'Post sent to Telegram',
        postPk: post.pk,
        type: post.type,
        filesCount: files.length,
        captionLength: formatted.text.length,
        entitiesCount: formatted.entities.length,
        hasTxtAttachment: !!formatted.fullCaptionText,
      });

      // اگه کپشن طولانی بوده، فایل txt پیوست کن
      if (formatted.fullCaptionText) {
        try {
          await this._sendCaptionTxt(formatted.fullCaptionText, post.shortcode);
        } catch (e) {
          log.warn({ msg: 'Could not send caption txt file', error: e.message });
        }
      }

      return result;
    } finally {
      this.active--;
    }
  }

  /**
   * Send caption as txt file (برای کپشن‌های طولانی)
   */
  async _sendCaptionTxt(captionText, shortcode) {
    const mediaDir = resolve(process.cwd(), 'data', 'media');
    mkdirSync(mediaDir, { recursive: true });

    const filename = `caption_${shortcode || 'post'}_${Date.now()}.txt`;
    const filePath = join(mediaDir, filename);

    writeFileSync(filePath, captionText, 'utf8');

    try {
      await retryTgRequest(async () => {
        return tgClient.sendFile(filePath, {
          caption: '📎 کپشن کامل پست',
          forceDocument: true,
        });
      });
      log.info({ msg: 'Caption txt sent', filename, size: captionText.length });
    } finally {
      // حذف فایل موقت
      try { unlinkSync(filePath); } catch {}
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
