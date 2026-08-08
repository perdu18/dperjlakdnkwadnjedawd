/**
 * config/env.js
 * مدیریت متغیرهای محیطی و اعتبارسنجی آنها
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

// Load .env file
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const get = (key, defaultValue = '') => {
  const value = process.env[key] ?? defaultValue;
  return value.trim();
};

const getInt = (key, defaultValue) => {
  const raw = get(key, '');
  const num = parseInt(raw, 10);
  return isNaN(num) ? defaultValue : num;
};

const getBool = (key, defaultValue = false) => {
  const raw = get(key, '').toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return defaultValue;
};

const getList = (key) => {
  const raw = get(key, '');
  if (!raw) return [];
  return raw.split(',')
    .map(s => s.trim())
    .filter(Boolean);
};

/**
 * تبدیل مسیر نسبی به مطلق
 */
const resolvePath = (p) => {
  if (!p) return '';
  return resolve(p);
};

/**
 * اطمینان از وجود دایرکتوری‌ها
 */
const ensureDirs = (dirs) => {
  for (const dir of dirs) {
    const abs = resolvePath(dir);
    if (!existsSync(abs)) {
      mkdirSync(abs, { recursive: true });
    }
  }
};

const config = {
  // Telegram MTProto
  telegram: {
    apiId: getInt('TG_API_ID', 0),
    apiHash: get('TG_API_HASH'),
    phone: get('TG_PHONE'),
    sessionName: get('TG_SESSION_NAME', 'ig_monitor_session'),
    channelId: get('TG_CHANNEL_ID'),
    channelUsername: get('TG_CHANNEL_USERNAME'),
    sessionDir: get('TG_SESSION_DIR', './data/tg-session'),
    alertChatId: get('ALERT_CHAT_ID'),
    proxy: get('TG_PROXY', ''),
  },

  // Instagram
  instagram: {
    username: get('IG_USERNAME'),
    password: get('IG_PASSWORD'),
    twoFactorCode: get('IG_2FA_CODE'),
    twoFactorSecret: get('IG_2FA_SECRET'),
    sessionDir: get('IG_SESSION_DIR', './data/ig-sessions'),
  },

  // Monitoring
  monitoring: {
    targetAccounts: getList('TARGET_ACCOUNTS'),
    pollIntervalPosts: getInt('POLL_INTERVAL_POSTS', 180),
    pollIntervalStories: getInt('POLL_INTERVAL_STORIES', 240),
    feedFetchLimit: getInt('FEED_FETCH_LIMIT', 12),
    keywordFilter: getList('KEYWORD_FILTER'),
    hashtagFilter: getList('HASHTAG_FILTER'),
  },

  // Proxy
  proxy: {
    mode: get('PROXY_MODE', 'none'), // none | list | static
    listUrlHttp: get('PROXY_LIST_URL_HTTP', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'),
    listUrlSocks: get('PROXY_LIST_URL_SOCKS', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt'),
    listUpdateHours: getInt('PROXY_LIST_UPDATE_HOURS', 3),
    staticUrl: get('PROXY_STATIC_URL'),
    timeout: getInt('PROXY_TIMEOUT', 10000),
    dir: get('PROXY_DIR', './data/proxies'),
  },

  // Storage
  storage: {
    dataDir: get('DATA_DIR', './data'),
    dbPath: get('DB_PATH', './data/app.db'),
    mediaDir: get('MEDIA_DIR', './data/media'),
  },

  // Workers
  workers: {
    maxConcurrentDownloads: getInt('MAX_CONCURRENT_DOWNLOADS', 3),
    maxConcurrentSends: getInt('MAX_CONCURRENT_SENDS', 2),
    downloadTimeout: getInt('DOWNLOAD_TIMEOUT', 60000),
    sendTimeout: getInt('SEND_TIMEOUT', 120000),
  },

  // Anti-detection
  antiDetect: {
    requestDelayMin: getInt('REQUEST_DELAY_MIN', 2000),
    requestDelayMax: getInt('REQUEST_DELAY_MAX', 5000),
    rotateUserAgent: getBool('ROTATE_USER_AGENT', false),
    logoutAfterRequest: getBool('LOGOUT_AFTER_REQUEST', false),
    rateLimitCooldown: getInt('IG_RATE_LIMIT_COOLDOWN', 15 * 60),
    challengeCooldown: getInt('IG_CHALLENGE_COOLDOWN', 60 * 60),
    reconnectInterval: getInt('IG_RECONNECT_INTERVAL', 10 * 60),
    scheduleJitterPercent: getInt('SCHEDULE_JITTER_PERCENT', 15),
  },

  // Logging
  logging: {
    level: get('LOG_LEVEL', 'info'),
    toFile: getBool('LOG_TO_FILE', true),
    file: get('LOG_FILE', './data/app.log'),
  },

  // Misc
  app: {
    env: get('NODE_ENV', 'development'),
    port: getInt('PORT', 3000),
    isProduction: get('NODE_ENV', 'development') === 'production',
    dailyStatsEnabled: getBool('DAILY_STATS_ENABLED', true),
    dailyStatsHour: getInt('DAILY_STATS_HOUR', 9),
    adminIds: getList('ADMIN_IDS'),
    debugApiToken: get('DEBUG_API_TOKEN'),
  },
};

/**
 * اعتبارسنجی متغیرهای ضروری
 */
const validate = () => {
  const errors = [];

  if (!config.telegram.apiId) errors.push('TG_API_ID is required');
  if (!config.telegram.apiHash) errors.push('TG_API_HASH is required');
  if (!config.telegram.phone) errors.push('TG_PHONE is required');
  if (!config.telegram.channelId && !config.telegram.channelUsername) {
    errors.push('TG_CHANNEL_ID or TG_CHANNEL_USERNAME is required');
  }

  if (!config.instagram.username) errors.push('IG_USERNAME is required');

  if (config.monitoring.targetAccounts.length === 0) {
    errors.push('TARGET_ACCOUNTS is required (comma-separated)');
  }

  if (errors.length > 0) {
    console.error('\n❌ Configuration errors:');
    for (const err of errors) {
      console.error(`   - ${err}`);
    }
    console.error('\n💡 Copy .env.example to .env and fill in your values.\n');
    process.exit(1);
  }
};

/**
 * آماده‌سازی دایرکتوری‌های لازم
 */
const init = () => {
  ensureDirs([
    config.storage.dataDir,
    config.storage.mediaDir,
    config.telegram.sessionDir,
    config.instagram.sessionDir,
    config.proxy.dir,
  ]);

  // اگر فایل لاگ فعال است، اطمینان از وجود دایرکتوری
  if (config.logging.toFile) {
    const logDir = dirname(resolvePath(config.logging.file));
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }
};

export default { ...config, validate, init, projectRoot };
export { config, validate, init };
