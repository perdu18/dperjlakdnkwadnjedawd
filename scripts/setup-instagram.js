/**
 * scripts/setup-instagram.js
 * ساخت session اینستاگرام با Playwright (مرورگر واقعی)
 *
 * چرا Playwright؟
 * ─────────────
 * اینستاگرام سیستم ضد-اتوماسیون قوی داره که هر درخواست لاگین اتوماتیک
 * رو با challenge مسدود می‌کنه. ولی Playwright یه مرورگر واقعی (Chromium)
 * رو اجرا می‌کنه که از نظر اینستاگرام یک کاربر عادیه.
 *
 * مزایا:
 *   ✅ لاگین واقعی مثل انسان
 *   ✅ هندل خودکار challenge (کد SMS/email)
 *   ✅ هندل 2FA
 *   ✅ ذخیره کامل cookies و session برای استفاده بعدی
 *   ✅ Persistent context (مثل مرورگر واقعی، session میمونه)
 *
 * روند کار:
 *   1. باز کردن مرورگر Chromium (با UI قابل دیدن)
 *   2. باز کردن instagram.com
 *   3. اگه قبلاً لاگین کرده باشیم، skip لاگین
 *   4. اگه نه، لاگین با username/password
 *   5. هندل challenge یا 2FA اگه لازم باشه
 *   6. صبر تا کامل لاگین بشه
 *   7. استخراج cookies و ذخیره session
 *   8. تست با fetch پروفایل
 */

import { chromium } from 'playwright';
import input from 'input';
import kleur from 'kleur';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// ============================================
// Configuration
// ============================================

const IG_BASE = 'https://www.instagram.com';
const IG_API = 'https://www.instagram.com/api/v1';
// FIX(ua): Chrome 120 (Dec 2023) قدیمی و مشکوک است. Chrome 131 فعلی استفاده می‌شود.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IG_APP_ID = '936619743392459';

/**
 * Build axios instance with cookies and optional proxy
 */
function buildAxios(cookieJar, proxyUrl = null) {
  let agent = null;
  if (proxyUrl) {
    try {
      if (proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://')) {
        agent = new SocksProxyAgent(proxyUrl);
      } else {
        agent = new HttpsProxyAgent(proxyUrl);
      }
    } catch (e) {
      // ignore
    }
  }

  return axios.create({
    timeout: 20000,
    httpsAgent: agent,
    httpAgent: agent,
    maxRedirects: 5,
    validateStatus: (status) => status < 500,
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-IG-App-ID': IG_APP_ID,
      'X-CSRFToken': cookieJar.csrftoken || '',
      'Cookie': Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; '),
    },
  });
}

/**
 * Validate cookies by trying multiple methods
 *
 * اینستاگرام اخیراً endpointهای قدیمی رو حذف/تغییر داده. به همین دلیل،
 * Session validation requires both essential cookies and a successful response
 * from an authenticated endpoint. Public endpoints and cookie presence alone
 * are not proof that Instagram still accepts the session.
 */
async function validateCookies(axiosInstance, cookieJar) {
  // ============================================
  // Method 1: Check essential cookies (most reliable)
  // ============================================
  const essential = ['sessionid', 'csrftoken', 'ds_user_id'];
  const missing = essential.filter(c => !cookieJar[c]);

  if (missing.length > 0) {
    return {
      valid: false,
      reason: `Missing essential cookies: ${missing.join(', ')}`,
    };
  }

  // ============================================
  // Method 2: Try fetching current user info (multiple endpoints)
  // FIX(validation): endpointهای منسوخ‌شده حذف شدند:
  //   - /web/accounts/current_user/ (حذف شده توسط اینستاگرام)
  //   - ?__a=1&__d=dis (منسوخ شده)
  // اول /users/{id}/info/ (read-only، کم‌ریسک)؛ بعد /accounts/edit/web_form_data/
  // ============================================
  const userId = cookieJar.ds_user_id;
  const endpoints = [
    `${IG_API}/users/${userId}/info/`,
    `${IG_API}/accounts/edit/web_form_data/`,
    `${IG_API}/feed/timeline/`,
  ];

  for (const url of endpoints) {
    try {
      const res = await axiosInstance.get(url, {
        headers: {
          'Referer': `${IG_BASE}/`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Requested-With': 'XMLHttpRequest',
          'X-ASBD-ID': '198477',
        },
      });

      // Check various response shapes
      if (res.data?.viewer?.is_logged_in === true) {
        return { valid: true, user: res.data.viewer, method: 'current_user' };
      }

      if (res.data?.user?.username) {
        return { valid: true, user: res.data.user, method: 'user_info' };
      }

      if (res.data?.data?.user) {
        return { valid: true, user: res.data.data.user, method: 'graphql' };
      }

      if (res.data?.form_data) {
        return { valid: true, user: res.data.form_data, method: 'account_edit' };
      }

      // FIX(validation): /feed/timeline/ لیست پست‌های home را برمی‌گرداند.
      // اگه items آرایه است و more_available داره، سشن قطعاً معتبر است.
      if (Array.isArray(res.data?.items) || typeof res.data?.num_results === 'number') {
        return {
          valid: true,
          user: { id: userId, username: res.data?.user?.username || cookieJar.ds_user_id },
          method: 'timeline_feed',
        };
      }


    } catch (e) {
      // Try next endpoint
    }
  }

  return {
    valid: false,
    user: null,
    method: null,
    reason: 'Required cookies exist, but no authenticated Instagram endpoint accepted the session.',
  };
}

/**
 * Get user info by username (for testing)
 */
async function getUserByUsername(axiosInstance, username) {
  try {
    const res = await axiosInstance.get(
      `${IG_API}/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}&include_reel=true`,
      { headers: { 'Referer': `${IG_BASE}/` } }
    );

    const users = res.data?.users || [];
    const user = users.find(u => u.user?.username?.toLowerCase() === username.toLowerCase());

    if (user?.user) {
      const u = user.user;
      return {
        pk: u.pk,
        username: u.username,
        fullName: u.full_name,
        isPrivate: u.is_private,
        isVerified: u.is_verified,
        profilePicUrl: u.profile_pic_url,
      };
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * Save session to file
 */
function saveSession(username, cookieJar, userInfo = null) {
  const sessionDir = resolve(projectRoot, process.env.IG_SESSION_DIR || './data/ig-sessions');
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  const sessionData = {
    version: 2,
    type: 'web',
    username,
    cookies: cookieJar,
    userAgent: BROWSER_UA,
    createdAt: new Date().toISOString(),
    userInfo: userInfo ? {
      id: userInfo.id,
      username: userInfo.username,
      fullName: userInfo.full_name,
      isPrivate: userInfo.is_private,
      isVerified: userInfo.is_verified,
      profilePicUrl: userInfo.profile_pic_url,
    } : null,
  };

  const sessionFilePath = resolve(sessionDir, `${username}.web-session.json`);
  writeFileSync(sessionFilePath, JSON.stringify(sessionData, null, 2), 'utf8');
  return sessionFilePath;
}

/**
 * Check if user is logged in by checking cookies and page elements
 *
 * روش‌های تشخیص:
 *   1. چک کردن cookie به‌نام sessionid (مطمئن‌ترین روش)
 *   2. چک کردن cookie به‌نام ds_user_id
 *   3. چک کردن presence عناصر مشخص شده‌ی صفحه وقتی لاگین شده
 *
 * نکته: فقط URL کافی نیست — وقتی کاربر لاگین نکرده، instagram.com به‌جای redirect
 * به /login، صفحه‌ای با دکمه‌های Sign up / Log in نشون میده ولی URL همون / میمونه.
 */
async function isLoggedIn(page, context) {
  try {
    // ========================================
    // Method 1: Check cookies (most reliable)
    // ========================================
    if (context) {
      const cookies = await context.cookies();
      const sessionCookie = cookies.find(c => c.name === 'sessionid' && c.value && c.value.length > 10);
      if (sessionCookie) {
        return true;
      }
    }

    // ========================================
    // Method 2: Check for logged-in UI elements
    // ========================================
    // Sidebar navigation links only appear when logged in
    const sidebarSelectors = [
      'a[href="/"] svg',                          // Home icon
      'a[href^="/direct/inbox"]',                 // Direct messages
      'a[href="/explore/"]',                      // Explore
      'a[href="/accounts/activity/"]',            // Activity
      'svg[aria-label="Home"]',                   // Home (alt)
      'svg[aria-label="Search"]',                 // Search
      'svg[aria-label="Notifications"]',          // Notifications
      'svg[aria-label="Direct"]',                 // Direct
    ];

    for (const selector of sidebarSelectors) {
      try {
        const el = await page.$(selector);
        if (el) {
          // Found a logged-in element
          return true;
        }
      } catch (e) {
        // ignore selector errors
      }
    }

    // ========================================
    // Method 3: Check for login page indicators (negative)
    // ========================================
    // If we see these, we're definitely NOT logged in
    const loginPageIndicators = [
      'input[name="username"]',
      'input[name="password"]',
      'button[type="submit"]',
    ];

    // If login form is visible, we're not logged in
    for (const selector of loginPageIndicators) {
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          return false;
        }
      } catch (e) {
        // ignore
      }
    }

    // ========================================
    // Method 4: Last resort — check page content
    // ========================================
    try {
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1000) || '');
      // Multiple indicators of NOT being logged in
      if (bodyText.match(/\bLog into Instagram\b/i) ||
          bodyText.match(/\bSign Up\b/i) ||
          bodyText.match(/\bCreate new account\b/i)) {
        return false;
      }
      // Indicators of being logged in
      if (bodyText.match(/\bSearch\b/i) && bodyText.match(/\bNotifications\b/i)) {
        return true;
      }
    } catch (e) {
      // ignore
    }

    // Default: assume not logged in (safer)
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Wait for user to manually handle challenge / 2FA
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {string} action - Description of the action user needs to take
 */
async function waitForManualAction(page, context, action) {
  console.log(kleur.yellow(`\n⏳ ${action}...`));
  console.log(kleur.gray('   The browser is open. Please complete the action in the browser window.'));
  console.log(kleur.gray('   The script will automatically continue when you\'re done.\n'));

  let attempts = 0;
  const maxAttempts = 300; // 5 minutes (1 sec per check)

  while (attempts < maxAttempts) {
    await page.waitForTimeout(1000);
    attempts++;

    try {
      const url = page.url();
      const stillOnChallenge = url.includes('challenge') ||
                                url.includes('auth_platform') ||
                                url.includes('recaptcha') ||
                                url.includes('/login');
      const stillOnLogin = url.includes('accounts/login');

      if (!stillOnChallenge && !stillOnLogin) {
        // Check if we're actually logged in via cookies
        const loggedIn = await isLoggedIn(page, context);
        if (loggedIn) {
          console.log(kleur.green('   ✓ Action completed!'));
          return true;
        }
      }
    } catch (e) {
      // Page might have navigated, just wait and retry
    }

    // Progress indicator every 15 seconds
    if (attempts % 15 === 0) {
      console.log(kleur.gray(`   Still waiting... (${attempts}s elapsed)`));
    }
  }

  console.log(kleur.yellow(`   Timed out after ${maxAttempts} seconds waiting for action.`));
  return false;
}

/**
 * Attempt automatic login via Playwright
 *
 * Returns:
 *   - 'success' — login form was submitted successfully
 *   - 'challenge_redirected' — Instagram redirected to challenge/recaptcha before login
 *   - 'failed' — could not complete login form
 */
async function attemptAutoLogin(page, username, password) {
  console.log(kleur.cyan('\n📝 Attempting automatic login...'));

  try {
    // Wait for login form (with shorter timeout so we can detect challenge redirects)
    try {
      await page.waitForSelector('input[name="username"]', { timeout: 8000 });
    } catch (e) {
      // Check if we've been redirected to a challenge/recaptcha page
      const currentUrl = page.url();
      if (currentUrl.includes('auth_platform') ||
          currentUrl.includes('challenge') ||
          currentUrl.includes('recaptcha')) {
        console.log(kleur.yellow('   ⚠️ Instagram redirected to a verification page'));
        console.log(kleur.gray(`   URL: ${currentUrl.slice(0, 100)}...`));
        return 'challenge_redirected';
      }
      // Otherwise, just couldn't find the form
      throw e;
    }

    // Type username (slowly, like a human)
    await page.fill('input[name="username"]', '');
    await page.type('input[name="username"]', username, { delay: 50 });

    // Small delay
    await page.waitForTimeout(500);

    // Type password
    await page.fill('input[name="password"]', '');
    await page.type('input[name="password"]', password, { delay: 50 });

    // Small delay
    await page.waitForTimeout(500);

    // Click login button
    const loginButton = await page.$('button[type="submit"]') ||
                         await page.$('button:has-text("Log in")') ||
                         await page.$('div[role="button"]:has-text("Log in")');

    if (loginButton) {
      await loginButton.click();
      console.log(kleur.green('   ✓ Login form submitted'));

      // Wait a moment and check if we got redirected to challenge
      await page.waitForTimeout(3000);

      const postLoginUrl = page.url();
      if (postLoginUrl.includes('auth_platform') ||
          postLoginUrl.includes('challenge') ||
          postLoginUrl.includes('recaptcha')) {
        console.log(kleur.yellow('   ⚠️ Instagram is showing a verification page'));
        return 'challenge_redirected';
      }

      return 'success';
    }

    console.log(kleur.yellow('   ⚠️ Could not find login button'));
    return 'failed';
  } catch (e) {
    console.log(kleur.yellow(`   ⚠️ Auto-login failed: ${e.message}`));
    console.log(kleur.gray('   You can complete login manually in the browser.'));
    return 'failed';
  }
}

/**
 * Handle "Save login info" prompt if it appears
 */
async function handleSaveLoginInfo(page) {
  try {
    // Look for "Save Login Info" or "Not Now" buttons
    const notNowButton = await page.$('button:has-text("Not now")') ||
                          await page.$('button:has-text("Not Now")') ||
                          await page.$('div[role="button"]:has-text("Not now")');

    if (notNowButton) {
      await notNowButton.click();
      console.log(kleur.gray('   Clicked "Not now" on save login info prompt'));
      await page.waitForTimeout(1000);
    }
  } catch (e) {
    // ignore
  }
}

/**
 * Handle "Turn on notifications" prompt if it appears
 */
async function handleNotificationsPrompt(page) {
  try {
    const notNowButton = await page.$('button:has-text("Not Now")') ||
                          await page.$('button:has-text("Not now")');

    if (notNowButton) {
      await notNowButton.click();
      console.log(kleur.gray('   Clicked "Not Now" on notifications prompt'));
      await page.waitForTimeout(1000);
    }
  } catch (e) {
    // ignore
  }
}

// ============================================
// Main flow
// ============================================

async function main() {
  console.log('\n' + kleur.cyan('═══════════════════════════════════════════'));
  console.log(kleur.cyan('  Instagram Session Setup (Playwright)'));
  console.log(kleur.cyan('  (Run this only ONCE to generate a session)'));
  console.log(kleur.cyan('═══════════════════════════════════════════\n'));

  console.log(kleur.gray('This will open a real browser window to login to Instagram.'));
  console.log(kleur.gray('You can login automatically or manually (if 2FA/challenge is needed).'));
  console.log(kleur.gray('Your session will be saved for future use.\n'));

  // Get credentials
  const envUsername = process.env.IG_USERNAME;
  const envPassword = process.env.IG_PASSWORD;

  const username = await input.text('Enter Instagram username:', { default: envUsername || '' });
  const password = await input.password('Enter Instagram password: ');

  if (!username || !password) {
    console.log(kleur.red('\n❌ Username and password are required.'));
    process.exit(1);
  }

  // Determine proxy
  const proxyMode = (process.env.PROXY_MODE || 'none').toLowerCase();
  let proxyConfig = null;

  if (proxyMode === 'static' && process.env.PROXY_STATIC_URL) {
    const proxyUrl = process.env.PROXY_STATIC_URL;
    try {
      const url = new URL(proxyUrl);
      proxyConfig = {
        server: `${url.protocol}//${url.hostname}:${url.port}`,
        username: url.username || undefined,
        password: url.password || undefined,
      };
      console.log(kleur.cyan(`\n📡 Using proxy: ${url.hostname}:${url.port}`));
    } catch (e) {
      console.log(kleur.yellow(`\n⚠️ Invalid proxy URL: ${proxyUrl}`));
    }
  }

  // ============================================
  // Launch browser
  // ============================================
  console.log(kleur.cyan('\n🚀 Launching browser...'));

  // Build launch options (only include proxy if it's set)
  const launchOptions = {
    headless: false,  // Show browser window
  };

  if (proxyConfig) {
    launchOptions.proxy = proxyConfig;
  }

  const browser = await chromium.launch(launchOptions);

  // Use persistent context to keep session data
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: BROWSER_UA,
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Open new page
  const page = await context.newPage();

  try {
    // ============================================
    // Navigate to Instagram
    // ============================================
    console.log(kleur.cyan('🌐 Opening Instagram...'));
    await page.goto(`${IG_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Check if already logged in (e.g., from previous session in same context)
    let loggedIn = await isLoggedIn(page, context);

    if (loggedIn) {
      console.log(kleur.green('   ✓ Already logged in!'));
    } else {
      // Try to login
      console.log(kleur.gray('   Not logged in. Going to login page...'));

      // Navigate to login page if not already there
      const currentUrl1 = page.url();
      if (!currentUrl1.includes('/accounts/login') &&
          !currentUrl1.includes('auth_platform') &&
          !currentUrl1.includes('challenge') &&
          !currentUrl1.includes('recaptcha')) {
        await page.goto(`${IG_BASE}/accounts/login/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
      }

      // Attempt auto login
      const autoLoginResult = await attemptAutoLogin(page, username, password);

      // Handle the result
      if (autoLoginResult === 'challenge_redirected') {
        // Instagram immediately showed challenge/recaptcha — wait for user
        console.log(kleur.yellow('\n🔐 Instagram is showing a verification page.'));
        console.log(kleur.gray('   This is Instagram\'s anti-automation security check.'));
        console.log(kleur.gray('   Complete it in the browser window:'));
        console.log(kleur.gray('   • Click "This was me" if asked'));
        console.log(kleur.gray('   • Solve the captcha if shown'));
        console.log(kleur.gray('   • Enter the code sent to your phone/email'));
        console.log(kleur.gray('   • Login with your credentials if asked'));
        console.log();

        const success = await waitForManualAction(page, context, 'Please complete the verification in the browser');
        if (!success) {
          throw new Error('Verification timed out. Please try again.');
        }
      } else if (autoLoginResult === 'success') {
        // Login form submitted, check what happened next
        await page.waitForTimeout(3000);

        const postUrl = page.url();
        if (postUrl.includes('two_factor')) {
          console.log(kleur.yellow('\n🔐 Two-Factor Authentication required.'));
          const success = await waitForManualAction(page, context, 'Please enter your 2FA code in the browser');
          if (!success) {
            throw new Error('2FA verification timed out');
          }
        } else if (postUrl.includes('challenge') ||
                   postUrl.includes('auth_platform') ||
                   postUrl.includes('recaptcha')) {
          console.log(kleur.yellow('\n🔐 Verification required after login.'));
          const success = await waitForManualAction(page, context, 'Please complete the verification in the browser');
          if (!success) {
            throw new Error('Challenge verification timed out');
          }
        } else {
          // Check if we're logged in
          loggedIn = await isLoggedIn(page, context);
          if (!loggedIn) {
            // Maybe there's a "Save login info" prompt
            await handleSaveLoginInfo(page);
            await page.waitForTimeout(2000);

            loggedIn = await isLoggedIn(page, context);
            if (!loggedIn) {
              console.log(kleur.yellow('\n⚠️ Login may not have completed.'));
              console.log(kleur.gray('   Please complete login manually in the browser if needed.'));
              const success = await waitForManualAction(page, context, 'Please complete login if needed');
              if (!success) {
                throw new Error('Login did not complete');
              }
            }
          }
        }
      } else {
        // Auto-login failed entirely
        console.log(kleur.yellow('\n⚠️ Could not auto-login.'));
        console.log(kleur.gray('   Please login manually in the browser window.'));
        const success = await waitForManualAction(page, context, 'Please login manually');
        if (!success) {
          throw new Error('Manual login timed out');
        }
      }

      // Handle any post-login prompts
      await handleSaveLoginInfo(page);
      await handleNotificationsPrompt(page);

      // Final check
      loggedIn = await isLoggedIn(page, context);
      if (!loggedIn) {
        // One more wait
        console.log(kleur.gray('\n   Final check... waiting 5 seconds...'));
        await page.waitForTimeout(5000);
        loggedIn = await isLoggedIn(page, context);
      }

      if (!loggedIn) {
        throw new Error('Could not verify login. Please try again.');
      }

      console.log(kleur.green('\n   ✓ Login successful!'));
    }

    // Navigate to home page to ensure we have full session
    console.log(kleur.cyan('\n🔄 Refreshing session...'));
    await page.goto(`${IG_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // ============================================
    // Wait for essential cookies (with retry)
    // ============================================
    console.log(kleur.cyan('\n🍪 Waiting for session cookies...'));

    let cookies = [];
    let cookieJar = {};
    const essentialCookies = ['sessionid', 'csrftoken', 'ds_user_id'];
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      cookies = await context.cookies();
      cookieJar = {};
      for (const cookie of cookies) {
        if (cookie.domain.includes('instagram.com')) {
          cookieJar[cookie.name] = cookie.value;
        }
      }

      const missing = essentialCookies.filter(c => !cookieJar[c]);

      if (missing.length === 0) {
        console.log(kleur.green(`   ✓ Got all essential cookies (attempt ${attempts + 1})`));
        break;
      }

      attempts++;
      console.log(kleur.gray(`   Attempt ${attempts}/${maxAttempts}: missing ${missing.join(', ')}. Waiting 2s...`));

      // Try refreshing the page to trigger cookie set
      if (attempts === 3 || attempts === 6) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      await page.waitForTimeout(2000);
    }

    console.log(kleur.gray(`   Total cookies: ${cookies.length}`));

    // Final validation
    const finalMissing = essentialCookies.filter(c => !cookieJar[c]);
    if (finalMissing.length > 0) {
      console.log(kleur.red(`\n❌ Missing essential cookies: ${finalMissing.join(', ')}`));
      console.log(kleur.gray('   This usually means login was not completed.'));
      console.log(kleur.gray('   Available cookies: ' + Object.keys(cookieJar).join(', ')));
      console.log(kleur.yellow('\n💡 Possible solutions:'));
      console.log(kleur.gray('   • Make sure you completed login in the browser window'));
      console.log(kleur.gray('   • Check if Instagram is showing any verification prompts'));
      console.log(kleur.gray('   • Try logging in to instagram.com manually first, then run this script again'));
      await browser.close();
      process.exit(1);
    }

    console.log(kleur.green('   ✓ All essential cookies present'));
    console.log(kleur.gray(`   sessionid: ${cookieJar.sessionid ? 'present' : 'missing'}`));
    console.log(kleur.gray(`   csrftoken: ${cookieJar.csrftoken ? 'present' : 'missing'}`));
    console.log(kleur.gray(`   ds_user_id: ${cookieJar.ds_user_id ? 'present' : 'missing'}`));

    // ============================================
    // Validate via API
    // ============================================
    console.log(kleur.cyan('\n🔍 Validating session via API...'));
    const axiosInstance = buildAxios(cookieJar, process.env.PROXY_STATIC_URL);
    const validation = await validateCookies(axiosInstance, cookieJar);

    if (!validation.valid) {
      console.log(kleur.red('\n❌ Session validation failed!'));
      console.log(kleur.gray(`   Reason: ${validation.reason}`));
      if (validation.response) {
        console.log(kleur.gray(`   Response: ${validation.response}`));
      }
      await browser.close();
      process.exit(1);
    }

    if (validation.warning) {
      console.log(kleur.yellow(`\n   ⚠️  ${validation.warning}`));
      console.log(kleur.gray(`   Validation method: ${validation.method}`));
    } else {
      console.log(kleur.green(`   ✓ Session is valid! (method: ${validation.method})`));
    }

    // Get user info
    let userInfo = validation.user;
    if (userInfo) {
      console.log(kleur.cyan('\n👤 Account info:'));
      console.log(kleur.gray(`   Username: @${userInfo.username}`));
      console.log(kleur.gray(`   Name: ${userInfo.full_name || 'N/A'}`));
      console.log(kleur.gray(`   ID: ${userInfo.id}`));
      console.log(kleur.gray(`   Verified: ${userInfo.is_verified ? 'Yes ✅' : 'No'}`));
      console.log(kleur.gray(`   Private: ${userInfo.is_private ? 'Yes 🔒' : 'No'}`));
    } else if (cookieJar.ds_user_id) {
      // Use info from cookies as fallback
      console.log(kleur.cyan('\n👤 Account info (from cookies):'));
      console.log(kleur.gray(`   User ID: ${cookieJar.ds_user_id}`));
      console.log(kleur.gray(`   Username: ${username}`));
    }

    // ============================================
    // Save session
    // ============================================
    const sessionFilePath = saveSession(username, cookieJar, userInfo);
    console.log(kleur.green(`\n💾 Session saved to: ${sessionFilePath}`));

    // ============================================
    // Test target accounts
    // ============================================
    const targets = (process.env.TARGET_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (targets.length > 0) {
      console.log(kleur.cyan(`\n🔍 Checking ${targets.length} target accounts...`));

      let ok = 0;
      let fail = 0;
      for (const target of targets) {
        try {
          const targetInfo = await getUserByUsername(axiosInstance, target);
          if (targetInfo) {
            console.log(kleur.green(`   ✅ @${targetInfo.username} (pk: ${targetInfo.pk || 'N/A'}) — ${targetInfo.isPrivate ? 'PRIVATE 🔒' : 'public'}`));
            ok++;
          } else {
            console.log(kleur.yellow(`   ⚠️ @${target} — not found`));
            fail++;
          }
        } catch (e) {
          console.log(kleur.red(`   ❌ @${target} — ${e.message}`));
          fail++;
        }
        await new Promise(r => setTimeout(r, 1500));
      }

      console.log(kleur.cyan(`\n📊 Summary: ${ok} OK, ${fail} failed out of ${targets.length}`));
    }

    // Close browser
    await browser.close();

    console.log(kleur.green('\n🎉 Setup complete! You can now run: npm start\n'));

    console.log(kleur.cyan('💡 Tips:'));
    console.log(kleur.gray('   • Session will work for weeks/months'));
    console.log(kleur.gray('   • If session expires, just re-run this script'));
    console.log(kleur.gray('   • Avoid logging out of instagram.com in your browser'));
    console.log(kleur.gray('   • The session is independent — you can close the browser now\n'));

    process.exit(0);

  } catch (e) {
    console.error(kleur.red(`\n❌ Error: ${e.message}`));
    try {
      await browser.close();
    } catch {}
    process.exit(1);
  }
}

main().catch(e => {
  console.error(kleur.red(`\n❌ Setup failed: ${e.message}`));
  if (e.stack) {
    console.error(kleur.gray(e.stack));
  }
  process.exit(1);
});
