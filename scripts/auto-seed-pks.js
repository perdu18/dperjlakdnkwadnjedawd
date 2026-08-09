#!/usr/bin/env node
/**
 * scripts/auto-seed-pks.js
 *
 * اسکریپت خودکار برای یافتن و ذخیره PK اکانت‌های اینستاگرام.
 * این اسکریپت در زمان راه‌اندازی ربات اجرا می‌شود و اکانت‌هایی که PK ندارند
 * را به‌طور خودکار از طریق topsearch پیدا و در DB ذخیره می‌کند.
 *
 * مزایا:
 *   - اکانت‌های جدید بدون نیاز به دستور دستی PK می‌گیرند
 *   - حتی اگه web_profile_info محدود (۴۲۹) باشد، topsearch کار می‌کند
 *   - در Railway خودکار اجرا می‌شود
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

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

function loadSession() {
  const b64 = process.env.IG_SESSION_BASE64;
  if (b64?.trim()) {
    try {
      const json = Buffer.from(b64.trim(), 'base64').toString('utf8');
      return JSON.parse(json);
    } catch {}
  }

  const sessionDir = resolve(projectRoot, process.env.IG_SESSION_DIR || './data/ig-sessions');
  const username = process.env.IG_USERNAME || 'academy_barfi';
  const sessionFile = resolve(sessionDir, `${username}.web-session.json`);

  if (existsSync(sessionFile)) {
    return JSON.parse(readFileSync(sessionFile, 'utf8'));
  }

  return null;
}

async function findPkViaTopSearch(username, session) {
  const cookieStr = Object.entries(session.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  const response = await fetch(
    `${IG_API}/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}&include_reel=true`,
    {
      headers: {
        'x-ig-app-id': IG_APP_ID,
        'User-Agent': BROWSER_UA,
        'Cookie': cookieStr,
        'X-CSRFToken': session.cookies.csrftoken,
        'Referer': 'https://www.instagram.com/',
        'Accept': '*/*',
      },
    }
  );

  if (response.status !== 200) {
    throw new Error(`topsearch returned ${response.status}`);
  }

  const data = await response.json();
  const users = data.users || [];
  const match = users.find(u =>
    u?.user?.username?.toLowerCase() === username.toLowerCase()
  );

  return match?.user?.pk || null;
}

async function main() {
  console.log(colors.bold(colors.cyan('\n═══════════════════════════════════════════')));
  console.log(colors.bold(colors.cyan('  Auto-Seed Account PKs')));
  console.log(colors.bold(colors.cyan('═══════════════════════════════════════════\n')));

  // Load session
  const session = loadSession();
  if (!session) {
    console.log(colors.red('  ✗ No session found — skipping auto-seed'));
    process.exit(0);  // Don't fail startup
  }

  // Load DB
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = resolve(projectRoot, process.env.DB_PATH || './data/app.db');
    if (!existsSync(dbPath)) {
      console.log(colors.yellow('  ⚠ Database not found yet — skipping auto-seed'));
      process.exit(0);
    }
    db = new DatabaseSync(dbPath);
  } catch (e) {
    console.log(colors.yellow(`  ⚠ Could not open database: ${e.message}`));
    process.exit(0);
  }

  // Get accounts without PK
  const accounts = db.prepare(`
    SELECT id, username, pk FROM tracked_accounts WHERE pk IS NULL OR pk = ''
  `).all();

  if (accounts.length === 0) {
    console.log(colors.green('  ✅ All tracked accounts already have PKs'));
    db.close();
    process.exit(0);
  }

  console.log(colors.yellow(`  📋 Found ${accounts.length} account(s) without PK:\n`));

  let successCount = 0;
  let failCount = 0;

  for (const account of accounts) {
    console.log(`  🔍 Looking up @${account.username} via topsearch...`);

    try {
      // Small delay between requests
      await new Promise(r => setTimeout(r, 2000));

      const pk = await findPkViaTopSearch(account.username, session);

      if (pk) {
        db.prepare(`
          UPDATE tracked_accounts
          SET pk = ?, updated_at = strftime('%s','now')
          WHERE id = ?
        `).run(String(pk), account.id);

        console.log(colors.green(`     ✅ Found PK: ${pk}`));
        successCount++;
      } else {
        console.log(colors.red(`     ❌ @${account.username} not found in topsearch`));
        failCount++;
      }
    } catch (e) {
      console.log(colors.red(`     ❌ Error: ${e.message}`));
      failCount++;
    }
  }

  console.log('');
  console.log(colors.bold(`📊 Summary: ${successCount} found, ${failCount} failed`));

  if (successCount > 0) {
    console.log(colors.green('\n  ✅ Accounts are ready for feed polling'));
  }

  db.close();
  // Exit 0 even on failure — don't block bot startup
  process.exit(0);
}

main().catch(e => {
  console.error(colors.red(`\nFatal error: ${e.message}`));
  // Don't fail startup
  process.exit(0);
});
