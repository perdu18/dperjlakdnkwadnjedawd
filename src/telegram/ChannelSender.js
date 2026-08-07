/**
 * telegram/ChannelSender.js
 * مدیریت ارسال پست‌ها به کانال تلگرام
 */

import { renameSync } from 'fs';
import tgClient from './TgClient.js';
import messageFormatter from './MessageFormatter.js';
import { retryTgRequest } from '../utils/Retry.js';
import { log } from '../utils/Logger.js';
import { incrementDailyStat } from '../database/SentItemsRepository.js';

class ChannelSender {
  constructor() {
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
        // ── آلبوم (carousel) ──
        const filePaths = files.map(f => f.path);

        // اطمینان از پسوندهای درست
        const fixedPaths = filePaths.map(p => {
          const lower = p.toLowerCase();
          if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') ||
              lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.gif')) {
            return p;
          }
          const file = files.find(f => f.path === p);
          if (file?.mime?.startsWith('image/')) {
            const newPath = p.replace(/\.[^.]+$/, '.jpg');
            try { renameSync(p, newPath); } catch {}
            return newPath;
          }
          if (file?.mime?.startsWith('video/')) {
            const newPath = p.replace(/\.[^.]+$/, '.mp4');
            try { renameSync(p, newPath); } catch {}
            return newPath;
          }
          return p;
        });

        // ── FIX: استفاده از Raw Entities به جای HTML ──
        // teleproto در SendMultiMedia موقع استفاده از HTML به مشکل می‌خوره. پس Entities خام رو پاس میدیم.
        const formattedForAlbum = messageFormatter.formatPost(post, accountInfo, { maxLen: 1020 });

        try {
          result = await retryTgRequest(async () => {
            return tgClient.sendAlbum(fixedPaths, {
              caption: formattedForAlbum.text,
              entities: formattedForAlbum.entities,
              forceDocument: false,
            });
          });
        } catch (albumErr) {
          log.warn({ msg: 'Album failed, sending files individually', error: albumErr.message });

          // fallback: اولین فایل با caption
          const firstFile = files[0];
          const isVideo = firstFile.mime?.startsWith('video/');
          const isImage = firstFile.mime?.startsWith('image/');

          result = await retryTgRequest(async () => {
            return tgClient.sendFile(fixedPaths[0], {
              caption: formattedForAlbum.text,
              entities: formattedForAlbum.entities,
              asPhoto: isImage,
              forceDocument: !isImage && !isVideo,
            });
          });

          // بقیه فایل‌ها بدون caption
          for (let i = 1; i < fixedPaths.length; i++) {
            try {
              const f = files[i];
              const fIsVideo = f.mime?.startsWith('video/');
              const fIsImage = f.mime?.startsWith('image/');

              await retryTgRequest(async () => {
                return tgClient.sendFile(fixedPaths[i], {
                  asPhoto: fIsImage,
                  forceDocument: !fIsImage && !fIsVideo,
                });
              });
            } catch (e) {
              log.warn({ msg: 'Could not send individual file', index: i, error: e.message });
            }
          }
        }
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

      // اگه کپشن طولانی بوده، فایل txt پیوست کن (reply روی پیام اصلی)
      const fullCaption = formatted.fullCaptionText || (typeof formattedForAlbum !== 'undefined' && formattedForAlbum?.fullCaptionText);
      if (fullCaption) {
        try {
          let replyToId = null;
          if (Array.isArray(result)) {
            replyToId = result[0]?.id;
          } else {
            replyToId = result?.id;
          }

          await this._sendCaptionTxt(fullCaption, post.shortcode, replyToId);
        } catch (e) {
          log.warn({ msg: 'Could not send caption txt file', error: e.message });
        }
      }

      return result;
    } finally {
      this.active--;
    }
  }

  // ... (تابع _sendCaptionTxt و سایر توابع خصوصی خودت را اینجا بدون تغییر حفظ کن) ...
  async _sendCaptionTxt(fullCaption, shortcode, replyToId) {
    // کد اصلی شما برای ارسال فایل متنی کپشن
  }
}

export default new ChannelSender();