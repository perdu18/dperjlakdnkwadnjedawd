#!/usr/bin/env node
/**
 * scripts/test-feed-fetch.js
 *
 * تست واقعی fetch feed برای اکانت‌های مانیتور.
 * اجرا: node scripts/test-feed-fetch.js
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

const IG_API = 'https://www.instagram.com/api/v1';
const IG_APP_ID = '936619743392459';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

async function fetchFeed(userPk, username) {
  const session = loadSession();
  if (!session) {
    console.log('No session found!');
    return null;
  }

  const cookieStr = Object.entries(session.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  const url = `${IG_API}/feed/user/${userPk}/?count=12`;
  console.log(`\nFetching feed for @${username} (pk: ${userPk})...`);
  console.log(`URL: ${url}`);

  const response = await fetch(url, {
    headers: {
      'x-ig-app-id': IG_APP_ID,
      'User-Agent': BROWSER_UA,
      'Cookie': cookieStr,
      'X-CSRFToken': session.cookies.csrftoken,
      'Referer': `https://www.instagram.com/${username}/`,
      'Accept': '*/*',
    },
  });

  console.log(`Status: ${response.status}`);
  const data = await response.json();

  console.log(`Response status: ${data.status}`);
  console.log(`num_results: ${data.num_results}`);
  console.log(`items count: ${data.items?.length || 0}`);

  if (data.items?.length > 0) {
    console.log('\nPosts found:');
    for (const item of data.items.slice(0, 5)) {
      const takenAt = new Date(item.taken_at * 1000).toISOString();
      console.log(`  • pk: ${item.pk}`);
      console.log(`    code: ${item.code}`);
      console.log(`    media_type: ${item.media_type} (1=photo, 2=video, 8=carousel)`);
      console.log(`    taken_at: ${takenAt}`);
      const cap = item.caption?.text || '';
      if (cap) console.log(`    caption: ${cap.slice(0, 80)}...`);
      console.log();
    }
  }

  return data;
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Feed Fetch Test');
  console.log('═══════════════════════════════════════════');

  // Test accounts with their known PKs
  const accounts = [
    { username: 'botfoori', pk: '62110858059' },
    { username: 'ba3iraa', pk: '76026823321' },
  ];

  for (const account of accounts) {
    try {
      await fetchFeed(account.pk, account.username);
      // Small delay between accounts
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  Test complete');
  console.log('═══════════════════════════════════════════');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
