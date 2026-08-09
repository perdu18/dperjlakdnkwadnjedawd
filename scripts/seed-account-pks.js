#!/usr/bin/env node
/**
 * scripts/seed-account-pks.js
 *
 * اسکریپت برای تنظیم دستی PK اکانت‌های اینستاگرام در دیتابیس.
 *
 * چرا این اسکریپت؟
 * ─────────────────
 * وقتی اینستاگرام web_profile_info را محدود می‌کند (۴۲۹)، ربات نمی‌تواند
 * PK اکانت‌های جدید را به‌دست آورد. بدون PK، نمی‌تواند /feed/user/{pk}/
 * را صدا بزند (که هنوز کار می‌کند).
 *
 * این اسکریپت به شما اجازه می‌دهد PK را مستقیم در DB قرار دهید.
 *
 * چطور PK را پیدا کنید؟
 * ─────────────────────
 * 1. به instagram.com/{username}/ بروید (در مرورگر)
 * 2. View Source (Ctrl+U)
 * 3. در HTML بگردید دنبال "profilePage_" یا "userID"
 * 4. عدد بعد از آن، PK است
 *
 * یا ساده‌تر:
 *   - به instagram.com/{username}/ بروید
 *   - در Console اجرا کنید: window._sharedData.entry_data.ProfilePage[0].graphql.user.id
 *
 * یا از اسکریپت test-feed-fetch.js استفاده کنید (اگر PK را می‌دانید)
 *
 * استفاده:
 *   node scripts/seed-account-pks.js                    # نمایش اکانت‌های فعلی
 *   node scripts/seed-account-pks.js ba3iraa=76026823321 # تنظیم PK برای یک اکانت
 *   node scripts/seed-account-pks.js ba3iraa=76026823321 rasanknews=12345678901
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

const dbPath = resolve(projectRoot, process.env.DB_PATH || './data/app.db');

if (!existsSync(dbPath)) {
  console.error(`❌ Database not found at: ${dbPath}`);
  console.error('   Run the bot once first to create the database.');
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

function listAccounts() {
  console.log('\n📋 Tracked Accounts:\n');
  console.log('─'.repeat(80));
  const rows = db.prepare(`
    SELECT id, username, pk, is_active, last_post_pk, error_count, last_error
    FROM tracked_accounts
    ORDER BY id
  `).all();

  if (rows.length === 0) {
    console.log('  (no accounts in database)');
    console.log('\n💡 Add accounts via Telegram bot: /add username');
    return;
  }

  for (const row of rows) {
    const pkStatus = row.pk ? `✅ pk=${row.pk}` : '❌ no pk';
    const activeStatus = row.is_active ? '✅ active' : '⏸ paused';
    console.log(`  @${row.username.padEnd(20)} ${pkStatus.padEnd(35)} ${activeStatus}`);
    if (row.last_post_pk) {
      console.log(`    last_post_pk: ${row.last_post_pk}`);
    }
    if (row.error_count > 0) {
      console.log(`    errors: ${row.error_count}, last: ${(row.last_error || '').slice(0, 80)}`);
    }
  }
  console.log('─'.repeat(80));
  console.log(`Total: ${rows.length} accounts\n`);
}

function setPk(username, pk) {
  // Validate pk is numeric
  if (!/^\d+$/.test(String(pk))) {
    console.error(`❌ Invalid PK "${pk}" for @${username} — must be numeric`);
    return false;
  }

  const result = db.prepare(`
    UPDATE tracked_accounts
    SET pk = ?, updated_at = strftime('%s','now'), error_count = 0, last_error = NULL
    WHERE username = ?
  `).run(String(pk), username.toLowerCase());

  if (result.changes === 0) {
    console.error(`❌ Account @${username} not found in database`);
    console.error('   Add it first via Telegram bot: /add ' + username);
    return false;
  }

  console.log(`✅ Set PK=${pk} for @${username}`);
  return true;
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
  // No arguments — just list accounts
  listAccounts();
  console.log('💡 Usage:');
  console.log('   node scripts/seed-account-pks.js <username>=<pk>');
  console.log('   node scripts/seed-account-pks.js ba3iraa=76026823321');
  console.log('');
  console.log('To find PK:');
  console.log('   1. Open https://instagram.com/{username}/ in browser');
  console.log('   2. View Source (Ctrl+U)');
  console.log('   3. Search for "profilePage_" — the number after it is the PK');
  process.exit(0);
}

// Process arguments
let successCount = 0;
let failCount = 0;

for (const arg of args) {
  const match = arg.match(/^@?([a-zA-Z0-9._]+)=(\d+)$/);
  if (!match) {
    console.error(`❌ Invalid argument: "${arg}"`);
    console.error('   Format: username=pk (e.g., ba3iraa=76026823321)');
    failCount++;
    continue;
  }

  const [, username, pk] = match;
  if (setPk(username, pk)) {
    successCount++;
  } else {
    failCount++;
  }
}

console.log('');
console.log(`📊 Summary: ${successCount} updated, ${failCount} failed`);

if (successCount > 0) {
  console.log('\n📋 Updated accounts:');
  listAccounts();
}

db.close();
process.exit(failCount > 0 ? 1 : 0);
