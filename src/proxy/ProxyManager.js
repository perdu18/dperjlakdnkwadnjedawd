/**
 * proxy/ProxyManager.js
 * مدیریت پروکسی‌ها: دانلود خودکار از TheSpeedX/PROXY-List، چرخش و health check
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomInt } from 'crypto';
import cron from 'node-cron';

import config from '../config/env.js';
import { proxyLogger as log } from '../utils/Logger.js';
import { parseProxyUrl, sleep } from '../utils/Helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

const PROXY_FILE_HTTP = 'http.txt';
const PROXY_FILE_SOCKS = 'socks5.txt';

class ProxyManager {
  constructor() {
    this.proxies = [];          // {url, type, host, port, username, password, score, lastUsed, lastChecked, failCount}
    this.currentIndex = 0;
    this.lastUpdate = 0;
    this.isUpdating = false;
    this.isEnabled = config.proxy.mode !== 'none';
    this.cronTask = null;
  }

  /**
   * مقداردهی اولیه
   */
  async init() {
    if (!this.isEnabled) {
      log.info('Proxy disabled (PROXY_MODE=none)');
      return;
    }

    if (config.proxy.mode === 'static') {
      await this._initStatic();
    } else if (config.proxy.mode === 'list') {
      await this._initList();
      // Schedule periodic update
      const hours = config.proxy.listUpdateHours;
      const cronExpr = `0 */${hours} * * *`;
      this.cronTask = cron.schedule(cronExpr, async () => {
        log.info('Scheduled proxy list update triggered');
        await this.refreshList();
      });
      log.info({ msg: 'Scheduled proxy list update', cronExpression: cronExpr });
    }
  }

  /**
   * حالت static: فقط یک پروکسی ثابت
   */
  async _initStatic() {
    const url = config.proxy.staticUrl;
    if (!url) {
      log.warn('PROXY_MODE=static but PROXY_STATIC_URL is empty. Disabling proxy.');
      this.isEnabled = false;
      return;
    }

    const parsed = parseProxyUrl(url);
    if (!parsed) {
      log.error({ msg: 'Invalid static proxy URL', url });
      this.isEnabled = false;
      return;
    }

    this.proxies = [{
      url: parsed.raw,
      type: parsed.type,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      score: 100,
      lastUsed: 0,
      lastChecked: 0,
      failCount: 0,
    }];

    log.info({ msg: 'Static proxy initialized', host: parsed.host, port: parsed.port, type: parsed.type });
  }

  /**
   * حالت list: دانلود لیست از GitHub
   */
  async _initList() {
    // Try to load cached file first
    const cached = this._loadCached();
    if (cached.length > 0) {
      this.proxies = cached;
      log.info({ msg: 'Loaded cached proxy list', count: cached.length });
    }

    // Then refresh from network
    await this.refreshList();
  }

  /**
   * دانلود و آپدیت لیست پروکسی‌ها
   */
  async refreshList() {
    if (this.isUpdating) {
      log.debug('Proxy list update already in progress');
      return;
    }

    this.isUpdating = true;
    const newProxies = [];

    try {
      log.info('Downloading proxy lists from TheSpeedX/PROXY-List...');

      // Download HTTP proxies
      const httpProxies = await this._downloadList(config.proxy.listUrlHttp);
      log.info({ msg: 'Downloaded HTTP proxies', count: httpProxies.length });

      // Download SOCKS5 proxies
      const socksProxies = await this._downloadList(config.proxy.listUrlSocks);
      log.info({ msg: 'Downloaded SOCKS5 proxies', count: socksProxies.length });

      for (const p of httpProxies) {
        const parsed = parseProxyUrl(p);
        if (parsed) {
          newProxies.push({
            url: parsed.raw,
            type: parsed.type,
            host: parsed.host,
            port: parsed.port,
            username: parsed.username,
            password: parsed.password,
            score: 50,
            lastUsed: 0,
            lastChecked: 0,
            failCount: 0,
          });
        }
      }

      for (const p of socksProxies) {
        const parsed = parseProxyUrl(p);
        if (parsed) {
          newProxies.push({
            url: parsed.raw,
            type: 'socks5',
            host: parsed.host,
            port: parsed.port,
            username: parsed.username,
            password: parsed.password,
            score: 50,
            lastUsed: 0,
            lastChecked: 0,
            failCount: 0,
          });
        }
      }

      if (newProxies.length === 0) {
        log.warn('No proxies downloaded. Keeping old list.');
        return;
      }

      // Shuffle to randomize order
      this._shuffle(newProxies);

      this.proxies = newProxies;
      this.lastUpdate = Date.now();

      // Save to cache
      this._saveCached();

      log.info({ msg: 'Proxy list updated', total: newProxies.length });
    } catch (e) {
      log.error({ msg: 'Failed to update proxy list', error: e.message });
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * دانلود یک لیست
   */
  async _downloadList(url) {
    try {
      const res = await axios.get(url, {
        timeout: 30000,
        responseType: 'text',
      });
      return res.data.split('\n').map(l => l.trim()).filter(Boolean);
    } catch (e) {
      log.warn({ msg: 'Failed to download proxy list', url, error: e.message });
      return [];
    }
  }

  /**
   * Load cached proxy files
   */
  _loadCached() {
    const result = [];
    const proxyDir = resolve(projectRoot, config.proxy.dir);

    for (const [file, type] of [[PROXY_FILE_HTTP, 'http'], [PROXY_FILE_SOCKS, 'socks5']]) {
      const path = join(proxyDir, file);
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parsed = parseProxyUrl(trimmed);
          if (parsed) {
            result.push({
              url: parsed.raw,
              type,
              host: parsed.host,
              port: parsed.port,
              username: parsed.username,
              password: parsed.password,
              score: 50,
              lastUsed: 0,
              lastChecked: 0,
              failCount: 0,
            });
          }
        }
      } catch (e) {
        log.warn({ msg: 'Could not load cached proxy file', file, error: e.message });
      }
    }

    return result;
  }

  /**
   * Save current proxies to cache files
   */
  _saveCached() {
    const proxyDir = resolve(projectRoot, config.proxy.dir);
    if (!existsSync(proxyDir)) {
      mkdirSync(proxyDir, { recursive: true });
    }

    const httpList = this.proxies.filter(p => p.type === 'http' || p.type === 'https')
      .map(p => `${p.host}:${p.port}`).join('\n');
    const socksList = this.proxies.filter(p => p.type === 'socks5')
      .map(p => `${p.host}:${p.port}`).join('\n');

    writeFileSync(join(proxyDir, PROXY_FILE_HTTP), httpList);
    writeFileSync(join(proxyDir, PROXY_FILE_SOCKS), socksList);
  }

  /**
   * دریافت پروکسی بعدی (Round-robin با score-based weighting)
   */
  getNext() {
    if (!this.isEnabled || this.proxies.length === 0) return null;

    // Try to find a working proxy (skip ones that have failed too much)
    for (let i = 0; i < this.proxies.length; i++) {
      const idx = (this.currentIndex + i) % this.proxies.length;
      const proxy = this.proxies[idx];

      // Skip proxies that have failed > 5 times in a row
      if (proxy.failCount > 5) continue;

      this.currentIndex = (idx + 1) % this.proxies.length;
      proxy.lastUsed = Date.now();
      return proxy;
    }

    // All failed - reset and return random
    log.warn('All proxies have failed. Resetting fail counts.');
    for (const p of this.proxies) {
      p.failCount = 0;
    }

    const randomIdx = randomInt(0, this.proxies.length);
    return this.proxies[randomIdx];
  }

  /**
   * Get a random proxy
   */
  getRandom() {
    if (!this.isEnabled || this.proxies.length === 0) return null;
    return this.proxies[randomInt(0, this.proxies.length)];
  }

  /**
   * ساخت Agent برای axios/fetch
   */
  createAgent(proxy = null) {
    if (!this.isEnabled) return null;

    const p = proxy || this.getNext();
    if (!p) return null;

    try {
      if (p.type === 'socks5' || p.type === 'socks4') {
        return new SocksProxyAgent({
          host: p.host,
          port: p.port,
          type: p.type === 'socks4' ? 4 : 5,
          ...(p.username && p.password ? {
            userId: p.username,
            password: p.password,
          } : {}),
        });
      }
      // http/https
      const proxyUrl = p.username
        ? `${p.type}://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}`
        : `${p.type}://${p.host}:${p.port}`;
      return new HttpsProxyAgent(proxyUrl);
    } catch (e) {
      log.warn({ msg: 'Failed to create proxy agent', error: e.message });
      return null;
    }
  }

  /**
   * Mark proxy as success
   */
  markSuccess(proxy) {
    if (!proxy) return;
    proxy.failCount = 0;
    proxy.score = Math.min(100, (proxy.score || 50) + 5);
    proxy.lastChecked = Date.now();
  }

  /**
   * Mark proxy as failed
   */
  markFailed(proxy) {
    if (!proxy) return;
    proxy.failCount = (proxy.failCount || 0) + 1;
    proxy.score = Math.max(0, (proxy.score || 50) - 10);
    proxy.lastChecked = Date.now();

    if (proxy.failCount >= 5) {
      log.debug({ msg: 'Proxy marked as failing', host: proxy.host, port: proxy.port, failCount: proxy.failCount });
    }
  }

  /**
   * تست یک پروکسی
   */
  async testProxy(proxy, testUrl = 'https://www.google.com/generate_204') {
    const start = Date.now();
    const agent = this.createAgent(proxy);

    try {
      await axios.get(testUrl, {
        httpsAgent: agent,
        httpAgent: agent,
        timeout: config.proxy.timeout,
        maxRedirects: 0,
        validateStatus: (s) => s < 400,
      });

      const responseTime = Date.now() - start;
      this.markSuccess(proxy);
      return { success: true, responseTime };
    } catch (e) {
      this.markFailed(proxy);
      return { success: false, error: e.message };
    }
  }

  /**
   * آمار کلی
   */
  getStats() {
    const total = this.proxies.length;
    const working = this.proxies.filter(p => p.failCount < 5).length;
    const failed = total - working;

    return {
      total,
      working,
      failed,
      lastUpdate: this.lastUpdate ? new Date(this.lastUpdate).toISOString() : null,
      isEnabled: this.isEnabled,
      mode: config.proxy.mode,
    };
  }

  /**
   * پیدا کردن یه پروکسی SOCKS5 سالم برای تلگرام
   *
   * این متد به‌صورت خودکار از لیست پروکسی‌های دانلود شده، چندتا SOCKS5 رو تست می‌کنه
   * و اولین پروکسی که بتونه به سرورهای تلگرام وصل بشه رو برمی‌گردونه.
   *
   * @param {Object} options
   *   - maxAttempts: حداکثر تعداد پروکسی برای تست (default: 20)
   *   - testUrl: URL برای تست (default: https://telegram.org)
   *   - timeout: timeout هر تست به میلی‌ثانیه (default: 8000)
   *   - onProgress: callback برای گزارش پیشرفت
   * @returns {Promise<Object|null>} پروکسی سالم یا null
   */
  async findWorkingSocks5Proxy(options = {}) {
    const {
      maxAttempts = 20,
      testUrl = 'https://telegram.org',
      timeout = 8000,
      onProgress = null,
    } = options;

    log.info({
      msg: 'Searching for working SOCKS5 proxy for Telegram',
      maxAttempts,
      testUrl,
    });

    // Get all SOCKS5 proxies that haven't failed too much
    const socks5Proxies = this.proxies.filter(p =>
      p.type === 'socks5' && p.failCount < 3
    );

    if (socks5Proxies.length === 0) {
      log.warn('No SOCKS5 proxies available');
      return null;
    }

    // Shuffle to test random proxies (shuffle in-place)
    this._shuffle(socks5Proxies);

    // Test up to maxAttempts proxies
    const toTest = socks5Proxies.slice(0, Math.min(maxAttempts, socks5Proxies.length));

    log.info({
      msg: 'Testing SOCKS5 proxies',
      total: socks5Proxies.length,
      toTest: toTest.length,
    });

    for (let i = 0; i < toTest.length; i++) {
      const proxy = toTest[i];

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: toTest.length,
          proxy: `${proxy.host}:${proxy.port}`,
        });
      }

      log.debug({
        msg: 'Testing proxy',
        progress: `${i+1}/${toTest.length}`,
        proxy: `${proxy.host}:${proxy.port}`,
      });

      const start = Date.now();

      try {
        // Build proxy URL
        const proxyUrl = proxy.username
          ? `socks5://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`
          : `socks5://${proxy.host}:${proxy.port}`;

        const agent = new SocksProxyAgent(proxyUrl);

        // Test connection to Telegram
        const res = await axios.get(testUrl, {
          httpsAgent: agent,
          httpAgent: agent,
          timeout,
          maxRedirects: 0,
          validateStatus: () => true,
        });

        const responseTime = Date.now() - start;

        if (res.status < 500) {
          log.info({
            msg: '✓ Found working SOCKS5 proxy',
            proxy: `${proxy.host}:${proxy.port}`,
            responseTime,
            status: res.status,
          });

          this.markSuccess(proxy);

          // Return proxy in teleproto format
          const teleprotoConfig = {
            ip: proxy.host,
            port: proxy.port,
            socksType: 5,
            timeout: 10,
          };

          if (proxy.username) {
            teleprotoConfig.username = proxy.username;
          }
          if (proxy.password) {
            teleprotoConfig.password = proxy.password;
          }

          return {
            proxy,
            teleprotoConfig,
            proxyUrl,
            responseTime,
          };
        }

        this.markFailed(proxy);
      } catch (e) {
        this.markFailed(proxy);
        log.debug({
          msg: 'Proxy test failed',
          proxy: `${proxy.host}:${proxy.port}`,
          error: e.message.slice(0, 50),
        });
      }
    }

    log.warn({
      msg: 'No working SOCKS5 proxy found',
      tested: toTest.length,
    });

    return null;
  }

  /**
   * Get all SOCKS5 proxies (for debugging)
   */
  getSocks5Proxies(limit = 10) {
    return this.proxies
      .filter(p => p.type === 'socks5' && p.failCount < 3)
      .slice(0, limit);
  }

  /**
   * پیدا کردن یه پروکسی HTTP سالم برای Bot API
   *
   * Bot API (node-telegram-bot-api) از undici استفاده می‌کنه که فقط HTTP/HTTPS proxy
   * پشتیبانی می‌کنه. پس برای ربات مدیریت، یه HTTP پروکسی سالم پیدا می‌کنیم.
   *
   * @param {Object} options
   *   - maxAttempts: حداکثر تعداد پروکسی برای تست (default: 30)
   *   - testUrl: URL برای تست (default: https://api.telegram.org)
   *   - timeout: timeout هر تست به میلی‌ثانیه (default: 8000)
   *   - onProgress: callback برای گزارش پیشرفت
   * @returns {Promise<Object|null>} پروکسی سالم یا null
   */
  async findWorkingHttpProxy(options = {}) {
    const {
      maxAttempts = 30,
      testUrl = 'https://api.telegram.org',
      timeout = 8000,
      onProgress = null,
    } = options;

    log.info({
      msg: 'Searching for working HTTP proxy for Bot API',
      maxAttempts,
      testUrl,
    });

    // Get all HTTP proxies that haven't failed too much
    const httpProxies = this.proxies.filter(p =>
      (p.type === 'http' || p.type === 'https') && p.failCount < 3
    );

    if (httpProxies.length === 0) {
      log.warn('No HTTP proxies available');
      return null;
    }

    // Shuffle to test random proxies
    this._shuffle(httpProxies);

    // Test up to maxAttempts proxies
    const toTest = httpProxies.slice(0, Math.min(maxAttempts, httpProxies.length));

    log.info({
      msg: 'Testing HTTP proxies',
      total: httpProxies.length,
      toTest: toTest.length,
    });

    for (let i = 0; i < toTest.length; i++) {
      const proxy = toTest[i];

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: toTest.length,
          proxy: `${proxy.host}:${proxy.port}`,
        });
      }

      log.debug({
        msg: 'Testing HTTP proxy',
        progress: `${i+1}/${toTest.length}`,
        proxy: `${proxy.host}:${proxy.port}`,
      });

      const start = Date.now();

      try {
        // Build proxy URL
        const proxyUrl = proxy.username
          ? `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`
          : `http://${proxy.host}:${proxy.port}`;

        const agent = new HttpsProxyAgent(proxyUrl);

        // Test connection to Telegram Bot API
        const res = await axios.get(testUrl, {
          httpsAgent: agent,
          httpAgent: agent,
          timeout,
          maxRedirects: 0,
          validateStatus: () => true,
        });

        const responseTime = Date.now() - start;

        if (res.status < 500) {
          log.info({
            msg: '✓ Found working HTTP proxy',
            proxy: `${proxy.host}:${proxy.port}`,
            responseTime,
            status: res.status,
          });

          this.markSuccess(proxy);

          return {
            proxy,
            proxyUrl,
            responseTime,
          };
        }

        this.markFailed(proxy);
      } catch (e) {
        this.markFailed(proxy);
        log.debug({
          msg: 'HTTP proxy test failed',
          proxy: `${proxy.host}:${proxy.port}`,
          error: e.message.slice(0, 50),
        });
      }
    }

    log.warn({
      msg: 'No working HTTP proxy found',
      tested: toTest.length,
    });

    return null;
  }

  /**
   * توقف cron
   */
  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }
  }

  /**
   * Shuffle array (Fisher-Yates)
   */
  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}

// Singleton
const proxyManager = new ProxyManager();
export default proxyManager;
