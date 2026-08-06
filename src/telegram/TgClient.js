/**
 * telegram/TgClient.js
 * کلاینت تلگرام با استفاده از teleproto (fork فعال GramJS)
 *
 * این کلاینت با session کاربر (نه bot) وصل میشه تا بتونه فایل‌های بزرگ
 * تا 2GB ارسال کنه (محدودیت Bot API 50MB است).
 *
 * پیش‌نیاز: اجرای scripts/setup-telegram.js برای ساخت session اولیه
 *
 * نکته: پکیج telegram (GramJS) دیگه deprecated شده و LAYER 198 قدیمی داره
 * که باعث هنگ کردن موقع connect میشه. teleproto با LAYER 228 این مشکل رو حل می‌کنه.
 * API کاملاً شبیه GramJS هست و session string قبلی هم کار می‌کنه.
 */

import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { PromisedWebSockets } from 'teleproto/extensions/index.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../config/env.js';
import { tgLogger as log } from '../utils/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

class TgClient {
  constructor() {
    this.client = null;
    this.sessionString = null;
    this.sessionFilePath = null;
    this.isConnected = false;
    this.me = null;
    this.lastError = null;
    this.lastErrorAt = null;
    this.connectionAttempts = 0;
    this._autoFoundProxy = null;
    this._cachedChannelEntity = null;
    this.stickyProxy = null;
  }

  /**
   * Initialize
   */
  async init() {
    const sessionDir = resolve(projectRoot, config.telegram.sessionDir);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    this.sessionFilePath = join(sessionDir, `${config.telegram.sessionName}.session`);

    // Load saved session
    this._loadSession();

    const session = new StringSession(this.sessionString || '');

    // Build proxy config
    // Priority: auto-found proxy > TG_PROXY > PROXY_STATIC_URL
    let proxyConfig = null;

    if (this._autoFoundProxy?.teleprotoConfig) {
      // Use the auto-found proxy from previous search
      proxyConfig = this._autoFoundProxy.teleprotoConfig;
      log.info({
        msg: 'Using auto-found proxy for Telegram client',
        host: proxyConfig.ip,
        port: proxyConfig.port,
      });
    } else {
      // Use static config (TG_PROXY or PROXY_STATIC_URL)
      proxyConfig = this._buildProxyConfig();
    }

    this.client = new TelegramClient(
      session,
      parseInt(config.telegram.apiId, 10),
      config.telegram.apiHash,
      {
        // مهم: استفاده از PromisedWebSockets به‌جای useWSS
        // teleproto از useWSS پشتیبانی نمی‌کنه — باید networkSocket رو تنظیم کنیم
        // WSS روی پورت 443 مثل HTTPS به نظر میره و از فایروال‌ها عبور می‌کنه
        // این مهم‌ترین تنظیم برای اتصال از Railway به تلگرام هست
        networkSocket: PromisedWebSockets,

        connectionRetries: 10,
        retryDelay: 2000,
        autoReconnect: true,
        floodSleepThreshold: 60,   // auto-wait on flood waits up to 60s
        deviceModel: 'IG Monitor Bot',
        systemVersion: '1.0.0',
        appVersion: '1.0.0',
        langCode: 'en',
        systemLangCode: 'en',
        ...(proxyConfig ? { proxy: proxyConfig } : {}),
      }
    );

    log.info({
      msg: 'Telegram client initialized (WSS transport)',
      hasSession: !!this.sessionString,
      layer: '228+ (teleproto)',
      transport: 'WSS (PromisedWebSockets)',
      hasProxy: !!proxyConfig,
      proxyType: proxyConfig ? (proxyConfig.socksType === 5 ? 'SOCKS5' : (proxyConfig.MTProxy ? 'MTProxy' : 'SOCKS4')) : 'none',
    });
  }

  /**
   * Build proxy config for teleproto from .env settings
   *
   * تلگرام MTProto روی TCP خام کار می‌کنه (نه HTTP)، پس فقط SOCKS5/SOCKS4 پشتیبانی میشه.
   *
   * اولویت‌ها:
   *   1. TG_PROXY=socks5://... (پروکسی مشخص شده)
   *   2. TG_PROXY=auto (پیدا کردن خودکار پروکسی سالم از لیست)
   *   3. PROXY_STATIC_URL (اگه SOCKS5 باشه)
   *
   * اگه هیچکدوم تنظیم نشده باشه، بدون پروکسی وصل میشه (در Railway کار نمیکنه).
   *
   * @param {boolean} autoFind - اگه true باشه، پروکسی سالم رو خودکار پیدا می‌کنه
   */
  async _buildProxyConfigWithAutoFind(autoFind = false) {
    // Method 1: TG_PROXY (highest priority)
    const tgProxy = (config.telegram.proxy || process.env.TG_PROXY || '').trim();

    if (tgProxy && tgProxy !== 'auto') {
      const proxyConfig = this._parseProxyUrl(tgProxy);
      if (proxyConfig) {
        log.info({
          msg: 'Using TG_PROXY for Telegram',
          host: proxyConfig.ip,
          port: proxyConfig.port,
          type: proxyConfig.socksType === 5 ? 'SOCKS5' : 'SOCKS4',
        });
        return proxyConfig;
      }
    }

    // Method 2: TG_PROXY=auto - find working SOCKS5 proxy automatically
    if (tgProxy === 'auto' || autoFind) {
      log.info('TG_PROXY=auto - searching for working SOCKS5 proxy...');

      // Make sure proxyManager is initialized
      if (!proxyManager.isEnabled) {
        log.warn('ProxyManager is disabled, cannot auto-find proxy');
      } else if (proxyManager.proxies.length === 0) {
        log.warn('No proxies loaded, cannot auto-find');
      } else {
        const result = await proxyManager.findWorkingSocks5Proxy({
          maxAttempts: 30,
          testUrl: 'https://telegram.org',
          timeout: 8000,
        });

        if (result) {
          log.info({
            msg: '✓ Auto-found working SOCKS5 proxy',
            host: result.proxy.host,
            port: result.proxy.port,
            responseTime: result.responseTime,
          });

          // Cache it for future use
          this._autoFoundProxy = result;

          return result.teleprotoConfig;
        }

        log.warn('Could not find any working SOCKS5 proxy');
      }
    }

    // Method 3: PROXY_STATIC_URL (if it's SOCKS5)
    const proxyMode = (process.env.PROXY_MODE || 'none').toLowerCase();
    const staticUrl = process.env.PROXY_STATIC_URL;

    if (proxyMode === 'static' && staticUrl) {
      const proxyConfig = this._parseProxyUrl(staticUrl);
      if (proxyConfig) {
        log.info({
          msg: 'Using PROXY_STATIC_URL for Telegram',
          host: proxyConfig.ip,
          port: proxyConfig.port,
          type: proxyConfig.socksType === 5 ? 'SOCKS5' : 'SOCKS4',
        });
        return proxyConfig;
      }

      // HTTP proxy detected but not supported
      const url = (() => { try { return new URL(staticUrl); } catch { return null; } })();
      if (url) {
        const protocol = url.protocol.replace(':', '').toLowerCase();
        if (protocol === 'http' || protocol === 'https') {
          log.warn({
            msg: 'HTTP proxy detected but Telegram needs SOCKS5',
            advice: 'Set TG_PROXY=auto to find a working SOCKS5 proxy automatically',
          });
        }
      }
    }

    if (tgProxy !== 'auto' && !autoFind) {
      log.warn({
        msg: 'No Telegram proxy configured',
        advice: 'Set TG_PROXY=auto for automatic proxy discovery',
      });
    }
    return null;
  }

  /**
   * Build proxy config for teleproto (legacy sync version, no auto-find)
   */
  _buildProxyConfig() {
    // This is called from init() which is synchronous
    // For auto-find, use _buildProxyConfigWithAutoFind(true) after init
    const tgProxy = (config.telegram.proxy || process.env.TG_PROXY || '').trim();

    if (tgProxy && tgProxy !== 'auto') {
      return this._parseProxyUrl(tgProxy);
    }

    // For 'auto', we return null here and the actual finding happens in connect()
    if (tgProxy === 'auto') {
      log.info('TG_PROXY=auto - will find working SOCKS5 proxy during connect()');
      return null;
    }

    // Method 3: PROXY_STATIC_URL (if it's SOCKS5)
    const proxyMode = (process.env.PROXY_MODE || 'none').toLowerCase();
    const staticUrl = process.env.PROXY_STATIC_URL;

    if (proxyMode === 'static' && staticUrl) {
      return this._parseProxyUrl(staticUrl);
    }

    return null;
  }

  /**
   * Parse proxy URL string into teleproto proxy config
   *
   * @param {string} proxyUrl - e.g., "socks5://user:pass@host:port"
   * @returns {Object|null} teleproto proxy config
   */
  _parseProxyUrl(proxyUrl) {
    try {
      const url = new URL(proxyUrl);
      const protocol = url.protocol.replace(':', '').toLowerCase();

      if (protocol !== 'socks5' && protocol !== 'socks4') {
        log.warn({
          msg: 'Telegram proxy must be SOCKS5 or SOCKS4',
          protocol,
          advice: 'HTTP proxies are not supported by MTProto (uses raw TCP)',
        });
        return null;
      }

      const proxyConfig = {
        ip: url.hostname,
        port: parseInt(url.port, 10) || 1080,
        socksType: protocol === 'socks5' ? 5 : 4,
        timeout: 10,
      };

      if (url.username) {
        proxyConfig.username = decodeURIComponent(url.username);
      }
      if (url.password) {
        proxyConfig.password = decodeURIComponent(url.password);
      }

      this.stickyProxy = {
        type: protocol,
        host: url.hostname,
        port: parseInt(url.port, 10) || 1080,
      };

      return proxyConfig;
    } catch (e) {
      log.warn({ msg: 'Could not parse proxy URL', url: proxyUrl, error: e.message });
      return null;
    }
  }

  /**
   * Load saved session string
   */
  _loadSession() {
    // Try file first
    if (existsSync(this.sessionFilePath)) {
      try {
        const content = readFileSync(this.sessionFilePath, 'utf8').trim();
        if (content.startsWith('1') && content.length > 50) {
          // Looks like a valid StringSession
          this.sessionString = content;
          log.debug('Loaded session from file');
          return;
        }
      } catch (e) {
        log.warn({ msg: 'Could not load session file', error: e.message });
      }
    }

    // Try env var
    const envSession = process.env.TG_SESSION_STRING;
    if (envSession) {
      this.sessionString = envSession;
      log.debug('Loaded session from env var');
    }
  }

  /**
   * Save session string to file
   */
  _saveSession(sessionString) {
    try {
      writeFileSync(this.sessionFilePath, sessionString, 'utf8');
      log.info({ msg: 'Session saved', path: this.sessionFilePath });
    } catch (e) {
      log.error({ msg: 'Could not save session', error: e.message });
    }
  }

  /**
   * Connect (using saved session)
   *
   * اگه TG_PROXY=auto باشه، قبل از connect، یه پروکسی سالم پیدا می‌کنه.
   * اگه connection شکست خورد و پروکسی auto بود، یه پروکسی دیگه رو امتحان می‌کنه.
   *
   * مهم: این متد در صورت شکست، throw نمی‌کنه (تا ربات به کارش ادامه بده).
   * به‌جاش، lastError رو ذخیره می‌کنه که از /debug قابل مشاهده است.
   */
  async connect() {
    if (!this.client) await this.init();

    if (!this.sessionString) {
      this.lastError = 'No Telegram session found. Run: npm run setup:telegram';
      this.lastErrorAt = new Date().toISOString();
      log.error({ msg: this.lastError });
      return false;
    }

    const tgProxy = (config.telegram.proxy || process.env.TG_PROXY || '').trim();
    const isAutoProxy = tgProxy === 'auto';

    // If auto proxy, find a working one before connecting
    // با timeout ۶۰ ثانیه‌ای تا ربات hang نشه
    if (isAutoProxy && !this._autoFoundProxy) {
      log.info('TG_PROXY=auto - finding working SOCKS5 proxy before connect...');

      // Race بین auto-find و timeout
      const findPromise = this._buildProxyConfigWithAutoFind(true);
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve('__TIMEOUT__'), 60000);  // 60 seconds max
      });

      const proxyConfig = await Promise.race([findPromise, timeoutPromise]);

      if (proxyConfig === '__TIMEOUT__') {
        log.warn('Auto-find proxy timed out after 60s - trying direct connection');
        // Continue without proxy (will likely fail, but at least won't hang)
      } else if (proxyConfig) {
        // Recreate client with the found proxy
        await this.init();
      } else {
        this.lastError = 'Could not find any working SOCKS5 proxy for Telegram';
        this.lastErrorAt = new Date().toISOString();
        log.error({ msg: this.lastError });

        // Don't return false immediately — try direct connection as fallback
        log.info('Trying direct connection as fallback...');
      }
    }

    const maxRetries = isAutoProxy ? 3 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.connectionAttempts++;
      try {
        log.info({ msg: 'Connecting to Telegram...', attempt, maxRetries });
        await this.client.connect();

        if (!(await this.client.isUserAuthorized())) {
          throw new Error('Session is not authorized. Run `npm run setup:telegram` again.');
        }

        this.me = await this.client.getMe();
        this.isConnected = true;
        this.lastError = null;  // Clear error on success

        log.info({
          msg: 'Telegram connected',
          phone: this.me.phone,
          firstName: this.me.firstName,
          username: this.me.username,
          userId: this.me.id.toString(),
        });

        return true;
      } catch (e) {
        lastError = e;
        log.warn({
          msg: 'Telegram connection attempt failed',
          attempt,
          maxRetries,
          error: e.message,
        });

        if (attempt < maxRetries && isAutoProxy) {
          // Try finding another proxy
          log.info('Trying another SOCKS5 proxy...');
          const newProxy = await this._buildProxyConfigWithAutoFind(true);

          if (newProxy) {
            // Recreate client with new proxy
            await this.init();
            await this.client.connect(); // Re-init session

            // Wait a bit before retry
            await new Promise(r => setTimeout(r, 2000));
          } else {
            log.error('No more working SOCKS5 proxies available');
            break;
          }
        }
      }
    }

    // Store error for debugging
    this.lastError = lastError?.message || 'Telegram connection failed';
    this.lastErrorAt = new Date().toISOString();

    log.error({ msg: 'Telegram connection failed', error: this.lastError });

    // Don't throw - let the bot continue running
    return false;
  }

  /**
   * Find a new working SOCKS5 proxy (for retry or manual refresh)
   *
   * @returns {Promise<Object|null>} پروکسی سالم یا null
   */
  async findNewWorkingProxy() {
    return this._buildProxyConfigWithAutoFind(true);
  }

  /**
   * Get entity for a channel (resolve by id or username)
   *
   * Cached برای کارایی: بعد از اولین resolve، entity رو در حافظه نگه می‌داریم.
   */
  async resolveChannel() {
    // Return cached entity
    if (this._cachedChannelEntity) {
      return this._cachedChannelEntity;
    }

    const channelId = config.telegram.channelId;
    const channelUsername = config.telegram.channelUsername;

    log.info({
      msg: 'Resolving Telegram channel entity',
      channelId: channelId ? channelId.slice(0, 20) + '...' : null,
      channelUsername,
    });

    try {
      let entity;

      if (channelId) {
        // channelId can be -100... format or just a number
        const id = channelId.startsWith('-100')
          ? BigInt(channelId.slice(4))
          : BigInt(channelId);

        try {
          entity = await this.client.getInputEntity(channelId);
        } catch {
          // Try fetching via username instead
          if (channelUsername) {
            entity = await this.client.getInputEntity(channelUsername);
          } else {
            throw new Error('Cannot resolve channel entity');
          }
        }
      } else if (channelUsername) {
        const username = channelUsername.replace('@', '');
        entity = await this.client.getInputEntity(username);
      } else {
        throw new Error('No channel specified (TG_CHANNEL_ID or TG_CHANNEL_USERNAME)');
      }

      log.info({ msg: 'Channel resolved', entityId: entity.id?.toString() });
      this._cachedChannelEntity = entity;  // Cache for future use
      return entity;
    } catch (e) {
      log.error({ msg: 'Could not resolve channel', channelId, channelUsername, error: e.message });
      throw e;
    }
  }

  /**
   * Send a text message
   */
  async sendMessage(text, options = {}) {
    const entity = await this.resolveChannel();

    try {
      const result = await this.client.sendMessage(entity, {
        message: text,
        parseMode: 'html',
        linkPreview: options.linkPreview ?? false,
        ...options,
      });

      return {
        id: result.id,
        chatId: result.chatId?.toString?.() || result.peerId?.toString?.() || null,
      };
    } catch (e) {
      log.error({
        msg: 'sendMessage failed',
        error: e.message,
        errorMessage: e.errorMessage,
        textLength: text?.length,
        textPreview: text?.slice(0, 100),
      });
      throw e;
    }
  }

  /**
   * Send a file (photo/video/document)
   */
  async sendFile(filePath, options = {}) {
    const entity = await this.resolveChannel();

    const sendOptions = {
      parseMode: 'html',
      caption: options.caption || '',
      ...options,
    };

    // Determine if photo or document
    if (options.asPhoto) {
      sendOptions.forceDocument = false;
    } else if (options.asDocument) {
      sendOptions.forceDocument = true;
    }

    if (options.spoiler) {
      sendOptions.spoiler = true;
    }

    if (options.ttl) {
      sendOptions.ttl = options.ttl;
    }

    const result = await this.client.sendFile(entity, {
      file: filePath,
      ...sendOptions,
    });

    return {
      id: result.id,
      chatId: result.chatId?.toString?.() || result.peerId?.toString?.() || null,
    };
  }

  /**
   * Send an album (multiple photos/videos in one message)
   */
  async sendAlbum(filePaths, options = {}) {
    const entity = await this.resolveChannel();

    if (!filePaths || filePaths.length === 0) {
      throw new Error('No files to send');
    }

    // GramJS supports up to 10 items per album
    const results = [];
    const batches = [];
    for (let i = 0; i < filePaths.length; i += 10) {
      batches.push(filePaths.slice(i, i + 10));
    }

    for (const batch of batches) {
      const result = await this.client.sendFile(entity, {
        file: batch,
        caption: options.caption || '',
        parseMode: 'html',
        ...options,
      });

      if (Array.isArray(result)) {
        for (const r of result) {
          results.push({
            id: r.id,
            chatId: r.chatId?.toString?.() || r.peerId?.toString?.() || null,
          });
        }
      } else {
        results.push({
          id: result.id,
          chatId: result.chatId?.toString?.() || result.peerId?.toString?.() || null,
        });
      }
    }

    return results;
  }

  /**
   * Send alert to alert chat (for errors)
   */
  async sendAlert(text) {
    if (!config.telegram.alertChatId) return;

    try {
      await this.client.sendMessage(config.telegram.alertChatId, {
        message: `🚨 <b>Alert</b>\n\n${text}`,
        parseMode: 'html',
      });
    } catch (e) {
      log.warn({ msg: 'Could not send alert', error: e.message });
    }
  }

  /**
   * Disconnect
   */
  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
      log.info('Telegram disconnected');
    }
  }

  /**
   * Get the underlying client
   */
  getClient() {
    return this.client;
  }

  /**
   * Check if connected
   */
  isReady() {
    return this.isConnected && this.client !== null;
  }

  /**
   * Get debug info for /debug endpoint
   */
  getDebugInfo() {
    let sessionFileInfo = null;
    if (this.sessionFilePath && existsSync(this.sessionFilePath)) {
      try {
        const stats = statSync(this.sessionFilePath);
        sessionFileInfo = {
          path: this.sessionFilePath,
          exists: true,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        };
      } catch (e) {
        sessionFileInfo = { path: this.sessionFilePath, exists: true, error: e.message };
      }
    } else {
      sessionFileInfo = { path: this.sessionFilePath, exists: false };
    }

    return {
      isConnected: this.isConnected,
      hasSession: !!this.sessionString,
      sessionFile: sessionFileInfo,
      hasClient: !!this.client,
      me: this.me ? {
        id: this.me.id?.toString(),
        username: this.me.username,
        firstName: this.me.firstName,
        phone: this.me.phone,
      } : null,
      proxy: {
        tgProxy: process.env.TG_PROXY || 'none',
        isAuto: (process.env.TG_PROXY || '') === 'auto',
        autoFoundProxy: this._autoFoundProxy ? {
          host: this._autoFoundProxy.proxy.host,
          port: this._autoFoundProxy.proxy.port,
          responseTime: this._autoFoundProxy.responseTime,
        } : null,
        stickyProxy: this.stickyProxy ? {
          host: this.stickyProxy.host,
          port: this.stickyProxy.port,
          type: this.stickyProxy.type,
        } : null,
      },
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      connectionAttempts: this.connectionAttempts,
    };
  }
}

const tgClient = new TgClient();
export default tgClient;
