/**
 * database/db.js
 * اتصال به SQLite با استفاده از node:sqlite (ماژول داخلی Node.js 22.5+)
 *
 * این ماژول جایگزین better-sqlite3 شده تا نیازی به کامپایل native module نباشه
 * و روی Node.js 22.5+ و 24+ بدون هیچ وابستگی اضافی کار کنه.
 *
 * API مشابه better-sqlite3 است:
 *   db.exec(sql)
 *   db.prepare(sql).run(...params)
 *   db.prepare(sql).get(...params)
 *   db.prepare(sql).all(...params)
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import config from '../config/env.js';
import { dbLogger as log } from '../utils/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

let db = null;

/**
 * Wrapper کوچک برای تطبیق API node:sqlite با better-sqlite3
 *
 * تفاوت‌های اصلی:
 *   1. lastInsertRowid ممکنه BigInt باشه → به Number تبدیل میشه
 *   2. pragma() وجود نداره → از exec('PRAGMA ...') استفاده میشه
 */
class DatabaseAdapter {
  constructor(path, options = {}) {
    // openConnection برای read-write و ایجاد خودکار فایل
    this._db = new DatabaseSync(path);
    this._applyPragmas(options);
  }

  _applyPragmas(options) {
    // Apply default pragmas (matching better-sqlite3 defaults where reasonable)
    // Note: WAL mode significantly improves concurrent performance
    try {
      this._db.exec('PRAGMA journal_mode = WAL');
      this._db.exec('PRAGMA foreign_keys = ON');
      this._db.exec('PRAGMA synchronous = NORMAL');
      this._db.exec('PRAGMA cache_size = -64000'); // 64MB cache
    } catch (e) {
      log.warn({ msg: 'Could not apply pragma', error: e.message });
    }
  }

  /**
   * اجرای SQL بدون خروجی (DDL، چند دستور)
   */
  exec(sql) {
    return this._db.exec(sql);
  }

  /**
   * Prepare یک statement
   * توجه: node:sqlite به‌طور خودکار anonymous params (?) رو می‌شناسه
   */
  prepare(sql) {
    const stmt = this._db.prepare(sql);

    // Wrap run() to convert BigInt lastInsertRowid to Number
    const originalRun = stmt.run.bind(stmt);
    stmt.run = (...args) => {
      const result = originalRun(...args);
      // Convert BigInt to Number (SQLite rowid won't exceed Number.MAX_SAFE_INTEGER in practice)
      const lastInsertRowid = typeof result.lastInsertRowid === 'bigint'
        ? Number(result.lastInsertRowid)
        : result.lastInsertRowid;
      return {
        changes: result.changes,
        lastInsertRowid,
      };
    };

    return stmt;
  }

  /**
   * Convenience: اجرای pragma (compatible with better-sqlite3 API)
   */
  pragma(pragmaStr) {
    return this._db.exec(`PRAGMA ${pragmaStr}`);
  }

  /**
   * Close
   */
  close() {
    return this._db.close();
  }

  /**
   * Direct access to underlying DatabaseSync if needed
   */
  get raw() {
    return this._db;
  }
}

/**
 * مقداردهی اولیه دیتابیس
 */
export const initDb = () => {
  const dbPath = resolve(projectRoot, config.storage.dbPath || './data/app.db');
  const dbDir = dirname(dbPath);

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  log.info({ msg: 'Initializing database (node:sqlite)', path: dbPath });

  try {
    db = new DatabaseAdapter(dbPath);
  } catch (e) {
    log.error({ msg: 'Failed to initialize database', error: e.message });
    throw e;
  }

  runMigrations();

  return db;
};

/**
 * دریافت instance دیتابیس
 */
export const getDb = () => {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
};

/**
 * اجرای migrations
 */
const runMigrations = () => {
  log.info('Running database migrations...');

  // users tracked
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      pk TEXT,
      full_name TEXT,
      profile_pic_url TEXT,
      is_private INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      last_post_pk TEXT,
      last_story_pk TEXT,
      last_post_checked_at INTEGER,
      last_story_checked_at INTEGER,
      last_error TEXT,
      error_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tracked_accounts_active ON tracked_accounts(is_active);
    CREATE INDEX IF NOT EXISTS idx_tracked_accounts_username ON tracked_accounts(username);
  `);

  // sent items log
  db.exec(`
    CREATE TABLE IF NOT EXISTS sent_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracked_account_id INTEGER NOT NULL,
      media_pk TEXT NOT NULL,
      media_id TEXT,
      media_type TEXT NOT NULL,  -- post | story | reel
      shortcode TEXT,
      taken_at INTEGER,
      caption TEXT,
      media_urls TEXT,           -- JSON array of URLs
      tg_message_id INTEGER,
      tg_chat_id TEXT,
      status TEXT DEFAULT 'pending',  -- pending | processing | sent | failed | skipped
      error TEXT,
      retry_count INTEGER DEFAULT 0,
      file_path TEXT,
      file_size INTEGER,
      sent_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (tracked_account_id) REFERENCES tracked_accounts(id) ON DELETE CASCADE,
      UNIQUE(tracked_account_id, media_pk, media_type)
    );

    CREATE INDEX IF NOT EXISTS idx_sent_items_status ON sent_items(status);
    CREATE INDEX IF NOT EXISTS idx_sent_items_account ON sent_items(tracked_account_id);
    CREATE INDEX IF NOT EXISTS idx_sent_items_pk ON sent_items(media_pk);
    CREATE INDEX IF NOT EXISTS idx_sent_items_created ON sent_items(created_at);
  `);

  // proxy cache
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,        -- http | https | socks4 | socks5
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT,
      password TEXT,
      is_working INTEGER DEFAULT 1,
      last_checked_at INTEGER,
      last_used_at INTEGER,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      response_time_ms INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_proxies_working ON proxies(is_working);
    CREATE INDEX IF NOT EXISTS idx_proxies_type ON proxies(type);
  `);

  // app settings (key-value)
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // daily stats
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stat_date TEXT NOT NULL,            -- YYYY-MM-DD
      posts_sent INTEGER DEFAULT 0,
      stories_sent INTEGER DEFAULT 0,
      reels_sent INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      skipped_count INTEGER DEFAULT 0,
      total_download_bytes INTEGER DEFAULT 0,
      UNIQUE(stat_date)
    );
  `);

  // event log
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,    -- login | error | warning | info
      module TEXT,
      message TEXT,
      data TEXT,                   -- JSON
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at);
  `);

  log.info('Migrations completed');
};

/**
 * بستن اتصال دیتابیس
 */
export const closeDb = () => {
  if (db) {
    db.close();
    db = null;
    log.info('Database closed');
  }
};

/**
 * اجرای کوئری با promise wrapper (برای API سازگار با async)
 */
export const runAsync = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    try {
      const stmt = db.prepare(sql);
      const result = stmt.run(...params);
      resolve(result);
    } catch (err) {
      reject(err);
    }
  });
};

/**
 * دریافت یک رکورد
 */
export const getOne = (sql, params = []) => {
  const stmt = db.prepare(sql);
  return stmt.get(...params);
};

/**
 * دریافت چند رکورد
 */
export const getMany = (sql, params = []) => {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
};

/**
 * Log an event to the database
 */
export const logEvent = (eventType, module, message, data = null) => {
  try {
    if (!db) return;
    const stmt = db.prepare(`
      INSERT INTO event_log (event_type, module, message, data)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(eventType, module, message, data ? JSON.stringify(data) : null);
  } catch (e) {
    log.warn({ msg: 'Could not log event', error: e.message });
  }
};

/**
 * ثبت آمار روزانه
 */
export const incrementDailyStat = (field, amount = 1) => {
  try {
    if (!db) return;
    // Whitelist field names to prevent SQL injection
    const allowedFields = ['posts_sent', 'stories_sent', 'reels_sent', 'failed_count', 'skipped_count', 'total_download_bytes'];
    if (!allowedFields.includes(field)) {
      log.warn({ msg: 'Invalid stat field', field });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO daily_stats (stat_date, ${field}) VALUES (?, ?)
      ON CONFLICT(stat_date) DO UPDATE SET ${field} = ${field} + ?
    `).run(today, amount, amount);
  } catch (e) {
    log.warn({ msg: 'Could not increment daily stat', error: e.message });
  }
};

export default {
  initDb,
  getDb,
  closeDb,
  runAsync,
  getOne,
  getMany,
  logEvent,
  incrementDailyStat,
};
