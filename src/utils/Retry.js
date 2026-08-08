/**
 * utils/Retry.js
 * منطق retry با exponential backoff + پشتیبانی رسمی از FLOOD_WAIT تلگرام
 */

import pRetry, { AbortError } from 'p-retry';
import { appLogger as log } from './Logger.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * طبق core.telegram.org، سرور در خطای FLOOD_WAIT_X دقیقاً می‌گوید چند ثانیه
 * باید صبر کنیم. backoff نمایی اینجا اشتباه است و فقط flood را طولانی‌تر می‌کند.
 */
export const getFloodWaitSeconds = (err) => {
  if (!err) return 0;
  if (Number.isFinite(err.seconds)) return Number(err.seconds);
  const msg = String(err.errorMessage || err.message || '');
  const m = msg.match(/FLOOD(?:_PREMIUM)?_WAIT_(\d+)/i) || msg.match(/SLOWMODE_WAIT_(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
};

// خطاهای RPC که retry آن‌ها بی‌فایده یا خطرناک (ایجاد پیام تکراری) است
const TG_FATAL_ERRORS = [
  'auth_key', 'session_revoked', 'session revoked', 'user_deactivated',
  'chat_write_forbidden', 'channel_private', 'channel_invalid',
  'peer_id_invalid', 'message_too_long', 'media_empty', 'photo_invalid_dimensions',
  'media_caption_too_long', 'input_user_deactivated', 'chat_admin_required',
  'file_parts_invalid', 'entity_bounds_invalid', 'message_empty',
];

export const retry = async (fn, options = {}) => {
  const {
    retries = 3, minTimeout = 1000, maxTimeout = 10000, factor = 2,
    onFailedAttempt, shouldRetry,
  } = options;

  return pRetry(async (attemptCount) => {
    try {
      return await fn(attemptCount);
    } catch (err) {
      if (shouldRetry && !shouldRetry(err)) throw new AbortError(err);
      throw err;
    }
  }, {
    retries, minTimeout, maxTimeout, factor,
    onFailedAttempt: async (error) => {
      log.warn({
        msg: 'Retry attempt failed',
        attempt: error.attemptNumber,
        retriesLeft: error.retriesLeft,
        message: error.message,
      });
      if (onFailedAttempt) await onFailedAttempt(error);
    },
  });
};

export const retryIgRequest = async (fn, options = {}) => {
  return retry(fn, {
    retries: 3, minTimeout: 2000, maxTimeout: 15000, factor: 2,
    shouldRetry: (err) => {
      const msg = (err.message || '').toLowerCase();
      if (err?.name === 'InstagramCooldownError') return false;
      if (err?.name === 'InstagramAuthError') return false;
      if (msg.includes('bad_password')) return false;
      if (msg.includes('invalid user')) return false;
      if (msg.includes('two_factor')) return false;
      if (msg.includes('challenge_required')) return false;
      if (msg.includes('checkpoint_required')) return false;
      if (msg.includes('login_required')) return false;
      if (msg.includes('(429')) return false;   // cooldown مدیریتش را انجام می‌دهد
      return true;
    },
    ...options,
  });
};

export const retryTgRequest = async (fn, options = {}) => {
  return retry(fn, {
    retries: 5, minTimeout: 1000, maxTimeout: 30000, factor: 2,
    onFailedAttempt: async (error) => {
      // انتظار دقیقاً به اندازه‌ای که خود تلگرام اعلام کرده
      const waitSeconds = getFloodWaitSeconds(error);
      if (waitSeconds > 0) {
        log.warn({ msg: 'Telegram FLOOD_WAIT — sleeping exactly as instructed', waitSeconds });
        await sleep((waitSeconds + 1) * 1000);
      }
    },
    shouldRetry: (err) => {
      const msg = String(err.errorMessage || err.message || '').toLowerCase();
      if (TG_FATAL_ERRORS.some(code => msg.includes(code))) return false;
      // FLOOD_WAIT های خیلی طولانی را retry نمی‌کنیم (بیش از ۱۰ دقیقه)
      const waitSeconds = getFloodWaitSeconds(err);
      if (waitSeconds > 600) return false;
      return true;
    },
    ...options,
  });
};

export default { retry, retryIgRequest, retryTgRequest, getFloodWaitSeconds };