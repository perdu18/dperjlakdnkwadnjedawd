/**
 * index.js
 * نقطه ورود اصلی برنامه
 *
 * روند اجرا (با تقدم HTTP health server):
 *   1. مقداردهی اولیه کانفیگ
 *   2. راه‌اندازی HTTP health server (برای Railway healthcheck)
 *   3. راه‌اندازی دیتابیس
 *   4. راه‌اندازی Proxy Manager
 *   5. لاگین به Instagram (در پس‌زمینه)
 *   6. اتصال به Telegram (در پس‌زمینه)
 *   7. اضافه کردن اکانت‌های هدف به DB
 *   8. شروع polling workers
 *   9. مدیریت graceful shutdown
 *
 * نکته مهم: HTTP server اول راه می‌افته تا Railway healthcheck پاسخ بگیره،
 * حتی اگه اتصال به Instagram یا Telegram زمان ببره یا شکست بخوره.
 */

import http from 'http';
import cron from 'node-cron';

import { config, validate, init as initConfig } from './config/env.js';
import { initDb, closeDb, getOne, getMany, logEvent, incrementDailyStat } from './database/db.js';
import TrackedAccountsRepository from './database/TrackedAccountsRepository.js';
import SentItemsRepository from './database/SentItemsRepository.js';

import { appLogger as log } from './utils/Logger.js';
import { sleep } from './utils/Helpers.js';

import proxyManager from './proxy/ProxyManager.js';
import igClient from './instagram/IgClient.js';
import tgClient from './telegram/TgClient.js';
import channelSender from './telegram/ChannelSender.js';
import botManager from './telegram/BotManager.js';
import pollingWorker from './workers/PollingWorker.js';
import sendWorker from './workers/SendWorker.js';

// Global state
let httpServer = null;
let statsCronTask = null;
let isShuttingDown = false;
let tgRetryInterval = null;
let igRetryTimer = null;
let servicesReady = false;
let startupError = null;

/**
 * Main entry point
 */
async function main() {
  try {
    log.info('=======================================');
    log.info('  Instagram → Telegram Monitor Bot');
    log.info('  v1.0.0 - Node.js ESM (teleproto)');
    log.info('=======================================');

    // 1. Init config
    initConfig();
    validate();

    log.info({
      msg: 'Configuration loaded',
      env: config.app.env,
      targetAccounts: config.monitoring.targetAccounts.length,
    });

    // 2. Init database (synchronous, fast)
    initDb();

    // 3. Start HTTP server FIRST (so Railway healthcheck passes)
    startHttpServer();

    // 4. Initialize services in background (non-blocking)
    log.info('Initializing services in background...');
    initServices().catch(e => {
      log.error({ msg: 'Service initialization failed', error: e.message, stack: e.stack });
      startupError = e;
    });

    // Keep process alive
    await keepAlive();
  } catch (e) {
    log.error({ msg: 'Fatal error during startup', error: e.message, stack: e.stack });
    logEvent('error', 'App', 'Fatal startup error', { error: e.message, stack: e.stack });
    await gracefulShutdown(1);
  }
}

/**
 * Initialize all services (Instagram, Telegram, workers) in background
 *
 * این تابع در پس‌زمینه اجرا میشه و HTTP server منتظر اون نمی‌مونه.
 * اگه هر کدوم از سرویس‌ها شکست بخورن، ربات همچنان اجرا می‌مونه
 * و از طریق /health می‌شه وضعیت رو دید.
 */
async function initServices() {
  // 1. Seed tracked accounts
  await seedTrackedAccounts();

  // 2. Init proxy manager
  await proxyManager.init();

  // 3. Init Instagram client
  igClient.onSessionInvalid = async reason => {
    log.error({ msg: 'Instagram authentication lost; pausing polling', reason });
    pollingWorker.stop();
    startInstagramRetryLoop();
  };
try {
  igClient.init();
  await igClient.login();
  log.info('Instagram client ready');
} catch (e) {
  // FIX(bug1/bug4): cooldown یعنی «هنوز نمی‌دانیم»، نه «سشن خراب»
  if (e.name === 'InstagramCooldownError') {
    log.warn({
      msg: 'Instagram verification deferred by cooldown (session NOT invalid)',
      error: e.message,
    });
  } else {
    log.error({ msg: 'Instagram initialization failed', error: e.message });
    logEvent('error', 'App', 'Instagram init failed', { error: e.message });
  }
  startInstagramRetryLoop();
}
  // 4. Init Telegram — مهم: Bot Manager و MTProto مستقل از هم اجرا میشن
  //    تا اگه MTProto زمان‌بر باشه (مثلاً auto-find proxy)، Bot Manager کار کنه

  // 4a. Start Bot Manager FIRST (سریع — فقط یه HTTP proxy پیدا می‌کنه)
  try {
    log.info('Starting Bot Manager (independent of MTProto)...');
    await botManager.start();
    log.info('Bot Manager ready');
  } catch (e) {
    log.error({ msg: 'Bot Manager failed to start', error: e.message });
  }

  // 4b. Connect MTProto user session (در پس‌زمینه — ممکنه طول بکشه)
  //     اگه auto-proxy باشه، ممکنه ۱-۲ دقیقه طول بکشه تا پروکسی سالم پیدا کنه
  //     ولی ربات در این مدت کار می‌کنه و از /debug قابل مشاهده است
  (async () => {
    try {
      log.info('Starting Telegram MTProto connection (background)...');
      await tgClient.init();
      const connected = await tgClient.connect();

      if (connected) {
        log.info('✓ Telegram MTProto connected');
        if (igClient.isLoggedIn) {
          await sendWorker.recoverPending(1000, { recoverInterrupted: true });
        }
        // پیام راه‌اندازی فقط توسط BotManager ارسال میشه (نه اینجا)
      } else {
        log.warn({ msg: 'Telegram MTProto not connected', error: tgClient.lastError });
        try {
          await botManager.notifyAdmins(
            '⚠️ <b>Telegram MTProto connection failed</b>\n\n' +
            `Error: <code>${tgClient.lastError || 'Unknown'}</code>\n\n` +
            'Bot Manager is running. Posts cannot be sent to channel yet.\n' +
            'Will retry every 5 minutes automatically.\n\n' +
            'Use /debug for details.'
          );
        } catch {}
        startTelegramRetryLoop();
      }
    } catch (e) {
      log.error({ msg: 'Telegram MTProto initialization failed', error: e.message });
      logEvent('error', 'App', 'Telegram MTProto init failed', { error: e.message });
      try {
        await botManager.notifyAdmins(
          '⚠️ <b>Telegram MTProto failed</b>\n\n' +
          `Error: <code>${e.message}</code>\n\n` +
          'Will retry every 5 minutes.'
        );
      } catch {}
      startTelegramRetryLoop();
    }
  })();

  // 5. Start polling workers (only if at least Instagram is logged in)
  if (igClient.isLoggedIn) {
    pollingWorker.start();
    log.info('Polling workers started');
  } else {
    log.warn('Instagram not logged in - polling workers disabled');
    log.warn('Fix Instagram session and restart, or run: npm run setup:instagram');
  }

  // 6. Schedule daily stats
  if (config.app.dailyStatsEnabled) {
    const hour = config.app.dailyStatsHour;
    statsCronTask = cron.schedule(`0 ${hour} * * *`, async () => {
      log.info('Sending daily stats...');
      try {
        const stats = SentItemsRepository.getTodayStats();
        await channelSender.sendDailyStats(stats);
      } catch (e) {
        log.error({ msg: 'Could not send daily stats', error: e.message });
      }
    });
    log.info({ msg: 'Daily stats scheduled', hour });
  }

  servicesReady = true;
  log.info('🚀 All services initialized! Bot is now fully running.');

  logEvent('info', 'App', 'Bot started successfully', {
    targetAccounts: config.monitoring.targetAccounts.length,
    proxyMode: config.proxy.mode,
    instagramConnected: igClient.isLoggedIn,
    telegramConnected: tgClient.isReady(),
  });
}

/**
 * Add accounts from TARGET_ACCOUNTS env var to DB
 */
async function seedTrackedAccounts() {
  const accounts = config.monitoring.targetAccounts;

  if (accounts.length === 0) {
    log.warn('No target accounts specified in TARGET_ACCOUNTS');
    return;
  }

  log.info({ msg: 'Seeding tracked accounts', count: accounts.length });

  const failures = [];
  for (const username of accounts) {
    try {
      // FIX(bug6): add() حالا is_active = 1 را هم روی conflict ست می‌کند،
      // پس اکانتِ قبلاً pause شده دوباره فعال می‌شود
      TrackedAccountsRepository.add(username, { activate: true });
      const row = TrackedAccountsRepository.getByUsername(username);
      if (!row) throw new Error('row not found right after insert');
      if (!row.is_active) TrackedAccountsRepository.setActive(username, true);
      log.info({ msg: 'Account seeded', username, id: row.id });
    } catch (e) {
      failures.push({ username, error: e.message });
      log.error({ msg: 'Could not add account', username, error: e.message });
      logEvent('error', 'App', 'Seed account failed', { username, error: e.message });
    }
  }

  const total = TrackedAccountsRepository.countActive();
  log.info({ msg: 'Active tracked accounts', total, failures: failures.length });

  if (total === 0) {
    // بدون این، polling سالم هم هیچ کاری برای انجام ندارد
    const message = `No active tracked accounts after seeding (${failures.length} failures)`;
    log.error({ msg: message, failures });
    logEvent('error', 'App', message, { failures });
    throw new Error(message);
  }
}
/**
 * Simple HTTP server for health checks (Railway)
 *
 * این سرور بلافاصله بعد از استارت برنامه راه می‌افته و همیشه پاسخ میده.
 * حتی اگه سرویس‌ها هنوز آماده نشده باشن، status رو "starting" برمی‌گردونه.
 */
/**
 * Simple HTTP server for health checks (Railway)
 *
 * FIX(bug8): احراز هویت به‌صورت middleware روی همه‌ی مسیرهای حساس
 *            (/debug*, /stats, /refresh-proxies) اعمال می‌شود.
 * FIX(bug7): پاسخ‌دهی idempotent با فلگ responded (بدون ERR_HTTP_HEADERS_SENT).
 * FIX(bug13): در production جزئیات خطا/شماره تلفن عمومی نمایش داده نمی‌شود.
 */
function startHttpServer() {
  const port = config.app.port || 3000;

  const PROTECTED_PATHS = ['/debug', '/stats', '/refresh-proxies'];

  const isProtected = (pathname) =>
    PROTECTED_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`));

  const isAuthorized = (req) => {
    const authorization = req.headers.authorization || '';
    const providedToken = authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : (req.headers['x-debug-token'] || '').toString().trim();
    const expectedToken = (config.app.debugApiToken || '').trim();
    if (!config.app.isProduction) return true;
    return !!expectedToken && providedToken === expectedToken;
  };

  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // پاسخ‌دهیِ یک‌بار مصرف — از double writeHead جلوگیری می‌کند
    let responded = false;
    let timeoutId = null;
    const send = (code, body) => {
      if (responded || res.headersSent) return;
      responded = true;
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body, null, 2));
    };

    if (isProtected(url.pathname) && !isAuthorized(req)) {
      send(403, { error: 'Unauthorized' });
      return;
    }

    // ---------- /health و / ----------
    if (url.pathname === '/health' || url.pathname === '/') {
      const stats = {
        status: servicesReady ? 'ok' : 'starting',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        services: {
          instagram: igClient.isLoggedIn
            ? 'connected'
            : (igClient.verificationDeferred ? 'unknown (cooldown)' : 'disconnected'),
          telegram: tgClient.isReady() ? 'connected' : 'disconnected',
          proxy: proxyManager.getStats ? proxyManager.getStats() : null,
        },
        queue: sendWorker.getStats ? sendWorker.getStats() : null,
        accounts: TrackedAccountsRepository.countActive(),
      };

      if (startupError) {
        stats.startupError = config.app.isProduction ? 'startup error (see /debug)' : startupError.message;
      }

      // FIX(bug8/13): جزئیات خطای اینستاگرام در production عمومی نشود
      if (!igClient.isLoggedIn) {
        stats.instagramState = igClient.verificationDeferred ? 'verification_deferred' : 'not_logged_in';
        if (!config.app.isProduction && igClient.lastError) {
          stats.instagramError = igClient.lastError;
          stats.instagramErrorAt = igClient.lastErrorAt;
        }
      }

      send(200, stats);
      return;
    }

    // ---------- /debug ----------
    if (url.pathname === '/debug') {
      const telegramDebug = tgClient.getDebugInfo
        ? tgClient.getDebugInfo()
        : { isReady: tgClient.isReady ? tgClient.isReady() : false };

      send(200, {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        servicesReady,
        startupError: startupError?.message || null,
        instagram: igClient.getDebugInfo ? igClient.getDebugInfo() : null,
        telegram: telegramDebug,
        botManager: {
          isRunning: botManager.isRunning,
          lastStartError: botManager.lastStartError,
          lastStartErrorAt: botManager.lastStartErrorAt,
        },
        proxy: proxyManager.getStats ? proxyManager.getStats() : null,
        config: {
          igUsername: config.instagram.username,
          sessionDir: config.instagram.sessionDir,
          proxyMode: config.proxy.mode,
          targetAccounts: config.monitoring.targetAccounts,
          // FIX(bug13): «تنظیم شده» فقط وقتی واقعاً استفاده می‌شود
          tgProxyConfigured: !!process.env.TG_PROXY && process.env.TG_PROXY.trim() !== 'auto',
          tgBotToken: process.env.TG_BOT_TOKEN ? 'set' : 'not set',
          adminIds: config.app.adminIds?.length || 0,
          debugOperationsProtected: config.app.isProduction,
          feedFetchLimit: config.monitoring.feedFetchLimit,
          scheduleJitterPercent: config.antiDetect.scheduleJitterPercent,
        },
      });
      return;
    }

    // ---------- POST /debug/poll/:username ----------
    if (url.pathname.startsWith('/debug/poll/') && req.method === 'POST') {
      const username = url.pathname.replace('/debug/poll/', '').trim().toLowerCase();
      if (!username) {
        send(400, { error: 'Username required: /debug/poll/{username}' });
        return;
      }

      // FIX(bug5): در cooldown هیچ درخواستی به اینستاگرام نمی‌فرستیم
      if (igClient.isCoolingDown && igClient.isCoolingDown()) {
        send(429, {
          error: 'Instagram cooldown active',
          retryAfterSeconds: Math.ceil(igClient.getCooldownRemainingMs() / 1000),
        });
        return;
      }

      // poll دستی فقط برای اکانت‌های ردیابی‌شده
      const tracked = TrackedAccountsRepository.getByUsername(username);
      if (!tracked) {
        send(400, {
          error: `@${username} is not tracked. Add it first (/add) to avoid burning rate limits.`,
        });
        return;
      }

      timeoutId = setTimeout(() => {
        send(504, { error: 'Poll timed out after 60 seconds', username });
      }, 60000);

      try {
        log.info({ msg: 'Manual poll triggered', username });

        const userInfo = await igClient.getUserByUsername(username, { knownPk: tracked.pk || null });
        const posts = await igClient.getUserFeed(username, {
          limit: Math.max(5, Math.min(50, config.monitoring.feedFetchLimit)),
          userPk: tracked.pk || null,
        });

        let stories = [];
        try {
          stories = await igClient.getUserStories(username, { userPk: tracked.pk || null });
        } catch (e) {
          stories = { error: e.message };
        }

        send(200, {
          username,
          user: userInfo,
          postsCount: posts.length,
          posts: posts.map(p => ({
            pk: p.pk,
            shortcode: p.shortcode,
            type: p.type,
            isReel: p.isReel,
            caption: (p.caption || '').slice(0, 100),
            takenAt: p.takenAtIso,
            mediaUrls: p.mediaUrls?.length || 0,
            source: p.source || 'unknown',
          })),
          storiesCount: Array.isArray(stories) ? stories.length : 0,
          stories: Array.isArray(stories)
            ? stories.map(s => ({ pk: s.pk, type: s.subtype, takenAt: s.takenAtIso }))
            : stories,
        });
      } catch (e) {
        log.error({ msg: 'Manual poll failed', username, error: e.message });
        const status = e.name === 'InstagramCooldownError' ? 429 : 500;
        send(status, {
          error: e.message,
          stack: config.app.isProduction ? undefined : e.stack?.split('\n').slice(0, 5),
          igDebug: igClient.getDebugInfo ? igClient.getDebugInfo() : null,
        });
      }
      return;
    }

    // ---------- /debug/accounts ----------
    if (url.pathname === '/debug/accounts') {
      try {
        const accounts = TrackedAccountsRepository.getAll();
        send(200, {
          count: accounts.length,
          activeCount: TrackedAccountsRepository.countActive(),
          accounts: accounts.map(a => ({
            id: a.id,
            username: a.username,
            pk: a.pk,
            isPrivate: a.is_private,
            isActive: a.is_active,
            lastPostPk: a.last_post_pk,
            lastStoryPk: a.last_story_pk,
            lastPostCheckedAt: a.last_post_checked_at,
            lastStoryCheckedAt: a.last_story_checked_at,
            errorCount: a.error_count,
            lastError: a.last_error,
          })),
        });
      } catch (e) {
        send(500, { error: e.message });
      }
      return;
    }

    // ---------- /debug/recent ----------
    if (url.pathname === '/debug/recent') {
      try {
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        const recent = SentItemsRepository.getRecent(Number.isFinite(limit) ? limit : 20);
        send(200, {
          count: recent.length,
          items: recent.map(r => ({
            id: r.id,
            account: r.account_username,
            mediaPk: r.media_pk,
            mediaType: r.media_type,
            shortcode: r.shortcode,
            status: r.status,
            error: r.error,
            retryCount: r.retry_count,
            fileSize: r.file_size,
            tgMessageId: r.tg_message_id,
            createdAt: r.created_at,
            sentAt: r.sent_at,
            caption: (r.caption || '').slice(0, 100),
          })),
        });
      } catch (e) {
        send(500, { error: e.message });
      }
      return;
    }

    // ---------- POST /debug/retry-failed ----------
    if (url.pathname === '/debug/retry-failed' && req.method === 'POST') {
      try {
        const failed = SentItemsRepository.getFailed(10, 3);
        log.info({ msg: 'Retrying failed items', count: failed.length });

        for (const item of failed) {
          SentItemsRepository.updateStatus(item.id, 'pending');
        }
        const enqueuedCount = await sendWorker.recoverRows(failed);

        send(200, {
          ok: true,
          retriedCount: failed.length,
          enqueuedCount,
          message: `Marked ${failed.length} failed items and enqueued ${enqueuedCount} pending jobs`,
        });
      } catch (e) {
        send(500, { error: e.message });
      }
      return;
    }

    // ---------- /stats (محافظت‌شده) ----------
    if (url.pathname === '/stats') {
      try {
        send(200, {
          today: SentItemsRepository.getTodayStats(),
          recent: SentItemsRepository.getRecent(10),
        });
      } catch (e) {
        send(500, { error: e.message });
      }
      return;
    }

    // ---------- POST /refresh-proxies (محافظت‌شده) ----------
    if (url.pathname === '/refresh-proxies' && req.method === 'POST') {
      try {
        await proxyManager.refreshList();
        send(200, { ok: true, stats: proxyManager.getStats() });
      } catch (e) {
        send(500, { error: e.message });
      }
      return;
    }

    send(404, { error: 'Not found' });
  });

  httpServer.listen(port, () => {
    log.info({ msg: 'HTTP health server listening', port });
  });

  httpServer.on('error', (e) => {
    log.error({ msg: 'HTTP server error', error: e.message });
  });
}
/**
 * Keep the process alive (waiting for signals)
 */
/**
 * Background retry loop for Telegram MTProto connection
 *
 * اگه تلگرام وصل نشده باشه، هر ۵ دقیقه تلاش می‌کنه دوباره وصل بشه.
 * این مهمه چون پروکسی‌های رایگان ممکنه موقتاً از کار بیفتن.
 */
function startInstagramRetryLoop() {
  if (igRetryTimer || isShuttingDown) return;

  // FIX(bug4): تلاش مجدد هرگز نباید کوتاه‌تر از cooldown فعال باشد،
  // وگرنه هر بار فقط یک خطای تکراری تولید می‌کند و lastError را کثیف می‌کند
  const baseMs = Math.max(60, config.antiDetect.reconnectInterval) * 1000;
  const cooldownMs = igClient.getCooldownRemainingMs ? igClient.getCooldownRemainingMs() : 0;
  const jitterMs = Math.floor(Math.random() * 30_000);
  const intervalMs = Math.max(baseMs, cooldownMs + 15_000) + jitterMs;

  log.info({
    msg: 'Starting Instagram retry loop',
    intervalSeconds: Math.round(intervalMs / 1000),
    cooldownSeconds: Math.round(cooldownMs / 1000),
  });

  igRetryTimer = setTimeout(async () => {
    igRetryTimer = null;
    if (isShuttingDown || igClient.isLoggedIn) return;

    try {
      log.info('🔄 Retrying Instagram session verification...');
      await igClient.login();
      if (igClient.isLoggedIn) {
        pollingWorker.start();
        if (tgClient.isReady()) {
          await sendWorker.recoverPending(1000, { recoverInterrupted: true });
        }
        log.info('✓ Instagram reconnected and polling started');
        return;
      }
    } catch (e) {
      if (e.name === 'InstagramCooldownError') {
        log.warn({ msg: 'Instagram retry deferred (cooldown)', error: e.message });
      } else {
        log.warn({ msg: 'Instagram retry failed', error: e.message });
      }
    }
    startInstagramRetryLoop();
  }, intervalMs);
}
function startTelegramRetryLoop() {
  if (tgRetryInterval) {
    clearInterval(tgRetryInterval);
  }

  log.info('Starting Telegram retry loop (every 5 minutes)');

  tgRetryInterval = setInterval(async () => {
    if (tgClient.isReady()) {
      log.debug('Telegram already connected, stopping retry loop');
      clearInterval(tgRetryInterval);
      tgRetryInterval = null;
      return;
    }

    log.info('🔄 Retrying Telegram connection...');

    try {
      // Try to find a new proxy and reconnect
      tgClient._autoFoundProxy = null;  // Force finding new proxy
      await tgClient.init();
      const connected = await tgClient.connect();

      if (connected) {
        log.info('✓ Telegram connected on retry!');
        if (igClient.isLoggedIn) {
          await sendWorker.recoverPending(1000, { recoverInterrupted: true });
        }
        clearInterval(tgRetryInterval);
        tgRetryInterval = null;

        // Notify admins
        try {
          await botManager.notifyAdmins(
            '✅ <b>Telegram reconnected!</b>\n\n' +
            'MTProto connection is now active. Posts will be sent to channel.'
          );
        } catch {}

        // Send notification to admins (not channel)
        try {
          await botManager.notifyAdmins(
            '✅ <b>تلگرام متصل شد!</b>\n\n' +
            `🔴 تلگرام: <b>متصل</b>\n` +
            `📸 اینستاگرام: <b>${igClient.isLoggedIn ? 'متصل' : 'قطع'}</b>\n\n` +
            'پست‌ها به کانال ارسال خواهند شد.'
          );
        } catch {}
      } else {
        log.warn(`Telegram retry failed: ${tgClient.lastError}`);
      }
    } catch (e) {
      log.warn({ msg: 'Telegram retry error', error: e.message });
    }
  }, 5 * 60 * 1000);  // 5 minutes
}

async function keepAlive() {
  while (!isShuttingDown) {
    await sleep(1000);
  }
}

/**
 * Graceful shutdown
 */
async function gracefulShutdown(exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info('Shutting down gracefully...');

  try {
    try { pollingWorker.stop(); } catch {}
    if (igRetryTimer) { clearTimeout(igRetryTimer); igRetryTimer = null; }
    if (tgRetryInterval) { clearInterval(tgRetryInterval); tgRetryInterval = null; }
    if (statsCronTask) { try { statsCronTask.stop(); } catch {} }
    try { proxyManager.stop(); } catch {}

    try { await igClient.persistSession(); } catch {}
    try { await tgClient.disconnect(); } catch {}

    if (httpServer) {
      await new Promise(resolve => httpServer.close(resolve));
    }

    closeDb();
    log.info('Shutdown complete.');
  } catch (e) {
    log.error({ msg: 'Error during shutdown', error: e.message });
  }

  process.exit(exitCode);
}

// Handle signals
process.on('SIGINT', () => gracefulShutdown(0));
process.on('SIGTERM', () => gracefulShutdown(0));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  log.error({ msg: 'Uncaught exception', error: err.message, stack: err.stack });
  logEvent('error', 'App', 'Uncaught exception', { error: err.message, stack: err.stack });
  // Don't exit - try to continue
});

process.on('unhandledRejection', (reason, promise) => {
  log.error({ msg: 'Unhandled rejection', reason: reason?.message || String(reason) });
  logEvent('error', 'App', 'Unhandled rejection', { reason: String(reason) });
});

// Start the bot
main();
