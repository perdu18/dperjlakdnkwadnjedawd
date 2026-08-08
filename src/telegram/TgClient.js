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
import proxyManager from '../proxy/ProxyManager.js';   // FIX: استفاده می‌شد ولی import نشده بود
import { tgLogger as log } from '../utils/Logger.js';
import { retryTgRequest } from '../utils/Retry.js';

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
    const tgProxy = (config.telegram.proxy || process.env.TG_PROXY || '').trim();

    if (tgProxy && tgProxy !== 'auto') {
      // Reject placeholder values from .env.example
      if (tgProxy.includes('user:pass@host:port') || tgProxy.includes('your_')) {
        log.warn({ msg: 'TG_PROXY contains placeholder value, ignoring' });
      } else {
        return this._parseProxyUrl(tgProxy);
      }
    }

    if (tgProxy === 'auto') {
      log.info('TG_PROXY=auto - WSS will handle connection directly');
      return null;
    }

    // PROXY_STATIC_URL (if it's SOCKS5)
    const proxyMode = (process.env.PROXY_MODE || 'none').toLowerCase();
    const staticUrl = process.env.PROXY_STATIC_URL;

    if (proxyMode === 'static' && staticUrl) {
      // Reject placeholder values
      if (staticUrl.includes('user:pass@host:port') || staticUrl.includes('your_')) {
        log.warn({ msg: 'PROXY_STATIC_URL contains placeholder value, ignoring' });
      } else {
        return this._parseProxyUrl(staticUrl);
      }
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
   * با WSS transport، تلگرام مستقیم وصل میشه و نیازی به پروکسی نیست.
   * WSS مثل HTTPS از فایروال‌ها عبور می‌کنه.
   *
   * اگه TG_PROXY=auto باشه ولی WSS فعال باشه، auto-find رو skip می‌کنیم
   * چون WSS خودش کافیه.
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

    // اگه TG_PROXY=auto باشه، ولی ما از WSS استفاده می‌کنیم،
    // نیازی به پروکسی نیست — WSS خودش از فایروال‌ها عبور می‌کنه
    // پس auto-find رو skip می‌کنیم
    if (isAutoProxy) {
      log.info('TG_PROXY=auto detected, but WSS transport is active — skipping proxy search (WSS goes through firewalls directly)');
      // Force no proxy
      this._autoFoundProxy = null;
    } else if (tgProxy && tgProxy !== 'auto') {
      // اگه پروکسی مشخص شده، از اون استفاده کن
      log.info({ msg: 'Using explicit TG_PROXY', proxy: tgProxy.slice(0, 30) });
      const proxyConfig = this._parseProxyUrl(tgProxy);
      if (proxyConfig) {
        this._autoFoundProxy = { teleprotoConfig: proxyConfig };
        await this.init();  // Recreate client with proxy
      }
    }

    log.info('Connecting to Telegram via WSS...');
    this.connectionAttempts++;

    try {
      await this.client.connect();

      if (!(await this.client.isUserAuthorized())) {
        throw new Error('Session is not authorized. Run `npm run setup:telegram` again.');
      }

      this.me = await this.client.getMe();
      this.isConnected = true;
      this.lastError = null;

      log.info({
        msg: '✓ Telegram connected via WSS',
        phone: this.me.phone,
        firstName: this.me.firstName,
        username: this.me.username,
        userId: this.me.id.toString(),
      });

      return true;
    } catch (e) {
      this.lastError = e.message;
      this.lastErrorAt = new Date().toISOString();
      log.error({ msg: 'Telegram WSS connection failed', error: e.message });

      // Don't throw — let the bot continue running
      return false;
    }
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
/**
 * FIX ها:
 *  - BigInt محاسبه می‌شد و اصلاً استفاده نمی‌شد؛ حالا واقعاً به‌کار می‌رود
 *  - طبق MTProto اگر peer در کش/دیالوگ‌ها نباشد getInputEntity خطا می‌دهد،
 *    پس ابتدا با getEntity (contacts.resolveUsername) رزولوِ می‌کنیم و در
 *    نهایت دیالوگ‌ها را warm-up می‌کنیم
 *  - نتیجه‌ی ناموفق دیگر کش نمی‌شود
 */
async resolveChannel() {
  if (this._cachedChannelEntity) return this._cachedChannelEntity;

  const channelId = config.telegram.channelId;
  const channelUsername = config.telegram.channelUsername;

  log.info({ msg: 'Resolving Telegram channel entity', hasId: !!channelId, channelUsername });

  const candidates = [];
  if (channelUsername) candidates.push(channelUsername.replace('@', ''));
  if (channelId) {
    // -100XXXXXXXXXX  =>  channel id واقعی
    const raw = channelId.startsWith('-100') ? channelId.slice(4) : channelId.replace('-', '');
    try { candidates.push(BigInt(raw)); } catch { /* ignore */ }
    candidates.push(channelId);
  }
  if (candidates.length === 0) {
    throw new Error('No channel specified (TG_CHANNEL_ID or TG_CHANNEL_USERNAME)');
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const entity = await this.client.getEntity(candidate);
      this._cachedChannelEntity = entity;
      log.info({ msg: 'Channel resolved', entityId: entity.id?.toString() });
      return entity;
    } catch (e) {
      lastError = e;
      log.debug({ msg: 'Channel candidate failed', candidate: String(candidate), error: e.message });
    }
  }

  // آخرین تلاش: دیالوگ‌ها را بخوان تا کش entity پر شود (الزام MTProto)
  try {
    log.warn('Channel not in entity cache — warming up dialogs');
    const targetId = channelId
      ? BigInt(channelId.startsWith('-100') ? channelId.slice(4) : channelId.replace('-', ''))
      : null;
    const dialogs = await this.client.getDialogs({ limit: 200 });
    for (const dialog of dialogs) {
      const id = dialog.entity?.id?.toString?.();
      const uname = dialog.entity?.username?.toLowerCase?.();
      if ((targetId && id === targetId.toString())
        || (channelUsername && uname === channelUsername.replace('@', '').toLowerCase())) {
        this._cachedChannelEntity = dialog.entity;
        log.info({ msg: 'Channel resolved via dialogs', entityId: id });
        return dialog.entity;
      }
    }
  } catch (e) {
    lastError = e;
  }

  log.error({ msg: 'Could not resolve channel', channelId, channelUsername, error: lastError?.message });
  throw lastError || new Error('Cannot resolve channel entity');
}
  /**
   * Send a text message
   */
/**
 * FIX: طبق core.telegram.org سقف متن پیام 4096 کاراکتر UTF-16 است.
 * قبلاً پست بدون مدیا با کپشن بلند MESSAGE_TOO_LONG می‌گرفت و job fail می‌شد.
 */
async sendMessage(text, options = {}) {
  const entity = await this.resolveChannel();
  const chunks = this._splitMessage(String(text ?? ''), 4096);
  const sent = [];
  let replyTo = options.replyTo;

  for (const chunk of chunks) {
    try {
      const result = await this.client.sendMessage(entity, {
        message: chunk,
        parseMode: 'html',
        linkPreview: options.linkPreview ?? false,
        ...options,
        ...(replyTo ? { replyTo } : {}),
      });
      const info = {
        id: result.id,
        chatId: result.chatId?.toString?.() || result.peerId?.toString?.() || null,
      };
      sent.push(info);
      if (!options.replyTo) replyTo = info.id; // بقیه تکه‌ها به تکه‌ی اول reply شوند
    } catch (e) {
      log.error({
        msg: 'sendMessage failed',
        error: e.message, errorMessage: e.errorMessage,
        textLength: chunk?.length, textPreview: chunk?.slice(0, 100),
      });
      throw e;
    }
  }

  return sent.length === 1 ? sent[0] : sent;
}

/** تقسیم امن متن HTML روی مرز خط تا تگ‌ها نصف نشوند */
_splitMessage(text, maxLength = 4096) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > maxLength) {
      if (current) chunks.push(current);
      current = line.length > maxLength ? line.slice(0, maxLength) : line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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
   * Send grouped media using Telegram's messages.sendMultiMedia flow.
   * Telegram allows 2-10 items per album, so oversized carousels are split
   * without creating a one-item trailing batch.
   */
  async sendAlbum(filePaths, options = {}) {
    const entity = await this.resolveChannel();

    if (!Array.isArray(filePaths) || filePaths.length < 2) {
      throw new Error('An album requires at least 2 files');
    }

    const { caption = '', replyTo = undefined, ...extraOptions } = options;
    const batches = [];
    let offset = 0;

    while (filePaths.length - offset > 10) {
      const remaining = filePaths.length - offset;
      const batchSize = remaining === 11 ? 9 : 10;
      batches.push(filePaths.slice(offset, offset + batchSize));
      offset += batchSize;
    }
    batches.push(filePaths.slice(offset));

    const results = [];
    let firstMessageId = null;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      if (batch.length < 2 || batch.length > 10) {
        throw new Error(`Invalid Telegram album batch size: ${batch.length}`);
      }

      const captions = batch.map((_, itemIndex) =>
        batchIndex === 0 && itemIndex === 0 ? caption : '');
      const replyTarget = batchIndex === 0 ? replyTo : firstMessageId;
      // Retry only the current batch. Retrying the whole carousel after a later
      // batch fails would duplicate every batch already published.
      const result = await retryTgRequest(() => this.client.sendFile(entity, {
        ...extraOptions,
        file: batch,
        caption: captions,
        parseMode: 'html',
        forceDocument: false,
        supportsStreaming: true,
        ...(replyTarget ? { replyTo: replyTarget } : {}),
      }));

      const messages = Array.isArray(result) ? result : [result];
      for (const message of messages) {
        if (!message) continue;
        results.push({
          id: message.id,
          chatId: message.chatId?.toString?.() || message.peerId?.toString?.() || null,
        });
      }

      if (!firstMessageId) {
        firstMessageId = results[0]?.id;
      }
    }

    if (results.length === 0) {
      throw new Error('Telegram returned no messages for album');
    }

    return results;
  }

  /**
   * Send UTF-8 text as a document, optionally replying to another message.
   */
  async sendTextFile(content, options = {}) {
    const entity = await this.resolveChannel();
    const buffer = Buffer.from(String(content ?? ''), 'utf8');
    buffer.name = options.filename || 'instagram-caption.txt';

    const result = await this.client.sendFile(entity, {
      file: buffer,
      forceDocument: true,
      caption: options.caption || '',
      parseMode: 'html',
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    });

    return {
      id: result.id,
      chatId: result.chatId?.toString?.() || result.peerId?.toString?.() || null,
    };
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
