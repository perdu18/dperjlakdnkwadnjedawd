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
  try {
    igClient.init();
    await igClient.login();
    log.info('Instagram client ready');
  } catch (e) {
    log.error({ msg: 'Instagram initialization failed', error: e.message });
    logEvent('error', 'App', 'Instagram init failed', { error: e.message });
    // Don't throw - continue with other services
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

  for (const username of accounts) {
    try {
      TrackedAccountsRepository.add(username);
      log.debug({ msg: 'Account added/updated', username });
    } catch (e) {
      log.warn({ msg: 'Could not add account', username, error: e.message });
    }
  }

  const total = TrackedAccountsRepository.countActive();
  log.info({ msg: 'Active tracked accounts', total });
}

/**
 * Simple HTTP server for health checks (Railway)
 *
 * این سرور بلافاصله بعد از استارت برنامه راه می‌افته و همیشه پاسخ میده.
 * حتی اگه سرویس‌ها هنوز آماده نشده باشن، status رو "starting" برمی‌گردونه.
 */
function startHttpServer() {
  const port = config.app.port || 3000;

  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // Diagnostics expose operational data and some routes trigger Instagram
    // requests. Require a production secret for the entire debug namespace.
    if (url.pathname === '/debug' || url.pathname.startsWith('/debug/')) {
      const authorization = req.headers.authorization || '';
      const providedToken = authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : req.headers['x-debug-token'];
      const expectedToken = config.app.debugApiToken;
      if (config.app.isProduction && (!expectedToken || providedToken !== expectedToken)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Debug operation is disabled or unauthorized' }));
        return;
      }
    }

    // Always return 200 on / and /health (so Railway healthcheck passes)
    if (url.pathname === '/health' || url.pathname === '/') {
      const stats = {
        status: servicesReady ? 'ok' : 'starting',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        services: {
          instagram: igClient.isLoggedIn ? 'connected' : 'disconnected',
          telegram: tgClient.isReady() ? 'connected' : 'disconnected',
          proxy: proxyManager.getStats ? proxyManager.getStats() : null,
        },
        queue: sendWorker.getStats ? sendWorker.getStats() : null,
        accounts: TrackedAccountsRepository.countActive(),
      };

      if (startupError) {
        stats.startupError = startupError.message;
      }

      // Add Instagram last error for debugging
      if (!igClient.isLoggedIn && igClient.lastError) {
        stats.instagramError = igClient.lastError;
        stats.instagramErrorAt = igClient.lastErrorAt;
      }

      // Always return 200 so Railway doesn't kill the container
      // (we report status in the body)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
      return;
    }

    if (url.pathname === '/debug') {
      const debugInfo = {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        servicesReady,
        startupError: startupError?.message || null,
        instagram: igClient.getDebugInfo ? igClient.getDebugInfo() : null,
        telegram: tgClient.getDebugInfo ? tgClient.getDebugInfo() : {
          isReady: tgClient.isReady ? tgClient.isReady() : false,
        },
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
          tgProxyConfigured: !!process.env.TG_PROXY,
          tgBotToken: process.env.TG_BOT_TOKEN ? '✅ set' : '❌ not set',
          adminIds: config.app.adminIds?.length || 0,
          debugOperationsProtected: config.app.isProduction,
          feedFetchLimit: config.monitoring.feedFetchLimit,
          scheduleJitterPercent: config.antiDetect.scheduleJitterPercent,
        },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(debugInfo, null, 2));
      return;
    }

    // Manual poll test for a specific username
    if (url.pathname.startsWith('/debug/poll/') && req.method === 'POST') {
      const username = url.pathname.replace('/debug/poll/', '').trim();
      if (!username) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Username required: /debug/poll/{username}' }));
        return;
      }

      // Set a 60-second timeout for the entire operation
      const timeoutId = setTimeout(() => {
        try {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Poll timed out after 60 seconds', username }));
        } catch {}
      }, 60000);

      try {
        log.info({ msg: 'Manual poll triggered', username });

        // Step 1: Get user info
        const userInfo = await igClient.getUserByUsername(username);

        // Step 2: Get user feed
        const posts = await igClient.getUserFeed(username, {
          limit: Math.max(5, Math.min(50, config.monitoring.feedFetchLimit)),
        });

        // Step 3: Get user stories
        let stories = [];
        try {
          stories = await igClient.getUserStories(username);
        } catch (e) {
          stories = { error: e.message };
        }

        clearTimeout(timeoutId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
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
        }, null, 2));
      } catch (e) {
        clearTimeout(timeoutId);
        log.error({ msg: 'Manual poll failed', username, error: e.message });
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: e.message,
            stack: e.stack?.split('\n').slice(0, 5),
            igDebug: igClient.getDebugInfo ? igClient.getDebugInfo() : null,
          }, null, 2));
        } catch {}
      }
      return;
    }

    // List tracked accounts from DB
    if (url.pathname === '/debug/accounts') {
      try {
        const accounts = TrackedAccountsRepository.getAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          count: accounts.length,
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
        }, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // List recent sent items (for debugging)
    if (url.pathname === '/debug/recent') {
      try {
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        const recent = SentItemsRepository.getRecent(limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
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
        }, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Retry failed items
    if (url.pathname === '/debug/retry-failed' && req.method === 'POST') {
      try {
        const failed = SentItemsRepository.getFailed(10, 3);
        log.info({ msg: 'Retrying failed items', count: failed.length });

        for (const item of failed) {
          SentItemsRepository.updateStatus(item.id, 'pending');
        }
        const enqueuedCount = await sendWorker.recoverRows(failed);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          retriedCount: failed.length,
          enqueuedCount,
          message: `Marked ${failed.length} failed items and enqueued ${enqueuedCount} pending jobs`,
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === '/stats') {
      try {
        const todayStats = SentItemsRepository.getTodayStats();
        const recent = SentItemsRepository.getRecent(10);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ today: todayStats, recent }, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === '/refresh-proxies' && req.method === 'POST') {
      try {
        await proxyManager.refreshList();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stats: proxyManager.getStats() }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  httpServer.listen(port, () => {
    log.info({ msg: 'HTTP health server listening', port });
  });

  // Handle server errors
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
