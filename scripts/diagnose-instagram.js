#!/usr/bin/env node
/**
 * scripts/diagnose-instagram.js
 *
 * اسکریپت تشخیصی برای بررسی وضعیت سشن اینستاگرام و تست endpointها.
 * اجرا: node scripts/diagnose-instagram.js
 *
 * این اسکریپت به شما نشان می‌دهد:
 *   1. آیا سشن معتبر است؟
 *   2. کدام endpointها کار می‌کنند؟
 *   3. آیا IP محدود شده است؟
 *   4. چه اقدامی لازم است؟
 */

import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const IG_BASE = 'https://www.instagram.com';
const IG_API = 'https://www.instagram.com/api/v1';
const IG_APP_ID = '936619743392459';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const colors = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// Load session
function loadSession() {
  // Try base64 env first
  const b64 = process.env.IG_SESSION_BASE64;
  if (b64?.trim()) {
    try {
      const json = Buffer.from(b64.trim(), 'base64').toString('utf8');
      return JSON.parse(json);
    } catch (e) {
      console.log(colors.red('  ✗ IG_SESSION_BASE64 is set but invalid'));
    }
  }

  // Try file
  const sessionDir = resolve(projectRoot, process.env.IG_SESSION_DIR || './data/ig-sessions');
  const username = process.env.IG_USERNAME || 'academy_barfi';
  const sessionFile = resolve(sessionDir, `${username}.web-session.json`);

  if (existsSync(sessionFile)) {
    try {
      return JSON.parse(readFileSync(sessionFile, 'utf8'));
    } catch (e) {
      console.log(colors.red(`  ✗ Could not parse session file: ${e.message}`));
    }
  }

  return null;
}

function buildHeaders(session, extra = {}) {
  const headers = {
    'x-ig-app-id': IG_APP_ID,
    'User-Agent': BROWSER_UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    ...extra,
  };

  if (session?.cookies) {
    const cookieStr = Object.entries(session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    headers['Cookie'] = cookieStr;
    headers['X-CSRFToken'] = session.cookies.csrftoken;
  }

  return headers;
}

async function testEndpoint(name, url, session, options = {}) {
  const headers = buildHeaders(session, options.headers || {});
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      redirect: 'manual',
    });

    const elapsed = Date.now() - start;
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { _html: text.slice(0, 200) };
    }

    return {
      name,
      status: response.status,
      elapsed,
      ok: response.ok,
      data,
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (e) {
    return {
      name,
      status: 0,
      elapsed: Date.now() - start,
      ok: false,
      error: e.message,
    };
  }
}

function printResult(r) {
  const statusColor = r.status === 200 ? colors.green : (r.status >= 400 ? colors.red : colors.yellow);
  const statusStr = r.status > 0 ? statusColor(r.status) : colors.red('ERR');
  console.log(`  ${r.name.padEnd(45)} ${statusStr}  ${String(r.elapsed).padStart(4)}ms`);

  if (r.error) {
    console.log(colors.gray(`    Error: ${r.error}`));
    return;
  }

  // Show key info
  if (r.data?.message) {
    const msg = r.data.message;
    const isChinese = /[\u4e00-\u9fff]/.test(msg);
    const color = isChinese ? colors.red : (msg.includes('Please wait') ? colors.red : colors.yellow);
    console.log(color(`    Message: "${msg}"`));
    if (isChinese) {
      console.log(colors.red('    ⚠ Instagram returned a Chinese error message — session is THROTTLED'));
    }
  }

  if (r.data?.status === 'ok' && r.data?.items) {
    console.log(colors.green(`    Items: ${r.data.items.length}`));
  }

  if (r.data?.data?.user) {
    const u = r.data.data.user;
    console.log(colors.green(`    User: @${u.username} (id: ${u.id})`));
    const edges = u.edge_owner_to_timeline_media?.edges || [];
    console.log(`    Media count: ${u.edge_owner_to_timeline_media?.count || 0}, edges: ${edges.length}`);
    if (edges.length === 0 && u.edge_owner_to_timeline_media?.count > 0) {
      console.log(colors.red('    ⚠ Profile has posts but edges array is EMPTY — Instagram is hiding feed data!'));
    }
  }

  if (r.data?._html) {
    console.log(colors.gray(`    HTML response (not JSON) — endpoint changed or redirected`));
  }
}

async function main() {
  console.log(colors.bold(colors.cyan('\n═══════════════════════════════════════════')));
  console.log(colors.bold(colors.cyan('  Instagram Session Diagnostic Tool')));
  console.log(colors.bold(colors.cyan('═══════════════════════════════════════════\n')));

  // Load session
  console.log(colors.bold('1. Loading session...'));
  const session = loadSession();

  if (!session) {
    console.log(colors.red('  ✗ No session found! Run: npm run setup:instagram'));
    process.exit(1);
  }

  console.log(colors.green(`  ✓ Session loaded`));
  console.log(`    Username: ${session.username}`);
  console.log(`    Created:  ${session.createdAt}`);
  console.log(`    Cookies: ${Object.keys(session.cookies).length}`);
  console.log(`    User-Agent: ${session.userAgent?.slice(0, 60)}...`);

  const userId = session.cookies.ds_user_id;
  console.log(`    User ID:  ${userId}`);
  console.log();

  // Test endpoints
  console.log(colors.bold('2. Testing endpoints...\n'));

  const tests = [
    {
      name: 'Verify (auth /users/{id}/info/)',
      url: `${IG_API}/users/${userId}/info/`,
    },
    {
      name: 'web_profile_info (botfoori)',
      url: `${IG_API}/users/web_profile_info/?username=botfoori`,
    },
    {
      name: 'web_profile_info (ba3iraa)',
      url: `${IG_API}/users/web_profile_info/?username=ba3iraa`,
    },
    {
      name: 'feed/user/botfoori (pk=62110858059)',
      url: `${IG_API}/feed/user/62110858059/?count=5`,
    },
    {
      name: 'feed/user/ba3iraa (pk=76026823321)',
      url: `${IG_API}/feed/user/76026823321/?count=5`,
    },
    {
      name: 'feed/timeline (your home feed)',
      url: `${IG_API}/feed/timeline/?count=5`,
    },
  ];

  const results = [];
  for (const test of tests) {
    // Small delay between tests
    await new Promise(r => setTimeout(r, 2000));
    const r = await testEndpoint(test.name, test.url, session, {
      headers: { 'Referer': `${IG_BASE}/` },
    });
    results.push(r);
    printResult(r);
  }

  // Analysis
  console.log(colors.bold(colors.cyan('\n═══════════════════════════════════════════')));
  console.log(colors.bold(colors.cyan('  Diagnosis')));
  console.log(colors.bold(colors.cyan('═══════════════════════════════════════════\n')));

  const verifyOk = results[0]?.status === 200;
  const profileBotfoori = results[1]?.data?.data?.user;
  const profileBa3iraa = results[2]?.data?.data?.user;
  const feedBotfoori = results[3]?.data?.items || [];
  const feedBa3iraa = results[4]?.data?.items || [];
  const timeline = results[5]?.data?.feed_items || results[5]?.data?.items || [];

  // Check 1: Session validity
  console.log(colors.bold('Session validity:'));
  if (verifyOk) {
    console.log(colors.green('  ✅ Session is valid (can access /users/{id}/info/)'));
  } else {
    console.log(colors.red('  ❌ Session appears invalid or expired'));
  }

  // Check 2: Profile access
  console.log(colors.bold('\nProfile access:'));
  if (profileBotfoori) {
    console.log(colors.green(`  ✅ Can read @botfoori profile (id: ${profileBotfoori.id})`));
    const edges = profileBotfoori.edge_owner_to_timeline_media?.edges || [];
    if (edges.length > 0) {
      console.log(colors.green(`  ✅ Profile timeline edges available (${edges.length} posts)`));
    } else if (profileBotfoori.edge_owner_to_timeline_media?.count > 0) {
      console.log(colors.red('  ❌ Profile has posts but edges are EMPTY — feed data is being hidden'));
    }
  } else {
    console.log(colors.red('  ❌ Cannot read @botfoori profile'));
  }

  // Check 3: Feed access
  console.log(colors.bold('\nFeed access:'));
  console.log(`  feed/user/botfoori: ${feedBotfoori.length} items returned`);
  console.log(`  feed/user/ba3iraa:  ${feedBa3iraa.length} items returned`);
  console.log(`  feed/timeline:      ${timeline.length} items returned`);

  if (feedBotfoori.length === 0 && feedBa3iraa.length === 0) {
    console.log(colors.red('\n  ❌ CRITICAL: All feed endpoints return 0 items'));
    console.log(colors.yellow('  This means Instagram is throttling your session.'));
    console.log(colors.yellow('  The session works for profile metadata, but feed data is blocked.'));
  } else if (feedBotfoori.length > 0 || feedBa3iraa.length > 0) {
    console.log(colors.green('\n  ✅ Feed endpoints are working'));
  }

  // Check 4: Throttle detection
  console.log(colors.bold('\nThrottle detection:'));

  const allMessages = results.map(r => r.data?.message || '').join(' ');
  const hasChinese = /[\u4e00-\u9fff]/.test(allMessages);
  const hasPleaseWait = allMessages.toLowerCase().includes('please wait');
  const hasLoginRequired = allMessages.toLowerCase().includes('require_login');

  if (hasChinese) {
    console.log(colors.red('  🚨 Session is THROTTLED (Chinese error message detected)'));
    console.log(colors.yellow('  Action: Wait 6-24 hours, then reduce request frequency'));
  } else if (hasPleaseWait) {
    console.log(colors.red('  🚨 IP is rate-limited ("Please wait a few minutes")'));
    console.log(colors.yellow('  Action: Wait 1-2 hours, the limit is temporary'));
  } else if (hasLoginRequired && !verifyOk) {
    console.log(colors.red('  🚨 Session requires re-login'));
    console.log(colors.yellow('  Action: Run: npm run setup:instagram'));
  } else if (feedBotfoori.length === 0 && verifyOk) {
    console.log(colors.yellow('  ⚠ Session works but feed is empty — likely throttled'));
    console.log(colors.yellow('  Action: Wait a few hours, reduce polling frequency'));
  } else {
    console.log(colors.green('  ✅ No throttle detected'));
  }

  // Recommendations
  console.log(colors.bold(colors.cyan('\n═══════════════════════════════════════════')));
  console.log(colors.bold(colors.cyan('  Recommendations')));
  console.log(colors.bold(colors.cyan('═══════════════════════════════════════════\n')));

  if (feedBotfoori.length === 0) {
    console.log(colors.yellow('  1. STOP the bot immediately — do not make more requests'));
    console.log(colors.yellow('  2. Wait 6-24 hours for the throttle to expire'));
    console.log(colors.yellow('  3. Consider using a residential proxy (PROXY_MODE=static)'));
    console.log(colors.yellow('  4. After restart, ensure POLL_INTERVAL_POSTS=900 (15 min)'));
    console.log(colors.yellow('  5. After restart, ensure REQUEST_DELAY_MIN=5000 (5 sec)'));
    console.log();
    console.log(colors.bold(colors.red('  The session itself is valid, but Instagram is temporarily')));
    console.log(colors.bold(colors.red('  hiding feed data due to excessive requests. This is NOT')));
    console.log(colors.bold(colors.red('  a permanent ban — it will resolve with time.')));
  } else {
    console.log(colors.green('  ✅ Everything looks good! The bot should work.'));
  }

  console.log();
  process.exit(0);
}

main().catch(e => {
  console.error(colors.red(`\nFatal error: ${e.message}`));
  console.error(e.stack);
  process.exit(1);
});
