/**
 * scripts/setup-telegram.js
 * ساخت session تلگرام به صورت تعاملی (یک‌بار اجرا میشه)
 *
 * این اسکریپت:
 *   1. از کاربر API_ID, API_HASH, PHONE می‌گیره
 *   2. به تلگرام وصل میشه
 *   3. کد تایید رو می‌گیره
 *   4. session string رو در فایل ذخیره می‌کنه
 *   5. (اختیاری) اطلاعاتی از کانال هدف نمایش میده
 */

import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import input from 'input';
import kleur from 'kleur';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

// Load .env
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

async function main() {
  console.log('\n' + kleur.cyan('═══════════════════════════════════════════'));
  console.log(kleur.cyan('  Telegram Session Setup'));
  console.log(kleur.cyan('  (Run this only ONCE to generate a session)'));
  console.log(kleur.cyan('═══════════════════════════════════════════\n'));

  // 1. Get credentials
  const envApiId = process.env.TG_API_ID;
  const envApiHash = process.env.TG_API_HASH;
  const envPhone = process.env.TG_PHONE;
  const envSessionName = process.env.TG_SESSION_NAME || 'ig_monitor_session';

  const apiId = parseInt(await input.text('Enter API_ID:', { default: envApiId || '' }), 10);
  const apiHash = await input.text('Enter API_HASH:', { default: envApiHash || '' });
  const phone = await input.text('Enter your phone (with country code, e.g. +98912...):', { default: envPhone || '' });

  if (!apiId || !apiHash || !phone) {
    console.log(kleur.red('\n❌ All fields are required.'));
    process.exit(1);
  }

  console.log(kleur.yellow('\n⏳ Connecting to Telegram...\n'));

  // 2. Connect
  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
    useWSS: false,
    floodSleepThreshold: 60,
  });

  await client.connect();

  // 3. Send code & login
  await client.start({
    phoneNumber: async () => phone,
    password: async () => {
      const hasPassword = await input.confirm('Do you have 2FA password enabled?', { default: false });
      if (!hasPassword) return '';
      return input.password('Enter your 2FA password: ');
    },
    phoneCode: async () => input.text('Enter the code sent to your Telegram: '),
    onError: async (err) => {
      console.log(kleur.red(`Error: ${err.message}`));
      throw err;
    },
  });

  console.log(kleur.green('\n✅ Successfully logged in!'));

  // 4. Save session
  const sessionString = client.session.save();
  const sessionDir = resolve(projectRoot, process.env.TG_SESSION_DIR || './data/tg-session');
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  const sessionFilePath = resolve(sessionDir, `${envSessionName}.session`);
  writeFileSync(sessionFilePath, sessionString, 'utf8');

  console.log(kleur.green(`\n💾 Session saved to: ${sessionFilePath}`));
  console.log(kleur.yellow('\n📝 Also set this as TG_SESSION_STRING in your Railway environment:'));
  console.log(kleur.gray('─'.repeat(60)));
  console.log(kleur.white(sessionString));
  console.log(kleur.gray('─'.repeat(60)));

  // 5. Show user info
  const me = await client.getMe();
  console.log(kleur.cyan(`\n👤 Logged in as: ${me.firstName} ${me.lastName || ''} (@${me.username || 'no_username'}) [ID: ${me.id}]`));

  // 6. Optionally check channel
  const checkChannel = await input.confirm('\nDo you want to verify the target channel?', { default: true });
  if (checkChannel) {
    const channelId = process.env.TG_CHANNEL_ID || await input.text('Enter channel ID or username (e.g. @mychannel):');
    try {
      const entity = await client.getInputEntity(channelId);
      const fullEntity = await client.getEntity(entity);
      console.log(kleur.green(`\n✅ Channel found: ${fullEntity.title || fullEntity.firstName || fullEntity.username}`));
      console.log(kleur.gray(`   ID: ${fullEntity.id.toString()}`));
      console.log(kleur.gray(`   Username: @${fullEntity.username || 'N/A'}`));
      console.log(kleur.gray(`   Type: ${fullEntity.className}`));

      // Check if user is admin (for channels)
      if (fullEntity.className === 'Channel') {
        try {
          const participant = await client.getParticipant(fullEntity, 'me');
          const isAdmin = participant.adminRights !== undefined && participant.adminRights !== null;
          console.log(kleur.cyan(`   You are: ${isAdmin ? 'ADMIN ✅' : 'MEMBER'}`));
          if (!isAdmin) {
            console.log(kleur.yellow('   ⚠️ You are not an admin. Make sure you have permission to post messages.'));
          }
        } catch (e) {
          console.log(kleur.yellow(`   ⚠️ Could not check admin status: ${e.message}`));
        }
      }
    } catch (e) {
      console.log(kleur.red(`\n❌ Could not find channel: ${e.message}`));
      console.log(kleur.yellow('   Make sure:'));
      console.log(kleur.yellow('   1. The channel exists'));
      console.log(kleur.yellow('   2. Your account is a member of the channel'));
      console.log(kleur.yellow('   3. You have permission to post'));
    }
  }

  // 7. Send test message
  const sendTest = await input.confirm('\nSend a test message to the channel?', { default: false });
  if (sendTest) {
    const channelId = process.env.TG_CHANNEL_ID || await input.text('Enter channel ID or username:');
    try {
      await client.sendMessage(channelId, { message: '🤖 Test message from IG Monitor Bot setup script' });
      console.log(kleur.green('\n✅ Test message sent successfully!'));
    } catch (e) {
      console.log(kleur.red(`\n❌ Failed: ${e.message}`));
    }
  }

  await client.disconnect();
  console.log(kleur.green('\n🎉 Setup complete! You can now run: npm start\n'));
  process.exit(0);
}

main().catch(e => {
  console.error(kleur.red(`\n❌ Setup failed: ${e.message}`));
  process.exit(1);
});
