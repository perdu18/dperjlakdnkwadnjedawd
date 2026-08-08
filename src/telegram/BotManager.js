/**
 * telegram/BotManager.js
 *
 * ربات مدیریت تلگرام — کنترل کامل ربات مانیتور اینستاگرام از طریق تلگرام
 *
 * این نسخه از Telegram Bot API (با bot token) استفاده می‌کنه و شامل:
 *   - دکمه‌های شیشه‌ای (InlineKeyboardMarkup)
 *   - منوی اصلی با دکمه‌های شیشه‌ای
 *   - دستورات کامل مدیریت
 *   - لاگ‌گذاری و دیباگ
 *
 * دستورات:
 *   /start, /help       - راهنما
 *   /menu               - منوی اصلی با دکمه‌های شیشه‌ای
 *   /status             - وضعیت ربات
 *   /accounts           - لیست اکانت‌های مانیتور شده
 *   /add <username>     - افزودن اکانت
 *   /remove <username>  - حذف اکانت
 *   /pause <username>   - توقف موقت
 *   /resume <username>  - از سرگیری
 *   /pauseall           - توقف همه
 *   /resumeall          - از سرگیری همه
 *   /channel            - نمایش کانال مقصد
 *   /poll <username>    - چک فوری
 *   /stats              - آمار امروز
 *   /recent             - آخرین آیتم‌ها
 *   /retry              - تلاش مجدد ناموفق‌ها
 *   /cleanup            - پاکسازی آیتم‌های ناموفق قدیمی
 *   /reset <username>   - ریست last_post_pk اکانت
 *   /resetall           - ریست همه اکانت‌ها
 *   /restart            - ریستارت ربات
 *   /debug              - اطلاعات دیباگ
 *   /logs               - آخرین لاگ‌ها
 *   /id                 - آیدی عددی شما
 */

import TelegramBot from 'node-telegram-bot-api';

import config from '../config/env.js';
import { tgLogger as log } from '../utils/Logger.js';
import TrackedAccountsRepository from '../database/TrackedAccountsRepository.js';
import SentItemsRepository from '../database/SentItemsRepository.js';
import igClient from '../instagram/IgClient.js';
import tgClient from './TgClient.js';
import proxyManager from '../proxy/ProxyManager.js';
import sendWorker from '../workers/SendWorker.js';
import messageFormatter from './MessageFormatter.js';

class BotManager {
  constructor() {
    this.bot = null;
    this.isRunning = false;
    this.lastStartError = null;
    this.lastStartErrorAt = null;
    this.adminIds = this._parseAdminIds();
    this._commandQueue = new Map();
    this._userStates = new Map(); // برای conversation state (مثل /add)
  }

  /**
   * Parse ADMIN_IDS env var (comma-separated user IDs)
   */
  _parseAdminIds() {
    const raw = process.env.ADMIN_IDS || '';
    return raw.split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.toString());
  }

  /**
   * Check if user is admin
   */
  isAdmin(userId) {
    const userIdStr = String(userId);
    if (this.adminIds.length === 0) {
      return true;
    }
    return this.adminIds.includes(userIdStr);
  }

  /**
   * Start the bot manager
   *
   * این متد غیرهمزمان (non-blocking) هست — بلافاصله برمی‌گرده و ربات در پس‌زمینه
   * استارت میشه. اینطوری اگه api.telegram.org کند باشه، ربات منتظر نمیمونه.
   */
  async start() {
    if (this.isRunning) {
      log.warn('Bot manager is already running');
      return;
    }

    const botToken = process.env.TG_BOT_TOKEN;

    if (!botToken) {
      log.warn({ msg: 'TG_BOT_TOKEN not set, Bot Manager disabled' });
      log.warn({ msg: 'To enable Bot Manager, create a bot with @BotFather and set TG_BOT_TOKEN' });
      return;
    }

    log.info({
      msg: 'Starting Telegram Bot Manager (Bot API)',
      adminCount: this.adminIds.length,
    });

    // Start in background (non-blocking)
    this._startInBackground(botToken).catch(e => {
      log.error({ msg: 'Bot Manager background start failed', error: e.message });
    });

    // Return immediately — bot will start in background
    return;
  }

  /**
   * Background start — این متد در پس‌زمینه اجرا میشه
   */
  async _startInBackground(botToken) {
    try {
      const requestOptions = { timeout: 30000 };

      const tgProxy = (process.env.TG_PROXY || '').trim();
      const staticProxy = (process.env.PROXY_STATIC_URL || '').trim();

      let httpProxyUrl = null;

      // Validate URL before using
      const isValidUrl = (url) => {
        try {
          new URL(url);
          // Reject placeholder values from .env.example
          if (url.includes('user:pass@host:port') || url.includes('your_')) {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      };

      if (tgProxy && tgProxy !== 'auto' && isValidUrl(tgProxy)) {
        if (tgProxy.startsWith('http://') || tgProxy.startsWith('https://')) {
          httpProxyUrl = tgProxy;
        }
      }

      if (!httpProxyUrl && staticProxy && isValidUrl(staticProxy)) {
        if (staticProxy.startsWith('http://') || staticProxy.startsWith('https://')) {
          httpProxyUrl = staticProxy;
        }
      }

      if (httpProxyUrl) {
        const { ProxyAgent } = await import('undici');
        const dispatcher = new ProxyAgent(httpProxyUrl);
        requestOptions.fetchOptions = { dispatcher };
        log.info({ msg: 'Bot API using HTTP proxy' });
      } else {
        log.info('Bot API will use direct HTTPS connection');
      }

      // Create bot instance
      log.info('Creating TelegramBot instance...');
      this.bot = new TelegramBot(botToken, {
        polling: {
          interval: 300,
          autoStart: true,
          params: { timeout: 30 },
        },
        request: requestOptions,
      });

      log.info('TelegramBot instance created');

      this.bot.on('polling_error', (error) => {
        log.warn({ msg: 'Bot polling error', error: error.message, code: error.code });
      });

      this.bot.on('webhook_error', (error) => {
        log.warn({ msg: 'Bot webhook error', error: error.message });
      });

      // Register command handlers
      this._registerHandlers();
      log.info('Command handlers registered');

      // Mark as running immediately
      this.isRunning = true;
      this.lastStartError = null;
      log.info('✓ Bot Manager started and listening for commands');

      // Get bot info (with timeout)
      try {
        log.info('Calling bot.getMe()...');
        const me = await this._withTimeout(this.bot.getMe(), 15000);
        log.info({
          msg: '✓ Bot Manager connected',
          botUsername: me.username,
          botId: me.id,
        });

        // Set bot commands
        try {
          await this._withTimeout(this.bot.setMyCommands([
            { command: 'menu', description: '🏠 منوی اصلی' },
            { command: 'status', description: '📊 وضعیت ربات' },
            { command: 'accounts', description: '📋 لیست اکانت‌ها' },
            { command: 'add', description: '➕ افزودن اکانت' },
            { command: 'remove', description: '➖ حذف اکانت' },
            { command: 'poll', description: '🔍 چک فوری' },
            { command: 'stats', description: '📈 آمار امروز' },
            { command: 'recent', description: '📋 آخرین آیتم‌ها' },
            { command: 'retry', description: '🔄 تلاش مجدد' },
            { command: 'cleanup', description: '🧹 پاکسازی' },
            { command: 'help', description: '❓ راهنما' },
          ]), 15000);
          log.info('Bot commands set');
        } catch (e) {
          log.warn({ msg: 'Could not set bot commands', error: e.message });
        }

        // Notify admins — فقط در اینجا ارسال میشه (نه در index.js)
        try {
          await this._notifyAdmins(
            `🤖 <b>ربات مدیریت راه‌اندازی شد</b>\n\n` +
            `🤖 ربات: @${me.username}\n` +
            `🆔 آیدی: <code>${me.id}</code>\n\n` +
            `✅ تلگرام: ${tgClient.isReady() ? 'متصل' : 'در حال اتصال...'}\n` +
            `📸 اینستاگرام: ${igClient.isLoggedIn ? 'متصل' : 'قطع'}\n` +
            `📊 اکانت‌های مانیتور: ${config.monitoring.targetAccounts.length}\n\n` +
            `برای دیدن منوی اصلی: /menu`
          );
        } catch (e) {
          log.warn({ msg: 'Could not notify admins', error: e.message });
        }
      } catch (e) {
        log.warn({ msg: 'Could not get bot info (will continue anyway)', error: e.message });
        this.lastStartError = `getMe failed: ${e.message}`;
        this.lastStartErrorAt = new Date().toISOString();
      }

    } catch (e) {
      log.error({ msg: 'Bot Manager failed to start', error: e.message, stack: e.stack });
      this.lastStartError = e.message;
      this.lastStartErrorAt = new Date().toISOString();
    }
  }

  /**
   * Helper: add timeout to a promise
   */
  async _withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
      ),
    ]);
  }

  /**
   * Register all command handlers
   */
  _registerHandlers() {
    if (!this.bot) return;

    this.bot.on('message', async (msg) => {
      try {
        await this._handleMessage(msg);
      } catch (e) {
        log.error({ msg: 'Message handler error', error: e.message, stack: e.stack });
      }
    });

    this.bot.on('callback_query', async (query) => {
      try {
        await this._handleCallbackQuery(query);
      } catch (e) {
        log.error({ msg: 'Callback query handler error', error: e.message });
      }
    });
  }

  /**
   * Handle incoming messages
   */
  async _handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = (msg.text || '').trim();

    // Check for conversation state (e.g., waiting for username after /add)
    const state = this._userStates.get(userId);
    if (state && !text.startsWith('/')) {
      this._userStates.delete(userId);

      if (state.action === 'add_account') {
        await this._cmdAdd(chatId, [text]);
        return;
      }
      if (state.action === 'set_channel') {
        await this._cmdSetChannel(chatId, [text]);
        return;
      }
    }

    // Only handle commands
    if (!text.startsWith('/')) return;

    const parts = text.slice(1).split(/\s+/);
    const fullCmd = parts[0].toLowerCase();
    const cmd = fullCmd.split('@')[0];
    const args = parts.slice(1);

    log.info({ msg: 'Command received', cmd, args, userId, chatId });

    if (!this.isAdmin(userId)) {
      await this._sendMessage(chatId, '⛔️ شما اجازه استفاده از این ربات را ندارید.\n\nبرای دریافت دسترسی، آیدی عددی شما باید در `ADMIN_IDS` تنظیم شود.', { parse_mode: 'Markdown' });
      return;
    }

    const handlers = {
      'start': () => this._cmdStart(chatId, args),
      'help': () => this._cmdStart(chatId, args),
      'menu': () => this._cmdMenu(chatId, args),
      'status': () => this._cmdStatus(chatId, args),
      'accounts': () => this._cmdAccounts(chatId, args),
      'add': () => this._cmdAdd(chatId, args),
      'remove': () => this._cmdRemove(chatId, args),
      'pause': () => this._cmdPause(chatId, args),
      'resume': () => this._cmdResume(chatId, args),
      'pauseall': () => this._cmdPauseAll(chatId, args),
      'resumeall': () => this._cmdResumeAll(chatId, args),
      'channel': () => this._cmdChannel(chatId, args),
      'setchannel': () => this._cmdSetChannel(chatId, args),
      'poll': () => this._cmdPoll(chatId, args),
      'stats': () => this._cmdStats(chatId, args),
      'recent': () => this._cmdRecent(chatId, args),
      'retry': () => this._cmdRetry(chatId, args),
      'cleanup': () => this._cmdCleanup(chatId, args),
      'reset': () => this._cmdReset(chatId, args),
      'resetall': () => this._cmdResetAll(chatId, args),
      'restart': () => this._cmdRestart(chatId, args),
      'debug': () => this._cmdDebug(chatId, args),
      'logs': () => this._cmdLogs(chatId, args),
      'findproxy': () => this._cmdFindProxy(chatId, args),
      'cancel': () => this._cmdCancel(chatId, args),
      'id': () => this._cmdId(chatId, msg.from),
    };

    const handler = handlers[cmd];
    if (!handler) {
      await this._sendMessage(chatId, `❓ دستور ناشناخته: /${cmd}\n\nبرای دیدن لیست دستورات: /help`);
      return;
    }

    const lockKey = `${userId}:${cmd}`;
    if (this._commandQueue.has(lockKey)) {
      await this._sendMessage(chatId, '⏳ در حال اجرای دستور قبلی شماست. لطفاً صبر کنید...');
      return;
    }

    this._commandQueue.set(lockKey, true);
    try {
      await handler();
    } catch (e) {
      log.error({ msg: 'Command handler error', cmd, error: e.message, stack: e.stack });
      await this._sendMessage(chatId, `❌ خطا در اجرای دستور:\n\n<code>${this._escapeHtml(e.message)}</code>`);
    } finally {
      this._commandQueue.delete(lockKey);
    }
  }

  /**
   * Handle callback queries (inline button clicks)
   */
  async _handleCallbackQuery(query) {
    const chatId = query.message.chat.id;
    const userId = query.from.id.toString();
    const data = query.data;

    if (!this.isAdmin(userId)) {
      await this.bot.answerCallbackQuery(query.id, { text: '⛔️ Unauthorized' });
      return;
    }

    await this.bot.answerCallbackQuery(query.id);

    log.info({ msg: 'Callback query', data, userId });

    // Handle callback data
    if (data === 'menu') {
      await this._cmdMenu(chatId, []);
    } else if (data === 'status') {
      await this._cmdStatus(chatId, []);
    } else if (data === 'accounts') {
      await this._cmdAccounts(chatId, []);
    } else if (data === 'stats') {
      await this._cmdStats(chatId, []);
    } else if (data === 'recent') {
      await this._cmdRecent(chatId, []);
    } else if (data === 'help') {
      await this._cmdStart(chatId, []);
    } else if (data === 'retry') {
      await this._cmdRetry(chatId, []);
    } else if (data === 'cleanup') {
      await this._cmdCleanup(chatId, []);
    } else if (data === 'pauseall') {
      await this._cmdPauseAll(chatId, []);
    } else if (data === 'resumeall') {
      await this._cmdResumeAll(chatId, []);
    } else if (data === 'restart') {
      await this._cmdRestart(chatId, []);
    } else if (data === 'debug') {
      await this._cmdDebug(chatId, []);
    } else if (data === 'logs') {
      await this._cmdLogs(chatId, []);
    } else if (data === 'findproxy') {
      await this._cmdFindProxy(chatId, []);
    } else if (data === 'add_account') {
      // Start conversation for adding account
      this._userStates.set(userId, { action: 'add_account' });
      await this._sendMessage(chatId,
        '➕ <b>افزودن اکانت جدید</b>\n\n' +
        'نام کاربری اکانت اینستاگرام رو بفرستید (بدون @):\n\n' +
        '<i>مثال: cristiano</i>\n\n' +
        'برای لغو: /cancel'
      );
    } else if (data === 'set_channel') {
      this._userStates.set(userId, { action: 'set_channel' });
      await this._sendMessage(chatId,
        '📺 <b>تغییر کانال مقصد</b>\n\n' +
        'آیدی عددی کانال یا یوزرنیم اون رو بفرستید:\n\n' +
        '<i>مثال‌ها:</i>\n' +
        '<code>-1001234567890</code>\n' +
        '<code>@mychannel</code>\n\n' +
        'برای لغو: /cancel'
      );
    } else if (data.startsWith('poll:')) {
      const username = data.split(':')[1];
      await this._cmdPoll(chatId, [username]);
    } else if (data.startsWith('pause:')) {
      const username = data.split(':')[1];
      await this._cmdPause(chatId, [username]);
    } else if (data.startsWith('resume:')) {
      const username = data.split(':')[1];
      await this._cmdResume(chatId, [username]);
    } else if (data.startsWith('remove:')) {
      const username = data.split(':')[1];
      await this._cmdRemove(chatId, [username]);
    } else if (data.startsWith('reset:')) {
      const username = data.split(':')[1];
      await this._cmdReset(chatId, [username]);
    } else if (data.startsWith('account:')) {
      // Show account details
      const username = data.split(':')[1];
      await this._showAccountDetails(chatId, username);
    }
  }

  /**
   * Send a message
   */
  async _sendMessage(chatId, text, options = {}) {
    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: options.disable_web_page_preview ?? true,
        ...options,
      });
    } catch (e) {
      log.error({ msg: 'Failed to send bot manager message', error: e.message });

      // Try without HTML if parsing failed
      if (e.message.includes('can\'t parse') || e.message.includes('ENTITY')) {
        try {
          await this.bot.sendMessage(chatId, text, {
            disable_web_page_preview: true,
            ...options,
            parse_mode: undefined,
          });
        } catch (e2) {
          log.error({ msg: 'Failed to send plain message', error: e2.message });
        }
      }
    }
  }

  /**
   * Notify all admins
   */
  async _notifyAdmins(text) {
    if (this.adminIds.length === 0) return;

    for (const adminId of this.adminIds) {
      try {
        await this._sendMessage(adminId, text);
      } catch (e) {
        log.warn({ msg: 'Could not notify admin', adminId, error: e.message });
      }
    }
  }

  /**
   * Escape HTML
   */
  _escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ============================================
  // Main menu with glass buttons (inline keyboard)
  // ============================================

  async _cmdMenu(chatId, args) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📊 وضعیت', callback_data: 'status' },
          { text: '📋 اکانت‌ها', callback_data: 'accounts' },
        ],
        [
          { text: '📈 آمار', callback_data: 'stats' },
          { text: '📋 آخرین آیتم‌ها', callback_data: 'recent' },
        ],
        [
          { text: '➕ افزودن اکانت', callback_data: 'add_account' },
          { text: '📺 تنظیم کانال', callback_data: 'set_channel' },
        ],
        [
          { text: '🔄 تلاش مجدد', callback_data: 'retry' },
          { text: '🧹 پاکسازی', callback_data: 'cleanup' },
        ],
        [
          { text: '🔍 پیدا کردن پروکسی', callback_data: 'findproxy' },
          { text: '🔧 دیباگ', callback_data: 'debug' },
        ],
        [
          { text: '📜 لاگ‌ها', callback_data: 'logs' },
          { text: '❓ راهنما', callback_data: 'help' },
        ],
      ],
    };

    try {
      await this.bot.sendMessage(chatId,
        '🏠 <b>منوی اصلی ربات مدیریت</b>\n\n' +
        'یکی از گزینه‌ها رو انتخاب کنید:',
        {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }
      );
    } catch (e) {
      log.error({ msg: 'Failed to send menu', error: e.message });
    }
  }

  // ============================================
  // Command Handlers
  // ============================================

  async _cmdStart(chatId, args) {
    const text = `🤖 <b>ربات مدیریت مانیتور اینستاگرام</b>

سلام! این ربات به شما امکان کنترل کامل ربات مانیتور اینستاگرام رو میده.

🏠 <b>منوی اصلی:</b> /menu
برای دسترسی سریع به تمام امکانات با دکمه‌های شیشه‌ای.

📋 <b>دستورات:</b>

📊 <b>وضعیت و آمار:</b>
/status — وضعیت کلی ربات
/accounts — لیست اکانت‌های مانیتور شده
/stats — آمار امروز
/recent — آخرین آیتم‌های ارسال شده
/debug — اطلاعات دیباگ
/logs — آخرین لاگ‌ها

⚙️ <b>مدیریت اکانت‌ها:</b>
/add &lt;username&gt; — افزودن اکانت
/remove &lt;username&gt; — حذف اکانت
/pause &lt;username&gt; — توقف موقت
/resume &lt;username&gt; — از سرگیری
/pauseall — توقف همه
/resumeall — از سرگیری همه
/reset &lt;username&gt; — ریست آخرین پست دیده شده
/resetall — ریست همه اکانت‌ها

🔧 <b>کنترل:</b>
/poll &lt;username&gt; — چک فوری اکانت
/retry — تلاش مجدد آیتم‌های ناموفق
/cleanup — پاکسازی آیتم‌های ناموفق قدیمی
/channel — نمایش کانال مقصد
/setchannel &lt;id&gt; — تغییر کانال مقصد
/restart — ریستارت ربات

ℹ️ <b>اطلاعات:</b>
/id — دریافت آیدی عددی شما

برای دیدن منوی اصلی: /menu`;

    await this._sendMessage(chatId, text);
  }

  async _cmdStatus(chatId, args) {
    const igInfo = igClient.getDebugInfo ? igClient.getDebugInfo() : {};
    const tgReady = tgClient.isReady();
    const proxyStats = proxyManager.getStats ? proxyManager.getStats() : null;
    const queueStats = sendWorker.getStats ? sendWorker.getStats() : null;
    const accountCount = TrackedAccountsRepository.countActive();

    const text = `📊 <b>وضعیت ربات</b>

🤖 <b>سرویس‌ها:</b>
• اینستاگرام: ${igClient.isLoggedIn ? '✅ متصل' : '❌ قطع'}
• تلگرام (User Session): ${tgReady ? '✅ متصل' : '❌ قطع'}
• ربات مدیریت: ${this.isRunning ? '✅ فعال' : '❌ غیرفعال'}
• پروکسی: ${proxyStats?.isEnabled ? `✅ فعال (${proxyStats.total} پروکسی)` : '❌ غیرفعال'}

📋 <b>صف ارسال:</b>
• در انتظار: ${queueStats?.queueSize || 0}
• در حال پردازش: ${queueStats?.active || 0}
• ارسال شده: ${queueStats?.processed || 0}
• ناموفق: ${queueStats?.failed || 0}

👤 <b>اکانت‌های مانیتور شده:</b> ${accountCount}

🍪 <b>سشن اینستاگرام:</b>
• فایل: ${igInfo.sessionFile?.exists ? '✅ موجود' : '❌ ناموجود'}
• کوکی‌ها: ${igInfo.sessionInfo?.cookieCount || 0}
• کاربر: @${igInfo.sessionInfo?.username || 'نامشخص'}
• آیدی: <code>${igInfo.sessionInfo?.dsUserId || 'نامشخص'}</code>

🌐 <b>مرورگر Playwright:</b>
• وضعیت: ${igInfo.browser?.isLaunched ? '✅ اجرا شده' : '❌ بسته'}
• آخرین فعالیت: ${igInfo.browser?.lastActivity || 'نامشخص'}

⏱ <b>زمان فعال:</b> ${Math.floor(process.uptime())} ثانیه`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 به‌روزرسانی', callback_data: 'status' },
          { text: '📋 اکانت‌ها', callback_data: 'accounts' },
        ],
        [
          { text: '🏠 منو', callback_data: 'menu' },
        ],
      ],
    };

    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e) {
      await this._sendMessage(chatId, text);
    }
  }

  async _cmdAccounts(chatId, args) {
    const accounts = TrackedAccountsRepository.getAll();

    if (accounts.length === 0) {
      const keyboard = {
        inline_keyboard: [
          [{ text: '➕ افزودن اکانت', callback_data: 'add_account' }],
          [{ text: '🏠 منو', callback_data: 'menu' }],
        ],
      };

      try {
        await this.bot.sendMessage(chatId,
          '📋 هیچ اکانتی برای مانیتور اضافه نشده.\n\nبرای افزودن کلیک کنید:',
          { parse_mode: 'HTML', reply_markup: keyboard }
        );
      } catch {
        await this._sendMessage(chatId, '📋 هیچ اکانتی برای مانیتور اضافه نشده.\n\nبرای افزودن: /add &lt;username&gt;');
      }
      return;
    }

    const lines = ['📋 <b>اکانت‌های مانیتور شده:</b>', ''];

    for (const acc of accounts) {
      const status = acc.is_active ? '✅' : '⏸';
      const verified = acc.is_verified ? ' ✓' : '';
      const lastError = acc.last_error ? ` ⚠️ ${this._escapeHtml(acc.last_error.slice(0, 30))}` : '';
      const lastPostTime = acc.last_post_checked_at
        ? messageFormatter.formatIranTime(acc.last_post_checked_at)
        : 'هرگز';

      lines.push(`${status} <b>@${this._escapeHtml(acc.username)}</b>${verified}${lastError}`);
      lines.push(`   آخرین چک: ${lastPostTime}`);
      if (acc.last_post_pk) {
        lines.push(`   آخرین پست: <code>${this._escapeHtml(acc.last_post_pk)}</code>`);
      }
      lines.push('');
    }

    // Add inline buttons for each account
    const inlineKeyboard = accounts.map(acc => [
      {
        text: `${acc.is_active ? '⏸ توقف' : '▶️ ادامه'} @${acc.username}`,
        callback_data: acc.is_active ? `pause:${acc.username}` : `resume:${acc.username}`,
      },
      {
        text: `🔍 چک`,
        callback_data: `poll:${acc.username}`,
      },
      {
        text: `📊 جزئیات`,
        callback_data: `account:${acc.username}`,
      },
    ]);

    inlineKeyboard.push([
      { text: '➕ افزودن', callback_data: 'add_account' },
      { text: '🏠 منو', callback_data: 'menu' },
    ]);

    try {
      await this.bot.sendMessage(chatId, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } catch (e) {
      await this._sendMessage(chatId, lines.join('\n'));
    }
  }

  /**
   * Show account details
   */
  async _showAccountDetails(chatId, username) {
    const account = TrackedAccountsRepository.getByUsername(username);

    if (!account) {
      await this._sendMessage(chatId, `❌ اکانت @${username} پیدا نشد.`);
      return;
    }

    const lastPostTime = account.last_post_checked_at
      ? messageFormatter.formatIranTime(account.last_post_checked_at)
      : 'هرگز';
    const lastStoryTime = account.last_story_checked_at
      ? messageFormatter.formatIranTime(account.last_story_checked_at)
      : 'هرگز';

    const text = `📊 <b>جزئیات اکانت</b>

👤 <b>نام کاربری:</b> @${this._escapeHtml(account.username)}
🆔 <b>PK:</b> <code>${this._escapeHtml(account.pk || 'نامشخص')}</code>
📛 <b>نام:</b> ${this._escapeHtml(account.full_name || 'نامشخص')}
🔒 <b>خصوصی:</b> ${account.is_private ? 'بله' : 'خیر'}
✅ <b>تأیید شده:</b> ${account.is_verified ? 'بله' : 'خیر'}
📊 <b>وضعیت:</b> ${account.is_active ? '✅ فعال' : '⏸ متوقف'}

📸 <b>آخرین پست:</b>
• PK: <code>${this._escapeHtml(account.last_post_pk || 'ندارد')}</code>
• چک شده: ${lastPostTime}

📖 <b>آخرین استوری:</b>
• PK: <code>${this._escapeHtml(account.last_story_pk || 'ندارد')}</code>
• چک شده: ${lastStoryTime}

⚠️ <b>تعداد خطا:</b> ${account.error_count}
${account.last_error ? `📝 <b>آخرین خطا:</b> <code>${this._escapeHtml(account.last_error.slice(0, 100))}</code>` : ''}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: account.is_active ? '⏸ توقف' : '▶️ ادامه', callback_data: account.is_active ? `pause:${username}` : `resume:${username}` },
          { text: '🔍 چک فوری', callback_data: `poll:${username}` },
        ],
        [
          { text: '🔄 ریست آخرین پست', callback_data: `reset:${username}` },
          { text: '🗑 حذف', callback_data: `remove:${username}` },
        ],
        [
          { text: '🔙 لیست اکانت‌ها', callback_data: 'accounts' },
          { text: '🏠 منو', callback_data: 'menu' },
        ],
      ],
    };

    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e) {
      await this._sendMessage(chatId, text);
    }
  }

  async _cmdAdd(chatId, args) {
    if (args.length === 0) {
      // Start conversation
      this._userStates.set(chatId.toString(), { action: 'add_account' });
      await this._sendMessage(chatId,
        '➕ <b>افزودن اکانت جدید</b>\n\n' +
        'نام کاربری اکانت اینستاگرام رو بفرستید (بدون @):\n\n' +
        '<i>مثال: cristiano</i>\n\n' +
        'برای لغو: /cancel'
      );
      return;
    }

    const username = args[0].replace('@', '').toLowerCase();

    try {
      TrackedAccountsRepository.add(username);
      log.info({ msg: 'Account added via bot', username });

      const keyboard = {
        inline_keyboard: [
          [
            { text: '🔍 چک فوری', callback_data: `poll:${username}` },
            { text: '📋 لیست اکانت‌ها', callback_data: 'accounts' },
          ],
          [{ text: '🏠 منو', callback_data: 'menu' }],
        ],
      };

      try {
        await this.bot.sendMessage(chatId,
          `✅ اکانت @${username} به لیست مانیتور اضافه شد.\n\n` +
          `ربات به‌زودی شروع به چک کردن پست‌های جدید می‌کنه.`,
          { parse_mode: 'HTML', reply_markup: keyboard }
        );
      } catch {
        await this._sendMessage(chatId, `✅ اکانت @${username} اضافه شد.`);
      }
    } catch (e) {
      await this._sendMessage(chatId, `❌ خطا در افزودن اکانت:\n<code>${this._escapeHtml(e.message)}</code>`);
    }
  }

  async _cmdRemove(chatId, args) {
    if (args.length === 0) {
      await this._sendMessage(chatId, '❌ استفاده: /remove &lt;username&gt;');
      return;
    }

    const username = args[0].replace('@', '').toLowerCase();

    try {
      TrackedAccountsRepository.remove(username);
      log.info({ msg: 'Account removed via bot', username });

      const keyboard = {
        inline_keyboard: [
          [{ text: '📋 لیست اکانت‌ها', callback_data: 'accounts' }],
          [{ text: '🏠 منو', callback_data: 'menu' }],
        ],
      };

      try {
        await this.bot.sendMessage(chatId,
          `✅ اکانت @${username} از لیست مانیتور حذف شد.`,
          { parse_mode: 'HTML', reply_markup: keyboard }
        );
      } catch {
        await this._sendMessage(chatId, `✅ اکانت @${username} حذف شد.`);
      }
    } catch (e) {
      await this._sendMessage(chatId, `❌ خطا:\n<code>${this._escapeHtml(e.message)}</code>`);
    }
  }

  async _cmdPause(chatId, args) {
    if (args.length === 0) {
      await this._sendMessage(chatId, '❌ استفاده: /pause &lt;username&gt;');
      return;
    }

    const username = args[0].replace('@', '').toLowerCase();

    try {
      TrackedAccountsRepository.setActive(username, false);
      await this._sendMessage(chatId, `⏸ مانیتور اکانت @${username} متوقف شد.\n\nبرای از سرگیری: /resume ${username}`);
    } catch (e) {
      await this._sendMessage(chatId, `❌ خطا:\n<code>${this._escapeHtml(e.message)}</code>`);
    }
  }

  async _cmdResume(chatId, args) {
    if (args.length === 0) {
      await this._sendMessage(chatId, '❌ استفاده: /resume &lt;username&gt;');
      return;
    }

    const username = args[0].replace('@', '').toLowerCase();

    try {
      TrackedAccountsRepository.setActive(username, true);
      TrackedAccountsRepository.resetErrors(username);
      await this._sendMessage(chatId, `▶️ مانیتور اکانت @${username} از سر گرفته شد.`);
    } catch (e) {
      await this._sendMessage(chatId, `❌ خطا:\n<code>${this._escapeHtml(e.message)}</code>`);
    }
  }

  async _cmdPauseAll(chatId, args) {
    const accounts = TrackedAccountsRepository.getAll();
    for (const acc of accounts) {
      TrackedAccountsRepository.setActive(acc.username, false);
    }
    await this._sendMessage(chatId, `⏸ تمام اکانت‌ها (${accounts.length} عدد) متوقف شدند.`);
  }

  async _cmdResumeAll(chatId, args) {
    const accounts = TrackedAccountsRepository.getAll();
    for (const acc of accounts) {
      TrackedAccountsRepository.setActive(acc.username, true);
      TrackedAccountsRepository.resetErrors(acc.username);
    }
    await this._sendMessage(chatId, `▶️ تمام اکانت‌ها (${accounts.length} عدد) از سر گرفته شدند.`);
  }

  async _cmdReset(chatId, args) {
    if (args.length === 0) {
      await this._sendMessage(chatId, '❌ استفاده: /reset &lt;username&gt;\n\nاین دستور آخرین پست دیده شده رو پاک می‌کنه تا ربات دوباره همه پست‌ها رو ببینه.');
      return;
    }

    const username = args[0].replace('@', '').toLowerCase();

    try {
      SentItemsRepository.resetLastPostPk(username);
      log.info({ msg: 'Reset last_post_pk via bot', username });

      await this._sendMessage(chatId,
        `🔄 ریست شد: @${username}\n\n` +
        `آخرین پست دیده شده پاک شد. ربات دوباره همه پست‌های اخیر رو fetch می‌کنه.`
      );
    } catch (e) {
      await this._sendMessage(chatId, `❌ خطا:\n<code>${this._escapeHtml(e.message)}</code>`);
    }
  }

  async _cmdResetAll(chatId, args) {
    try {
      SentItemsRepository.resetAllLastPostPks();
      log.info({ msg: 'Reset all last_post_pk via bot' });

      await this._sendMessage(chatId,
        `🔄 ریست همه اکانت‌ها انجام شد.\n\n` +
        `ربات دوباره همه پست‌های اخیر رو fetch می‌کنه.`
      );
    } catch (e) {
      await this._sendMessage(chatId, `❌ خطا:\n<code>${this._escapeHtml(e.message)}</code>`);
    }
  }

  async _cmdCleanup(chatId, args) {
    try {
      const result = SentItemsRepository.cleanupFailed();
      log.info({ msg: 'Cleanup triggered via bot', deleted: result.deleted });

      const keyboard = {
        inline_keyboard: [
          [{ text: '🔄 تلاش مجدد بقیه', callback_data: 'retry' }],
          [{ text: '🏠 منو', callback_data: 'menu' }],
        ],
      };

      try {
        await this.bot.sendMessage(chatId,
          `🧹 <b>پاکسازی انجام شد</b>\n\n` +
          `تعداد پاک شده: ${result.deleted} آیتم ناموفق/در انتظار`,
          { parse_mode: 'HTML', reply_markup: keyboard }
        );
      } catch {
        await this._sendMessage(chatId, `🧹 ${result.deleted} آیتم پاک شد.`);
      }
    } catch (e) {
      await this._sendMessage(chatId, `❌ خطا:\n<code>${this._escapeHtml(e.message)}</code>`);
    }
  }

  async _cmdChannel(chatId, args) {
    const channelId = config.telegram.channelId;
    const channelUsername = config.telegram.channelUsername;

    const text = `📺 <b>کانال مقصد فعلی:</b>

• Channel ID: <code>${this._escapeHtml(channelId || 'تنظیم نشده')}</code>
• Username: ${channelUsername ? '@' + this._escapeHtml(channelUsername) : 'تنظیم نشده'}

برای تغییر: /setchannel &lt;new_id_or_username&gt;`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '📺 تغییر کانال', callback_data: 'set_channel' }],
        [{ text: '🏠 منو', callback_data: 'menu' }],
      ],
    };

    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {
      await this._sendMessage(chatId, text);
    }
  }

  async _cmdSetChannel(chatId, args) {
    if (args.length === 0) {
      this._userStates.set(chatId.toString(), { action: 'set_channel' });
      await this._sendMessage(chatId,
        '📺 <b>تغییر کانال مقصد</b>\n\n' +
        'آیدی عددی کانال یا یوزرنیم اون رو بفرستید:\n\n' +
        '<i>مثال‌ها:</i>\n' +
        '<code>-1001234567890</code>\n' +
        '<code>@mychannel</code>\n\n' +
        'برای لغو: /cancel'
      );
      return;
    }

    const newChannel = args[0];

    if (newChannel.startsWith('-') || newChannel.match(/^\d+$/)) {
      process.env.TG_CHANNEL_ID = newChannel;
      process.env.TG_CHANNEL_USERNAME = '';
    } else {
      process.env.TG_CHANNEL_USERNAME = newChannel.replace('@', '');
      process.env.TG_CHANNEL_ID = '';
    }

    if (tgClient._cachedChannelEntity) {
      tgClient._cachedChannelEntity = null;
    }

    config.telegram.channelId = process.env.TG_CHANNEL_ID;
    config.telegram.channelUsername = process.env.TG_CHANNEL_USERNAME;

    log.info({ msg: 'Channel changed via bot', newChannel });

    await this._sendMessage(chatId,
      `✅ کانال مقصد تغییر کرد به: <code>${this._escapeHtml(newChannel)}</code>\n\n` +
      `⚠️ توجه: این تغییر فقط برای این session اعمال شده. ` +
      `برای دائمی کردن، متغیر محیطی TG_CHANNEL_ID رو در Railway آپدیت کنید.`
    );
  }

  async _cmdPoll(chatId, args) {
    if (args.length === 0) {
      await this._sendMessage(chatId, '❌ استفاده: /poll &lt;username&gt;');
      return;
    }

    const username = args[0].replace('@', '').toLowerCase();

    await this._sendMessage(chatId, `🔍 شروع چک دستی اکانت @${username}...\n\nاین ممکنه چند ثانیه طول بکشه.`);

    try {
      const account = TrackedAccountsRepository.getByUsername(username);
      if (!account) {
        await this._sendMessage(chatId, `❌ اکانت @${username} در لیست مانیتور نیست.\n\nبرای افزودن: /add ${username}`);
        return;
      }

      await this._sendMessage(chatId, `⏳ در حال دریافت اطلاعات کاربر...`);

      const userInfo = await igClient.getUserByUsername(username);

      await this._sendMessage(chatId,
        `✅ اطلاعات کاربر دریافت شد.\n` +
        `PK: <code>${userInfo.pk}</code>\n` +
        `فالوور: ${userInfo.followerCount || 'نامشخص'}\n\n` +
        `⏳ در حال دریافت پست‌ها...`
      );

      const posts = await igClient.getUserFeed(username, { limit: 5 });

      let storiesCount = 0;
      try {
        const stories = await igClient.getUserStories(username);
        storiesCount = stories.length;
      } catch (e) {}

      const text = `✅ <b>چک کامل شد</b>

👤 <b>کاربر:</b> @${username}
🆔 <b>PK:</b> <code>${userInfo.pk}</code>
👥 <b>فالوور:</b> ${userInfo.followerCount || 'نامشخص'}
🔒 <b>خصوصی:</b> ${userInfo.isPrivate ? 'بله' : 'خیر'}

📸 <b>پست‌های اخیر (${posts.length}):</b>
${posts.slice(0, 5).map((p, i) => `   ${i+1}. <code>${p.shortcode}</code> — ${p.type}${p.caption ? ' 📝' : ''}`).join('\n')}

📖 <b>استوری‌های فعال:</b> ${storiesCount}

آخرین پست در DB: <code>${account.last_post_pk || 'هیچ'}</code>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: '🔄 ریست و چک مجدد', callback_data: `reset:${username}` },
            { text: '🔍 چک مجدد', callback_data: `poll:${username}` },
          ],
          [{ text: '🏠 منو', callback_data: 'menu' }],
        ],
      };

      try {
        await this.bot.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch {
        await this._sendMessage(chatId, text);
      }

      log.info({ msg: 'Manual poll triggered via bot', username });
    } catch (e) {
      await this._sendMessage(chatId, `❌ خطا در چک اکانت:\n<code>${this._escapeHtml(e.message)}</code>`);
    }
  }

  async _cmdStats(chatId, args) {
    const stats = SentItemsRepository.getTodayStats();

    const text = `📊 <b>آمار امروز</b>

✅ <b>ارسال شده:</b> ${stats.sent || 0}
📸 <b>پست‌ها:</b> ${stats.posts || 0}
📖 <b>استوری‌ها:</b> ${stats.stories || 0}
🎬 <b>ریلزها:</b> ${stats.reels || 0}
❌ <b>ناموفق:</b> ${stats.failed || 0}
⏭ <b>نادیده گرفته شده:</b> ${stats.skipped || 0}
📋 <b>در انتظار:</b> ${stats.pending || 0}

مجموع کل: ${stats.total || 0}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 به‌روزرسانی', callback_data: 'stats' },
          { text: '📋 آخرین آیتم‌ها', callback_data: 'recent' },
        ],
        [{ text: '🏠 منو', callback_data: 'menu' }],
      ],
    };

    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {
      await this._sendMessage(chatId, text);
    }
  }

  async _cmdRecent(chatId, args) {
    const limit = parseInt(args[0] || '10', 10);
    const recent = SentItemsRepository.getRecent(limit);

    if (recent.length === 0) {
      await this._sendMessage(chatId, '📋 هنوز هیچ آیتمی ارسال نشده.');
      return;
    }

    const lines = [`📋 <b>آخرین ${recent.length} آیتم:</b>`, ''];

    for (const item of recent) {
      const status = item.status === 'sent' ? '✅' :
                     item.status === 'failed' ? '❌' :
                     item.status === 'pending' ? '⏳' :
                     item.status === 'processing' ? '🔄' : '⏭';

      const time = item.created_at ? messageFormatter.formatIranTime(item.created_at) : '';
      const shortShortcode = item.shortcode ? item.shortcode.slice(0, 12) : '';

      lines.push(`${status} <code>${shortShortcode}</code> — @${this._escapeHtml(item.account_username)} [${item.media_type}] ${time}`);
      if (item.error) {
        lines.push(`   ⚠️ ${this._escapeHtml(item.error.slice(0, 60))}`);
      }
    }

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 تلاش مجدد ناموفق‌ها', callback_data: 'retry' },
          { text: '🧹 پاکسازی ناموفق‌ها', callback_data: 'cleanup' },
        ],
        [{ text: '🏠 منو', callback_data: 'menu' }],
      ],
    };

    try {
      await this.bot.sendMessage(chatId, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {
      await this._sendMessage(chatId, lines.join('\n'));
    }
  }

  async _cmdRetry(chatId, args) {
    const failed = SentItemsRepository.getFailed(10, 3);

    if (failed.length === 0) {
      await this._sendMessage(chatId, '✅ هیچ آیتم ناموفقی برای تلاش مجدد وجود ندارد.');
      return;
    }

    for (const item of failed) {
      SentItemsRepository.updateStatus(item.id, 'pending');
    }
    const enqueued = await sendWorker.recoverRows(failed);

    log.info({ msg: 'Retry triggered via bot', count: failed.length, enqueued });

    await this._sendMessage(chatId, `🔄 ${failed.length} آیتم ناموفق به حالت «در انتظار» برگردانده شد و ${enqueued} آیتم وارد صف شد.`);
  }

  async _cmdRestart(chatId, args) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ بله، ریستارت کن', callback_data: 'restart_confirm' },
          { text: '❌ لغو', callback_data: 'menu' },
        ],
      ],
    };

    await this._sendMessage(chatId,
      '⚠️ <b>تأیید ریستارت</b>\n\n' +
      'آیا مطمئن هستید که می‌خواهید ربات را ریستارت کنید؟\n\n' +
      'این عملیات ۱۰-۲۰ ثانیه طول می‌کشد.',
    );

    // For simplicity, just restart immediately
    await this._sendMessage(chatId, '🔄 در حال ریستارت ربات...');

    log.info({ msg: 'Restart triggered via bot' });

    setTimeout(() => {
      process.exit(0);
    }, 2000);
  }

  async _cmdDebug(chatId, args) {
    const igInfo = igClient.getDebugInfo ? igClient.getDebugInfo() : {};
    const proxyStats = proxyManager.getStats ? proxyManager.getStats() : null;

    const text = `🔧 <b>اطلاعات دیباگ</b>

📋 <b>کانفیگ:</b>
• IG Username: ${this._escapeHtml(config.instagram.username)}
• Target Accounts: ${this._escapeHtml(config.monitoring.targetAccounts.join(', '))}
• Channel ID: <code>${this._escapeHtml(config.telegram.channelId || 'none')}</code>
• Channel Username: ${this._escapeHtml(config.telegram.channelUsername || 'none')}
• TG_PROXY: ${process.env.TG_PROXY ? '✅ تنظیم شده' : '❌ خالی'}
• PROXY_MODE: ${config.proxy.mode}
• Admin IDs: ${this.adminIds.length > 0 ? this.adminIds.join(', ') : 'all (no restriction)'}

🍪 <b>سشن اینستاگرام:</b>
• فایل: ${igInfo.sessionFile?.exists ? '✅' : '❌'} <code>${this._escapeHtml(igInfo.sessionFile?.path || '')}</code>
• موجود: ${igInfo.sessionFile?.exists ? `بله (${igInfo.sessionFile.size} bytes)` : 'خیر'}
• کوکی‌ها: ${igInfo.sessionInfo?.cookieCount || 0}
• sessionid: ${igInfo.sessionInfo?.hasSessionId ? '✅' : '❌'}
• csrftoken: ${igInfo.sessionInfo?.hasCsrfToken ? '✅' : '❌'}
• ds_user_id: ${igInfo.sessionInfo?.hasDsUserId ? '✅' : '❌'}
• آخرین خطا: ${igInfo.lastError ? this._escapeHtml(igInfo.lastError) : 'ندارد'}

🌐 <b>مرورگر:</b>
• اجرا شده: ${igInfo.browser?.isLaunched ? '✅' : '❌'}
• آخرین فعالیت: ${igInfo.browser?.lastActivity || 'نامشخص'}

🌐 <b>پروکسی:</b>
• فعال: ${proxyStats?.isEnabled ? '✅' : '❌'}
• کل پروکسی‌ها: ${proxyStats?.total || 0}
• کارا: ${proxyStats?.working || 0}

⏱ <b>آپتایم:</b> ${Math.floor(process.uptime())} ثانیه
💾 <b>حافظه:</b> ${Math.floor(process.memoryUsage().rss / 1024 / 1024)} MB`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 به‌روزرسانی', callback_data: 'debug' },
          { text: '📜 لاگ‌ها', callback_data: 'logs' },
        ],
        [{ text: '🏠 منو', callback_data: 'menu' }],
      ],
    };

    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {
      await this._sendMessage(chatId, text);
    }
  }

  async _cmdLogs(chatId, args) {
    const limit = parseInt(args[0] || '20', 10);

    try {
      const { readFileSync, existsSync } = await import('fs');
      const { resolve } = await import('path');
      const logPath = resolve(process.cwd(), 'data', 'app.log');

      if (!existsSync(logPath)) {
        await this._sendMessage(chatId, '📜 فایل لاگ وجود ندارد.');
        return;
      }

      const content = readFileSync(logPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const lastLines = lines.slice(-limit);

      let text = `📜 <b>آخرین ${lastLines.length} لاگ:</b>\n\n<code>`;

      for (const line of lastLines) {
        const escaped = this._escapeHtml(line.slice(0, 200));
        text += escaped + '\n';
      }

      text += '</code>';

      // Telegram message limit is 4096 chars
      if (text.length > 4000) {
        text = text.slice(0, 4000) + '\n...</code>';
      }

      await this._sendMessage(chatId, text);
    } catch (e) {
      await this._sendMessage(chatId, `❌ خطا در خواندن لاگ‌ها:\n<code>${this._escapeHtml(e.message)}</code>`);
    }
  }

  /**
   * Find a working SOCKS5 proxy manually
   */
  async _cmdFindProxy(chatId, args) {
    await this._sendMessage(chatId,
      '🔍 <b>جستجوی پروکسی سالم</b>\n\n' +
      'در حال تست پروکسی‌های SOCKS5 از لیست TheSpeedX/PROXY-List...\n\n' +
      'این ممکنه ۱-۲ دقیقه طول بکشه.'
    );

    try {
      // Make sure proxyManager is initialized
      if (!proxyManager.isEnabled) {
        await this._sendMessage(chatId,
          '❌ پروکسی منیجر غیرفعاله.\n\n' +
          'برای فعال‌سازی:\n' +
          '<code>PROXY_MODE=list</code>'
        );
        return;
      }

      if (proxyManager.proxies.length === 0) {
        await this._sendMessage(chatId, '⏳ در حال بارگذاری لیست پروکسی...');
        await proxyManager.refreshList();
      }

      const stats = proxyManager.getStats();
      await this._sendMessage(chatId,
        `📊 <b>آمار پروکسی:</b>\n` +
        `• کل: ${stats.total}\n` +
        `• سالم: ${stats.working}\n` +
        `• ناموفق: ${stats.failed}\n\n` +
        `🔍 شروع تست پروکسی‌های SOCKS5...`
      );

      const result = await proxyManager.findWorkingSocks5Proxy({
        maxAttempts: 30,
        testUrl: 'https://telegram.org',
        timeout: 8000,
        onProgress: async (progress) => {
          // Send progress every 10 attempts
          if (progress.current % 10 === 0) {
            await this._sendMessage(chatId,
              `⏳ تست شده: ${progress.current}/${progress.total}`
            ).catch(() => {});
          }
        },
      });

      if (result) {
        const text = `✅ <b>پروکسی سالم پیدا شد!</b>

🌐 <b>آدرس:</b> <code>${result.proxy.host}:${result.proxy.port}</code>
🔒 <b>نوع:</b> SOCKS5
⚡️ <b>سرعت پاسخ:</b> ${result.responseTime}ms

برای استفاده از این پروکسی:
<code>TG_PROXY=socks5://${result.proxy.host}:${result.proxy.port}</code>

یا از حالت auto استفاده کنید:
<code>TG_PROXY=auto</code>`;

        const keyboard = {
          inline_keyboard: [
            [
              { text: '🔄 جستجوی مجدد', callback_data: 'findproxy' },
              { text: '🏠 منو', callback_data: 'menu' },
            ],
          ],
        };

        try {
          await this.bot.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } catch {
          await this._sendMessage(chatId, text);
        }
      } else {
        await this._sendMessage(chatId,
          '❌ <b>هیچ پروکسی سالمی پیدا نشد</b>\n\n' +
          '۳۰ پروکسی تست شد ولی هیچکدوم به تلگرام وصل نشد.\n\n' +
          'ممکنه به دلایل زیر باشه:\n' +
          '• همه پروکسی‌های رایگان از کار افتاده‌اند\n' +
          '• شبکه محدودیت داره\n' +
          '• تلگرام در منطقه شما مسدود شده\n\n' +
          'پیشنهاد: از یه پروکسی پولی استفاده کنید'
        );
      }
    } catch (e) {
      await this._sendMessage(chatId, `❌ خطا در جستجوی پروکسی:\n<code>${this._escapeHtml(e.message)}</code>`);
    }
  }

  async _cmdCancel(chatId, args) {
    this._userStates.delete(chatId.toString());
    await this._sendMessage(chatId, '✅ عملیات لغو شد.');
  }

  async _cmdId(chatId, from) {
    const text = `🆔 <b>اطلاعات شما</b>

• آیدی عددی: <code>${from.id}</code>
• نام: ${this._escapeHtml(from.first_name || '')} ${this._escapeHtml(from.last_name || '')}
• یوزرنیم: ${from.username ? '@' + this._escapeHtml(from.username) : 'ندارد'}
• زبان: ${from.language_code || 'نامشخص'}

برای اضافه کردن خودتون به ادمین‌ها:
\`ADMIN_IDS=${from.id}\``;

    try {
      await this.bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
      try {
        await this.bot.sendMessage(chatId, text.replace(/<[^>]+>/g, ''), { parse_mode: 'Markdown' });
      } catch {}
    }
  }

  /**
   * Stop the bot manager
   */
  stop() {
    if (this.bot) {
      try {
        this.bot.stopPolling();
      } catch {}
    }
    this.isRunning = false;
    log.info('Bot Manager stopped');
  }

  /**
   * Send notification to all admins (called from other modules)
   */
  async notifyAdmins(text) {
    return this._notifyAdmins(text);
  }
}

const botManager = new BotManager();
export default botManager;
