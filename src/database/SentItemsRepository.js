/**
 * database/SentItemsRepository.js
 * Repository برای ردیابی آیتم‌های ارسال شده (جلوگیری از duplicate)
 */

import { getDb, getOne, getMany } from './db.js';

export const SentItemsRepository = {
  /**
   * ثبت آیتم جدید
   */
  create(data) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO sent_items
        (tracked_account_id, media_pk, media_id, media_type, shortcode, taken_at,
         caption, media_urls, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    return stmt.run(
      data.trackedAccountId,
      data.mediaPk,
      data.mediaId || null,
      data.mediaType,
      data.shortcode || null,
      data.takenAt || null,
      data.caption || null,
      data.mediaUrls ? JSON.stringify(data.mediaUrls) : null
    );
  },

  /**
   * بررسی آیا قبلاً ارسال شده
   */
  exists(trackedAccountId, mediaPk, mediaType) {
    const canonicalPk = String(mediaPk).split('_')[0];
    const postTypes = mediaType === 'post' || mediaType === 'reel';
    const typeClause = postTypes
      ? "media_type IN ('post', 'reel')"
      : 'media_type = ?';
    const params = [trackedAccountId, canonicalPk, canonicalPk];
    if (!postTypes) params.push(mediaType);

    return getOne(
      `SELECT id, status FROM sent_items
       WHERE tracked_account_id = ?
         AND (media_pk = ? OR substr(media_pk, 1, instr(media_pk, '_') - 1) = ?)
         AND ${typeClause}`,
      params
    );
  },

  /**
   * آپدیت وضعیت
   */
  updateStatus(id, status, extra = {}) {
    const db = getDb();
    const fields = ['status = ?'];
    const params = [status];

    if (extra.tgMessageId !== undefined) {
      fields.push('tg_message_id = ?');
      params.push(extra.tgMessageId);
    }
    if (extra.tgChatId !== undefined) {
      fields.push('tg_chat_id = ?');
      params.push(extra.tgChatId);
    }
    if (extra.error !== undefined) {
      fields.push('error = ?');
      params.push(extra.error);
    }
    if (extra.filePath !== undefined) {
      fields.push('file_path = ?');
      params.push(extra.filePath);
    }
    if (extra.fileSize !== undefined) {
      fields.push('file_size = ?');
      params.push(extra.fileSize);
    }
    if (status === 'sent') {
      fields.push('sent_at = strftime(\'%s\',\'now\')');
    }
    if (status === 'failed') {
      fields.push('retry_count = retry_count + 1');
    }

    params.push(id);
    db.prepare(`UPDATE sent_items SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  },

  /**
   * دریافت آیتم‌های در انتظار ارسال
   */
  getPending(limit = 10) {
    return getMany(
      `SELECT s.*, t.username as account_username
       FROM sent_items s
       JOIN tracked_accounts t ON s.tracked_account_id = t.id
       WHERE s.status = 'pending'
       ORDER BY s.created_at ASC
       LIMIT ?`,
      [limit]
    );
  },

  /**
   * دریافت آیتم‌های ناموفق برای retry
   */
  getFailed(limit = 5, maxRetries = 3) {
    return getMany(
      `SELECT s.*, t.username as account_username
       FROM sent_items s
       JOIN tracked_accounts t ON s.tracked_account_id = t.id
       WHERE s.status = 'failed' AND s.retry_count < ?
       ORDER BY s.created_at ASC
       LIMIT ?`,
      [maxRetries, limit]
    );
  },

  /**
   * دریافت آمار روزانه
   */
  getTodayStats() {
    const today = new Date().toISOString().slice(0, 10);
    const startTs = Math.floor(new Date(today).getTime() / 1000);
    const endTs = startTs + 86400;

    return getOne(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
         SUM(CASE WHEN media_type = 'post' THEN 1 ELSE 0 END) as posts,
         SUM(CASE WHEN media_type = 'story' THEN 1 ELSE 0 END) as stories,
         SUM(CASE WHEN media_type = 'reel' THEN 1 ELSE 0 END) as reels
       FROM sent_items
       WHERE created_at >= ? AND created_at < ?`,
      [startTs, endTs]
    );
  },

  /**
   * دریافت آخرین آیتم‌های ارسال شده
   */
  getRecent(limit = 20) {
    return getMany(
      `SELECT s.*, t.username as account_username
       FROM sent_items s
       JOIN tracked_accounts t ON s.tracked_account_id = t.id
       ORDER BY s.created_at DESC
       LIMIT ?`,
      [limit]
    );
  },

  /**
   * حذف رکوردهای قدیمی‌تر از N روز
   */
  cleanupOld(days = 30) {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
    return db.prepare('DELETE FROM sent_items WHERE created_at < ? AND status = ?', [cutoff, 'sent']).run();
  },

  /**
   * حذف همه آیتم‌های failed یا pending
   * (برای پاکسازی آیتم‌های قدیمی که با کد قدیمی ساخته شدن)
   */
  cleanupFailed() {
    const db = getDb();
    const result = db.prepare(`
      DELETE FROM sent_items WHERE status IN ('failed', 'pending')
    `).run();
    return {
      deleted: result.changes,
    };
  },

  /**
   * ریست last_post_pk و last_story_pk برای همه اکانت‌ها
   * (مجبور کردن ربات به fetch مجدد همه پست‌ها)
   */
  resetAllLastPostPks() {
    const db = getDb();
    return db.prepare(`
      UPDATE tracked_accounts
      SET last_post_pk = NULL, last_story_pk = NULL,
          last_post_checked_at = NULL, last_story_checked_at = NULL,
          updated_at = strftime('%s','now')
    `).run();
  },

  /**
   * ریست last_post_pk برای یک اکانت خاص
   */
  resetLastPostPk(username) {
    const db = getDb();
    return db.prepare(`
      UPDATE tracked_accounts
      SET last_post_pk = NULL, last_story_pk = NULL,
          last_post_checked_at = NULL, last_story_checked_at = NULL,
          updated_at = strftime('%s','now')
      WHERE username = ?
    `).run(username.toLowerCase());
  },
};

export default SentItemsRepository;
