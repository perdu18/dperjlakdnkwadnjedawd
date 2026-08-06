/**
 * utils/Retry.js
 * منطق retry با exponential backoff
 */

import pRetry from 'p-retry';
import { appLogger as log } from './Logger.js';

/**
 * Retry یک تابع async با exponential backoff
 * @param {Function} fn - تابعی که باید retry شود (به p-retry منتقل میشه)
 * @param {Object} options - تنظیمات
 *   - retries: تعداد دفعات retry (default: 3)
 *   - minTimeout: حداقل فاصله (default: 1000ms)
 *   - maxTimeout: حداکثر فاصله (default: 10000ms)
 *   - factor: ضریب افزایش (default: 2)
 *   - onFailedAttempt: callback بعد از هر شکست
 *   - shouldRetry: تابع تشخیص اینکه آیا باید retry شود
 */
export const retry = async (fn, options = {}) => {
  const {
    retries = 3,
    minTimeout = 1000,
    maxTimeout = 10000,
    factor = 2,
    onFailedAttempt,
    shouldRetry,
  } = options;

  return pRetry(async (attemptCount) => {
    try {
      return await fn(attemptCount);
    } catch (err) {
      if (shouldRetry && !shouldRetry(err)) {
        // Don't retry, throw immediately
        throw new pRetry.AbortError(err);
      }
      throw err;
    }
  }, {
    retries,
    minTimeout,
    maxTimeout,
    factor,
    onFailedAttempt: (error) => {
      log.warn({
        msg: 'Retry attempt failed',
        attempt: error.attemptNumber,
        retriesLeft: error.retriesLeft,
        message: error.message,
      });
      if (onFailedAttempt) onFailedAttempt(error);
    },
  });
};

/**
 * Retry مخصوص درخواست‌های Instagram
 * به‌صورت هوشمند خطاهای غیر قابل retry رو تشخیص میده
 */
export const retryIgRequest = async (fn, options = {}) => {
  return retry(fn, {
    retries: 3,
    minTimeout: 2000,
    maxTimeout: 15000,
    factor: 2,
    shouldRetry: (err) => {
      const msg = (err.message || '').toLowerCase();

      // Don't retry on auth errors
      if (msg.includes('bad_password')) return false;
      if (msg.includes('invalid user')) return false;
      if (msg.includes('two_factor')) return false;

      // Don't retry on challenge_required (needs manual handling)
      if (msg.includes('challenge_required')) return false;

      // Retry on network / rate limit / 5xx
      if (msg.includes('rate limit')) return true;
      if (msg.includes('timeout')) return true;
      if (msg.includes('etimedout')) return true;
      if (msg.includes('enotfound')) return true;
      if (msg.includes('econnreset')) return true;
      if (msg.includes('econnrefused')) return true;
      if (msg.includes('socket hang up')) return true;
      if (msg.includes('500')) return true;
      if (msg.includes('502')) return true;
      if (msg.includes('503')) return true;

      return true;
    },
    ...options,
  });
};

/**
 * Retry مخصوص درخواست‌های Telegram
 */
export const retryTgRequest = async (fn, options = {}) => {
  return retry(fn, {
    retries: 5,
    minTimeout: 1000,
    maxTimeout: 30000,
    factor: 2,
    shouldRetry: (err) => {
      const msg = (err.message || '').toLowerCase();

      // Flood wait - retry with longer backoff
      if (msg.includes('flood')) return true;

      // Network errors
      if (msg.includes('timeout')) return true;
      if (msg.includes('etimedout')) return true;
      if (msg.includes('econnreset')) return true;
      if (msg.includes('socket hang up')) return true;

      // Don't retry on auth errors
      if (msg.includes('auth_key')) return false;
      if (msg.includes('session revoked')) return false;
      if (msg.includes('user_deactivated')) return false;

      return true;
    },
    ...options,
  });
};

export default { retry, retryIgRequest, retryTgRequest };
