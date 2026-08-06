/**
 * scripts/export-session-base64.js
 *
 * این اسکریپت فایل session اینستاگرام رو می‌خونه و به‌صورت base64 encode می‌کنه
 * تا بشه به‌عنوان environment variable در Railway یا هر سرویس cloud دیگه set کرد.
 *
 * استفاده:
 *   node scripts/export-session-base64.js [username]
 *
 * اگه username داده نشه، از IG_USERNAME در .env استفاده می‌کنه.
 *
 * خروجی:
 *   - یه فایل ig-session-base64.txt حاوی base64 string
 *   - همین مقدار در clipboard کپی نمیشه (در صورت پشتیبانی)
 *   - دستورالعمل نمایش داده میشه
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import kleur from 'kleur';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

// Load .env
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

async function main() {
  // Get username from arg or env
  const username = process.argv[2] || process.env.IG_USERNAME;

  if (!username) {
    console.log(kleur.red('\n❌ Username is required.'));
    console.log(kleur.gray('   Usage: node scripts/export-session-base64.js [username]'));
    console.log(kleur.gray('   Or set IG_USERNAME in .env\n'));
    process.exit(1);
  }

  // Find session file
  const sessionDir = process.env.IG_SESSION_DIR || './data/ig-sessions';
  const sessionPath = resolve(projectRoot, sessionDir, `${username}.web-session.json`);

  console.log(kleur.cyan('\n═══════════════════════════════════════════'));
  console.log(kleur.cyan('  Export Instagram Session as Base64'));
  console.log(kleur.cyan('═══════════════════════════════════════════\n'));

  console.log(kleur.gray(`Looking for session file:`));
  console.log(kleur.gray(`   ${sessionPath}`));

  if (!existsSync(sessionPath)) {
    console.log(kleur.red('\n❌ Session file not found!'));
    console.log(kleur.yellow('\n💡 Make sure you have run:'));
    console.log(kleur.gray('   npm run setup:instagram'));
    console.log(kleur.gray(`   with username: ${username}\n`));
    process.exit(1);
  }

  // Read session file
  let sessionData;
  try {
    const content = readFileSync(sessionPath, 'utf8');
    sessionData = JSON.parse(content);
  } catch (e) {
    console.log(kleur.red(`\n❌ Could not read session file: ${e.message}\n`));
    process.exit(1);
  }

  // Validate session has required cookies
  const essential = ['sessionid', 'csrftoken', 'ds_user_id'];
  const missing = essential.filter(c => !sessionData.cookies?.[c]);

  if (missing.length > 0) {
    console.log(kleur.red(`\n❌ Session file is missing essential cookies: ${missing.join(', ')}`));
    console.log(kleur.yellow('\n💡 Re-run: npm run setup:instagram\n'));
    process.exit(1);
  }

  console.log(kleur.green('\n✓ Session file loaded successfully'));
  console.log(kleur.gray(`   Username: ${sessionData.username}`));
  console.log(kleur.gray(`   Cookies: ${Object.keys(sessionData.cookies).length}`));
  console.log(kleur.gray(`   User ID: ${sessionData.cookies.ds_user_id}`));
  console.log(kleur.gray(`   Created: ${sessionData.createdAt || 'unknown'}`));

  // Encode to base64
  const sessionJson = JSON.stringify(sessionData);
  const base64 = Buffer.from(sessionJson, 'utf8').toString('base64');

  console.log(kleur.gray(`\n   Original size: ${sessionJson.length} chars`));
  console.log(kleur.gray(`   Base64 size:   ${base64.length} chars`));

  // Save to file
  const outputPath = resolve(projectRoot, 'ig-session-base64.txt');
  writeFileSync(outputPath, base64, 'utf8');

  console.log(kleur.green(`\n💾 Base64 session saved to:`));
  console.log(kleur.white(`   ${outputPath}`));

  // Print instructions
  console.log(kleur.cyan('\n═══════════════════════════════════════════'));
  console.log(kleur.cyan('  Instructions for Railway'));
  console.log(kleur.cyan('═══════════════════════════════════════════\n'));

  console.log(kleur.yellow('Step 1: Copy the base64 string'));
  console.log(kleur.gray('   (from ig-session-base64.txt or from below)\n'));

  console.log(kleur.yellow('Step 2: In Railway dashboard'));
  console.log(kleur.gray('   Go to your service → Variables tab\n'));

  console.log(kleur.yellow('Step 3: Add new variable'));
  console.log(kleur.gray('   Key:   IG_SESSION_BASE64'));
  console.log(kleur.gray('   Value: [paste the base64 string here]\n'));

  console.log(kleur.yellow('Step 4: Deploy'));
  console.log(kleur.gray('   Railway will redeploy automatically\n'));

  console.log(kleur.cyan('───────────────────────────────────────────'));
  console.log(kleur.cyan('  Base64 Session String'));
  console.log(kleur.cyan('───────────────────────────────────────────'));
  console.log(kleur.gray('(copy everything below this line)\n'));
  console.log(kleur.white(base64));
  console.log(kleur.gray('\n───────────────────────────────────────────\n'));

  // Try to copy to clipboard
  try {
    const { exec } = await import('child_process');
    const platform = process.platform;
    let command;

    if (platform === 'win32') {
      command = `echo ${base64} | clip`;
    } else if (platform === 'darwin') {
      command = `echo "${base64}" | pbcopy`;
    } else {
      // Linux - try xclip, then xsel
      try {
        exec(`echo "${base64}" | xclip -selection clipboard`);
        console.log(kleur.green('✓ Copied to clipboard (xclip)\n'));
      } catch {
        exec(`echo "${base64}" | xsel --clipboard --input`);
        console.log(kleur.green('✓ Copied to clipboard (xsel)\n'));
      }
      process.exit(0);
    }

    exec(command);
    console.log(kleur.green('✓ Copied to clipboard\n'));
  } catch (e) {
    console.log(kleur.yellow('⚠️ Could not copy to clipboard automatically.'));
    console.log(kleur.gray('   Copy the base64 string manually from above.\n'));
  }

  // Security note
  console.log(kleur.yellow('⚠️  Security note:'));
  console.log(kleur.gray('   - This string contains your Instagram session'));
  console.log(kleur.gray('   - Treat it like a password'));
  console.log(kleur.gray('   - Don\'t commit ig-session-base64.txt to git'));
  console.log(kleur.gray('   - Delete it after setting the env var\n'));

  process.exit(0);
}

main().catch(e => {
  console.error(kleur.red(`\n❌ Error: ${e.message}\n`));
  process.exit(1);
});
