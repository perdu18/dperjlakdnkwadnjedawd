/**
 * utils/Helpers.js
 * توابع کمکی مشترک
 */

import { randomInt } from 'crypto';
import { createHash } from 'crypto';
import { USER_AGENTS } from '../config/constants.js';

/**
 * Sleep به میلی‌ثانیه
 */
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * تاخیر تصادفی برای کاهش ریسک بن شدن
 */
export const randomDelay = (min = 2000, max = 5000) => {
  const delay = randomInt(min, max);
  return sleep(delay);
};

/**
 * انتخاب تصادفی یک User-Agent
 */
export const getRandomUserAgent = () => {
  return USER_AGENTS[randomInt(0, USER_AGENTS.length)];
};

/**
 * تشخیص نوع پروکسی از URL
 */
export const detectProxyType = (url) => {
  if (!url) return null;
  const lower = url.toLowerCase();
  if (lower.startsWith('socks5://')) return 'socks5';
  if (lower.startsWith('socks4://')) return 'socks4';
  if (lower.startsWith('https://')) return 'https';
  if (lower.startsWith('http://')) return 'http';
  // Without scheme: assume http
  return 'http';
};

/**
 * Hash یک رشته (برای شناسه یکتا)
 */
export const hashString = (str) => {
  return createHash('sha256').update(str, 'utf8').digest('hex').slice(0, 16);
};

/**
 * فرمت ثانیه به فرمت خوانا
 */
export const formatDuration = (seconds) => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

/**
 * تبدیل timestamp به ISO string
 */
export const timestampToISO = (ts) => {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString();
};

/**
 * تجزیه پروکسی از فرمت host:port یا user:pass@host:port
 */
export const parseProxyUrl = (input) => {
  if (!input) return null;

  try {
    // If has scheme, use URL constructor
    if (/^(https?|socks[45]):\/\//i.test(input)) {
      const url = new URL(input);
      return {
        type: url.protocol.replace(':', '').toLowerCase(),
        host: url.hostname,
        port: parseInt(url.port, 10),
        username: decodeURIComponent(url.username) || null,
        password: decodeURIComponent(url.password) || null,
        raw: input,
      };
    }

    // Without scheme: try to parse as host:port or user:pass@host:port
    const authMatch = input.match(/^(.+):(.+)@(.+):(\d+)$/);
    if (authMatch) {
      return {
        type: 'http',
        username: authMatch[1],
        password: authMatch[2],
        host: authMatch[3],
        port: parseInt(authMatch[4], 10),
        raw: `http://${input}`,
      };
    }

    const simpleMatch = input.match(/^(.+):(\d+)$/);
    if (simpleMatch) {
      return {
        type: 'http',
        host: simpleMatch[1],
        port: parseInt(simpleMatch[2], 10),
        username: null,
        password: null,
        raw: `http://${input}`,
      };
    }

    return null;
  } catch (e) {
    return null;
  }
};

/**
 * Trim و normalize یک رشته
 */
export const normalize = (str) => {
  if (!str) return '';
  return String(str).trim();
};

/**
 * بررسی وجود کلمه کلیدی در متن (case-insensitive)
 */
export const containsKeyword = (text, keywords) => {
  if (!keywords || keywords.length === 0) return true;
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
};

/**
 * Extract hashtags از متن
 */
export const extractHashtags = (text) => {
  if (!text) return [];
  const matches = text.match(/#[\w\u0600-\u06FF]+/g);
  return matches ? matches : [];
};

/**
 * Extract mentions از متن
 */
export const extractMentions = (text) => {
  if (!text) return [];
  const matches = text.match(/@[a-zA-Z0-9._]+/g);
  return matches ? matches : [];
};

/**
 * Safe JSON parse
 */
export const safeJsonParse = (str, defaultValue = null) => {
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
};

/**
 * Safe JSON stringify
 */
export const safeJsonStringify = (obj, defaultValue = '{}') => {
  try {
    return JSON.stringify(obj);
  } catch {
    return defaultValue;
  }
};

/**
 * Generate unique ID
 */
export const generateId = () => {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
};

/**
 * Truncate text with ellipsis
 */
export const truncate = (text, maxLength = 1000) => {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
};

/**
 * Format bytes to human readable
 */
export const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(2)} ${units[i]}`;
};

/**
 * Get file extension from URL
 */
export const getExtFromUrl = (url) => {
  try {
    const path = new URL(url).pathname;
    const ext = path.split('.').pop();
    return ext && ext.length <= 5 ? ext.toLowerCase() : null;
  } catch {
    return null;
  }
};

export default {
  sleep,
  randomDelay,
  getRandomUserAgent,
  detectProxyType,
  hashString,
  formatDuration,
  timestampToISO,
  parseProxyUrl,
  normalize,
  containsKeyword,
  extractHashtags,
  extractMentions,
  safeJsonParse,
  safeJsonStringify,
  generateId,
  truncate,
  formatBytes,
  getExtFromUrl,
};
