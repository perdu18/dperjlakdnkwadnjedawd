/**
 * database/TrackedAccountsRepository.js
 * Repository برای کار با اکانت‌های مانیتور شده
 */

import { getDb, getOne, getMany } from './db.js';

export const TrackedAccountsRepository = {
  /**
   * افزودن اکانت جدید
   */
  add(username, extra = {}) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO tracked_accounts (username, pk, full_name, profile_pic_url, is_private, is_verified, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(username) DO UPDATE SET
        pk = COALESCE(excluded.pk, tracked_accounts.pk),
        full_name = COALESCE(excluded.full_name, tracked_accounts.full_name),
        profile_pic_url = COALESCE(excluded.profile_pic_url, tracked_accounts.profile_pic_url),
        is_private = COALESCE(excluded.is_private, tracked_accounts.is_private),
        is_verified = COALESCE(excluded.is_verified, tracked_accounts.is_verified),
        updated_at = strftime('%s','now')
    `);
    return stmt.run(
      username.toLowerCase(),
      extra.pk || null,
      extra.fullName || null,
      extra.profilePicUrl || null,
      extra.isPrivate ? 1 : 0,
      extra.isVerified ? 1 : 0
    );
  },

  /**
   * حذف اکانت
   */
  remove(username) {
    const db = getDb();
    return db.prepare('DELETE FROM tracked_accounts WHERE username = ?').run(username.toLowerCase());
  },

  /**
   * فعال/غیرفعال کردن اکانت
   */
  setActive(username, isActive) {
    const db = getDb();
    return db.prepare(`
      UPDATE tracked_accounts
      SET is_active = ?, updated_at = strftime('%s','now')
      WHERE username = ?
    `).run(isActive ? 1 : 0, username.toLowerCase());
  },

  /**
   * دریافت اکانت بر اساس username
   */
  getByUsername(username) {
    return getOne('SELECT * FROM tracked_accounts WHERE username = ?', [username.toLowerCase()]);
  },

  /**
   * دریافت اکانت بر اساس pk
   */
  getByPk(pk) {
    return getOne('SELECT * FROM tracked_accounts WHERE pk = ?', [pk]);
  },

  /**
   * دریافت همه اکانت‌های فعال
   */
  getAllActive() {
    return getMany('SELECT * FROM tracked_accounts WHERE is_active = 1 ORDER BY id');
  },

  /**
   * دریافت همه اکانت‌ها
   */
  getAll() {
    return getMany('SELECT * FROM tracked_accounts ORDER BY id');
  },

  /**
   * آپدیت PK اکانت (پس از fetch info)
   */
  updatePk(username, pk) {
    const db = getDb();
    return db.prepare(`
      UPDATE tracked_accounts SET pk = ?, updated_at = strftime('%s','now') WHERE username = ?
    `).run(pk, username.toLowerCase());
  },

  /**
   * آپدیت آخرین پست دیده شده
   */
  updateLastPost(username, lastPostPk) {
    const db = getDb();
    return db.prepare(`
      UPDATE tracked_accounts
      SET last_post_pk = ?, last_post_checked_at = strftime('%s','now'), updated_at = strftime('%s','now')
      WHERE username = ?
    `).run(lastPostPk, username.toLowerCase());
  },

  /**
   * آپدیت آخرین استوری دیده شده
   */
  updateLastStory(username, lastStoryPk) {
    const db = getDb();
    return db.prepare(`
      UPDATE tracked_accounts
      SET last_story_pk = ?, last_story_checked_at = strftime('%s','now'), updated_at = strftime('%s','now')
      WHERE username = ?
    `).run(lastStoryPk, username.toLowerCase());
  },

  /**
   * ثبت خطا برای اکانت
   */
  recordError(username, error) {
    const db = getDb();
    return db.prepare(`
      UPDATE tracked_accounts
      SET last_error = ?, error_count = error_count + 1, updated_at = strftime('%s','now')
      WHERE username = ?
    `).run(error?.slice(0, 500) || 'Unknown error', username.toLowerCase());
  },

  /**
   * ریست خطاها
   */
  resetErrors(username) {
    const db = getDb();
    return db.prepare(`
      UPDATE tracked_accounts
      SET last_error = NULL, error_count = 0, updated_at = strftime('%s','now')
      WHERE username = ?
    `).run(username.toLowerCase());
  },

  /**
   * آپدیت اطلاعات پروفایل
   */
  updateProfile(username, info) {
    const db = getDb();
    return db.prepare(`
      UPDATE tracked_accounts
      SET pk = ?, full_name = ?, profile_pic_url = ?, is_private = ?, is_verified = ?,
          updated_at = strftime('%s','now')
      WHERE username = ?
    `).run(
      info.pk,
      info.fullName || null,
      info.profilePicUrl || null,
      info.isPrivate ? 1 : 0,
      info.isVerified ? 1 : 0,
      username.toLowerCase()
    );
  },

  /**
   * تعداد اکانت‌های فعال
   */
  countActive() {
    return getOne('SELECT COUNT(*) as count FROM tracked_accounts WHERE is_active = 1')?.count || 0;
  },
};

export default TrackedAccountsRepository;
