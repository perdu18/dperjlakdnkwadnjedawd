/**
 * config/constants.js
 * ثابت‌های مشترک پروژه
 */

export const IG_ENDPOINTS = {
  BASE: 'https://i.instagram.com/api/v1',
  LOGIN: '/accounts/login/',
  USER_FEED: '/feed/user/{pk}/',
  USER_STORY: '/feed/user/{pk}/story/',
  USER_INFO: '/users/{pk}/info/',
  USERNAME_INFO: '/users/web_profile_info/?username={username}',
  MEDIA_INFO: '/media/{pk}/info/',
};

export const USER_AGENTS = [
  // Android - Instagram Official App
  'Instagram 311.0.0.34.111 Android (33/13; 480dpi; 1080x2400; Xiaomi/redmi; note_10; raphael; qcom; ar_AE; 477182838)',
  'Instagram 311.0.0.34.111 Android (30/11; 440dpi; 1080x2186; Google/Pixel; Pixel 5; redfin; qcom; en_US; 477182838)',
  'Instagram 311.0.0.34.111 Android (31/12; 420dpi; 1080x2260; samsung/SM-G991B; o1s; exynos; en_GB; 477182838)',
  'Instagram 310.0.0.0.111 Android (29/10; 480dpi; 1080x2280; One/One 8 Pro; OP8 Pro; instantnoodle; qcom; en_US; 477182643)',
  'Instagram 309.0.0.0.111 Android (28/9; 440dpi; 1080x2160; Huawei/P30 Pro; HW-02K; hwqc; qcom; en_US; 469182613)',
];

export const DEFAULT_HEADERS = {
  'X-IG-Connection-Type': 'WIFI',
  'X-IG-Capabilities': '3brTvw==',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'X-IG-App-ID': '936619743392459',
};

export const MEDIA_TYPES = {
  IMAGE: 1,
  VIDEO: 2,
  CAROUSEL: 8,
};

export const MEDIA_TYPE_NAMES = {
  1: 'PHOTO',
  2: 'VIDEO',
  8: 'CAROUSEL',
};

export const JOB_TYPES = {
  POST: 'post',
  STORY: 'story',
  REEL: 'reel',
  LIVE: 'live',
};

export const SENT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

export const PROXY_TYPES = {
  HTTP: 'http',
  HTTPS: 'https',
  SOCKS4: 'socks4',
  SOCKS5: 'socks5',
};

/**
 * جستجوی خطا در پاسخ اینستاگرام
 */
export const IG_ERROR_PATTERNS = {
  RATE_LIMIT: /rate limit/i,
  CHALLENGE_REQUIRED: /challenge_required/i,
  LOGIN_REQUIRED: /login_required/i,
  SPAM: /spam/i,
  FEEDBACK_REQUIRED: /feedback_required/i,
  BAD_PASSWORD: /bad_password/i,
  INVALID_USER: /invalid user/i,
  TWO_FACTOR_REQUIRED: /two_factor_required/i,
};

export default {
  IG_ENDPOINTS,
  USER_AGENTS,
  DEFAULT_HEADERS,
  MEDIA_TYPES,
  MEDIA_TYPE_NAMES,
  JOB_TYPES,
  SENT_STATUS,
  PROXY_TYPES,
  IG_ERROR_PATTERNS,
};
