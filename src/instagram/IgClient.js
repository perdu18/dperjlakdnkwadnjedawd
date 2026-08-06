/**
 * instagram/IgClient.js
 * Wrapper برای Instagram Web API
 *
 * این نسخه از Playwright برای fetch کردن پست‌ها و استوری‌ها استفاده می‌کنه
 * چون API endpointهای قدیمی Instagram حذف شدن و بدون مرورگر واقعی کار نمی‌کنن.
 *
 * Session: فایل JSON حاوی cookies که توسط scripts/setup-instagram.js ساخته میشه.
 *
 * نکته مهم درباره پروکسی:
 * - برای Instagram، باید از یک پروکسی ثابت (sticky) استفاده بشه
 * - تغییر مداوم IP باعث میشه Instagram session رو باطل کنه
 * - اگه PROXY_MODE=list باشه، برای Instagram پروکسی غیرفعال میشه
 */

import { chromium } from 'playwright';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import config from '../config/env.js';
import { igLogger as log } from '../utils/Logger.js';
import { randomDelay, sleep } from '../utils/Helpers.js';
import proxyManager from '../proxy/ProxyManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

const IG_BASE = 'https://www.instagram.com';
const IG_API = 'https://www.instagram.com/api/v1';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IG_APP_ID = '936619743392459';

/**
 * Convert cookie jar object to Playwright cookie array
 */
function jarToPlaywrightCookies(jar, domain = 'instagram.com') {
  return Object.entries(jar).map(([name, value]) => ({
    name,
    value,
    domain: `.${domain}`,
    path: '/',
  }));
}

class IgClient {
  constructor() {
    this.session = null;
    this.sessionFilePath = null;
    this.isLoggedIn = false;
    this.currentUser = null;
    this.stickyProxy = null;
    this.lastError = null;
    this.lastErrorAt = null;

    // Browser pool (lazy loaded)
    this.browser = null;
    this.context = null;
    this.browserLastActivity = null;
    this.browserIdleTimeout = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Initialize the client
   */
  init() {
    this._setupSessionPath();
    log.info({ msg: 'Instagram client initialized (Playwright-based)', username: config.instagram.username });
  }

  /**
   * Setup session file path
   */
  _setupSessionPath() {
    const sessionDir = resolve(projectRoot, config.instagram.sessionDir);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    this.sessionFilePath = join(sessionDir, `${config.instagram.username}.web-session.json`);
  }

  /**
   * Login or restore session
   */
  async login() {
    const restored = await this._restoreSession();
    if (restored) {
      log.info('Instagram session restored');

      // Verify via API (lightweight check)
      const valid = await this._verifySession();
      if (valid) {
        this.isLoggedIn = true;
        log.info('Session verified, login successful');
        return;
      }

      this.lastError = 'Session verification failed';
      this.lastErrorAt = new Date().toISOString();
      log.warn({ msg: 'Session may be invalid', error: this.lastError });
      // Continue anyway - Playwright might still work
      this.isLoggedIn = true;
      return;
    }

    this.lastError = `Session file not found at: ${this.sessionFilePath}`;
    this.lastErrorAt = new Date().toISOString();
    log.error({ msg: 'No Instagram session found', path: this.sessionFilePath });
    throw new Error('No Instagram session found. Run: npm run setup:instagram');
  }

  /**
   * Restore session from file or env var
   */
  async _restoreSession() {
    if (!existsSync(this.sessionFilePath)) {
      log.warn({ msg: 'Session file does not exist', path: this.sessionFilePath });

      // List session dir for debugging
      try {
        const sessionDir = dirname(this.sessionFilePath);
        if (existsSync(sessionDir)) {
          const { readdirSync } = await import('fs');
          const files = readdirSync(sessionDir);
          log.warn({ msg: 'Files in session directory', dir: sessionDir, files });
        }
      } catch (e) {}

      // Try IG_SESSION_BASE64 env var
      const sessionBase64 = process.env.IG_SESSION_BASE64;
      if (sessionBase64) {
        log.info('Found IG_SESSION_BASE64 env var, attempting to restore session from it');
        const restored = await this._restoreSessionFromBase64(sessionBase64);
        if (restored) return true;
      }
      return false;
    }

    try {
      const stateStr = readFileSync(this.sessionFilePath, 'utf8');
      this.session = JSON.parse(stateStr);

      if (!this.session.cookies || !this.session.cookies.csrftoken) {
        this.lastError = 'Session file is invalid (missing cookies)';
        log.warn(this.lastError);
        return false;
      }

      log.info({
        msg: 'Session file loaded',
        cookieCount: Object.keys(this.session.cookies).length,
        hasSessionId: !!this.session.cookies.sessionid,
        hasDsUserId: !!this.session.cookies.ds_user_id,
        username: this.session.username,
      });

      return true;
    } catch (e) {
      this.lastError = `Could not restore session: ${e.message}`;
      log.error({ msg: 'Could not restore session', error: e.message });
      return false;
    }
  }

  /**
   * Restore session from base64-encoded JSON
   */
  async _restoreSessionFromBase64(sessionBase64) {
    try {
      const sessionJson = Buffer.from(sessionBase64, 'base64').toString('utf8');
      const sessionData = JSON.parse(sessionJson);

      if (!sessionData.cookies || !sessionData.cookies.csrftoken) {
        this.lastError = 'Session from env var is invalid (missing cookies)';
        return false;
      }

      this.session = sessionData;

      log.info({
        msg: 'Session loaded from IG_SESSION_BASE64 env var',
        cookieCount: Object.keys(this.session.cookies).length,
        username: this.session.username,
      });

      // Try to save to file
      try {
        const { writeFileSync } = await import('fs');
        const sessionDir = dirname(this.sessionFilePath);
        if (!existsSync(sessionDir)) {
          mkdirSync(sessionDir, { recursive: true });
        }
        writeFileSync(this.sessionFilePath, sessionJson, 'utf8');
        log.info({ msg: 'Session file saved from env var', path: this.sessionFilePath });
      } catch (e) {}

      return true;
    } catch (e) {
      this.lastError = `Could not restore session from env var: ${e.message}`;
      log.error({ msg: 'Could not restore session from IG_SESSION_BASE64', error: e.message });
      return false;
    }
  }

  /**
   * Get or create browser instance
   *
   * مرورگر رو در pool نگه می‌داریم و در صورت idle بودن بیش از 5 دقیقه می‌بندیم
   * تا memory مصرف نشه.
   */
  async _getBrowser() {
    // Check if browser is alive and not idle too long
    if (this.browser && this.context) {
      const idleTime = Date.now() - this.browserLastActivity;
      if (idleTime < this.browserIdleTimeout) {
        // Try to verify browser is still alive
        try {
          await this.context.pages();
          this.browserLastActivity = Date.now();
          return { browser: this.browser, context: this.context };
        } catch (e) {
          log.warn({ msg: 'Browser context lost, recreating', error: e.message });
          await this._closeBrowser();
        }
      } else {
        log.info('Browser idle too long, closing');
        await this._closeBrowser();
      }
    }

    // Build proxy config
    const proxyConfig = this._buildProxyConfig();

    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
      ],
    };

    if (proxyConfig) {
      launchOptions.proxy = proxyConfig;
    }

    log.info({ msg: 'Launching browser for IG fetch', hasProxy: !!proxyConfig });
    const browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: this.session.userAgent || BROWSER_UA,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    // Add cookies to context
    const cookies = jarToPlaywrightCookies(this.session.cookies);
    await context.addCookies(cookies);

    this.browser = browser;
    this.context = context;
    this.browserLastActivity = Date.now();

    return { browser, context };
  }

  /**
   * Close browser instance
   */
  async _closeBrowser() {
    try {
      if (this.context) await this.context.close();
    } catch {}
    try {
      if (this.browser) await this.browser.close();
    } catch {}
    this.browser = null;
    this.context = null;
  }

  /**
   * Build proxy config for Playwright
   */
  _buildProxyConfig() {
    const proxyMode = (config.proxy.mode || 'none').toLowerCase();

    if (proxyMode === 'static' && config.proxy.staticUrl) {
      try {
        const url = new URL(config.proxy.staticUrl);
        const protocol = url.protocol.replace(':', '').toLowerCase();

        if (protocol === 'socks5' || protocol === 'socks4' || protocol === 'http' || protocol === 'https') {
          const proxyConfig = {
            server: `${protocol}://${url.hostname}:${url.port || 1080}`,
          };

          if (url.username) {
            proxyConfig.username = decodeURIComponent(url.username);
          }
          if (url.password) {
            proxyConfig.password = decodeURIComponent(url.password);
          }

          this.stickyProxy = {
            type: protocol,
            host: url.hostname,
            port: parseInt(url.port, 10) || 1080,
          };

          return proxyConfig;
        }
      } catch (e) {
        log.warn({ msg: 'Could not parse proxy URL', error: e.message });
      }
    } else if (proxyMode === 'list') {
      log.warn({
        msg: 'PROXY_MODE=list detected - using no proxy for IG fetches',
        reason: 'Free proxies are unstable for IG sessions',
      });
    }

    return null;
  }

  /**
   * Verify session via API (lightweight)
   */
  async _verifySession() {
    const essential = ['sessionid', 'csrftoken', 'ds_user_id'];
    const missing = essential.filter(c => !this.session.cookies[c]);
    if (missing.length > 0) {
      this.lastError = `Missing essential cookies: ${missing.join(', ')}`;
      return false;
    }

    // Try a quick API call
    try {
      const cookieStr = Object.entries(this.session.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

      const agent = this.stickyProxy ? this._createProxyAgent(this.stickyProxy) : null;

      const res = await axios.get(`${IG_API}/web/accounts/current_user/?include_dummy=true`, {
        timeout: 15000,
        httpsAgent: agent,
        httpAgent: agent,
        maxRedirects: 0,
        validateStatus: () => true,
        headers: {
          'User-Agent': this.session.userAgent || BROWSER_UA,
          'Cookie': cookieStr,
          'X-CSRFToken': this.session.cookies.csrftoken,
          'X-IG-App-ID': IG_APP_ID,
          'Referer': `${IG_BASE}/`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (res.data?.viewer?.is_logged_in === true) {
        this.currentUser = res.data.viewer;
        log.info({ msg: 'Session verified via API', userId: this.currentUser.id });
        return true;
      }

      if (res.data?.user?.username) {
        this.currentUser = res.data.user;
        return true;
      }

      // JSON response indicates session might still work
      const ct = res.headers?.['content-type'] || '';
      if (res.status === 200 && ct.includes('application/json')) {
        log.info({ msg: 'Session likely valid (JSON response)', status: res.status });
        return true;
      }

      log.warn({ msg: 'Session verification via API failed', status: res.status });
      // Don't fail - Playwright might still work
      return true;
    } catch (e) {
      log.warn({ msg: 'API verification error', error: e.message });
      // Don't fail - Playwright might still work
      return true;
    }
  }

  /**
   * Create proxy agent from proxy object
   */
  _createProxyAgent(proxy) {
    if (!proxy) return null;
    try {
      const url = proxy.username
        ? `${proxy.type}://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`
        : `${proxy.type}://${proxy.host}:${proxy.port}`;

      if (proxy.type === 'socks5' || proxy.type === 'socks4') {
        return new SocksProxyAgent(url);
      }
      return new HttpsProxyAgent(url);
    } catch (e) {
      return null;
    }
  }

  /**
   * Get user info by username (via Playwright)
   */
  async getUserByUsername(username) {
    log.info({ msg: 'Fetching user info', username });

    const { browser, context } = await this._getBrowser();
    const page = await context.newPage();

    try {
      await page.goto(`${IG_BASE}/${encodeURIComponent(username)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(2000);

      // Check if we're logged in (not redirected to login)
      const url = page.url();
      if (url.includes('/accounts/login') || url.includes('auth_platform')) {
        throw new Error(`Session expired - redirected to login when fetching @${username}`);
      }

      // Extract user info from page
      const userInfo = await page.evaluate(() => {
        // Try to extract from window._sharedData
        const sharedData = window._sharedData;
        if (sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user) {
          return sharedData.entry_data.ProfilePage[0].graphql.user;
        }

        // Try to extract from meta tags
        const metaOgTitle = document.querySelector('meta[property="og:title"]');
        const metaOgImage = document.querySelector('meta[property="og:image"]');
        const metaOgDescription = document.querySelector('meta[property="og:description"]');

        if (metaOgTitle) {
          const title = metaOgTitle.content || '';
          // Title format: "@username • Instagram photos and videos"
          const match = title.match(/@([a-zA-Z0-9._]+)/);
          const username = match ? match[1] : null;

          // Try to extract follower/post counts from description
          let followerCount = 0;
          let mediaCount = 0;
          if (metaOgDescription?.content) {
            const fMatch = metaOgDescription.content.match(/([\d,.]+)\s+Followers/);
            const mMatch = metaOgDescription.content.match(/([\d,.]+)\s+Posts/);
            if (fMatch) followerCount = parseInt(fMatch[1].replace(/[,.]/g, ''));
            if (mMatch) mediaCount = parseInt(mMatch[1].replace(/[,.]/g, ''));
          }

          return {
            username,
            full_name: null,
            profile_pic_url: metaOgImage?.content || null,
            follower_count: followerCount,
            media_count: mediaCount,
            is_private: false,
            is_verified: false,
            id: null,
            biography: null,
          };
        }

        return null;
      });

      if (!userInfo) {
        throw new Error(`Could not extract user info for @${username}`);
      }

      log.info({ msg: 'User info fetched', username: userInfo.username });

      return {
        pk: userInfo.id || null,
        username: userInfo.username || username,
        fullName: userInfo.full_name,
        isPrivate: userInfo.is_private,
        isVerified: userInfo.is_verified,
        profilePicUrl: userInfo.profile_pic_url,
        followerCount: userInfo.follower_count,
        followingCount: userInfo.following_count,
        mediaCount: userInfo.media_count,
        biography: userInfo.biography,
      };
    } finally {
      await page.close();
      this.browserLastActivity = Date.now();
    }
  }

  /**
   * Get user feed (recent posts) via Playwright
   *
   * روش کار:
   *   1. رفتن به صفحه پروفایل کاربر
   *   2. استخراج shortcodes پست‌ها از لینک‌های DOM (a[href*="/p/"])
   *   3. برای هر پست، رفتن به صفحه /p/{shortcode}/ و استخراج URL مدیا
   *
   * این روش مطمئن‌تره چون:
   *   - به window._sharedData (که حذف شده) وابسته نیست
   *   - هر پست صفحه جداگانه داره با اطلاعات کامل
   *   - caption, takenAt, URLs همگی قابل استخراج هستن
   */
  async getUserFeed(pkOrUsername, options = {}) {
    const { limit = 10 } = options;
    const username = typeof pkOrUsername === 'string' && !pkOrUsername.match(/^\d+$/)
      ? pkOrUsername
      : await this._getUsernameByPk(pkOrUsername);

    log.info({ msg: 'Fetching user feed', username, limit });

    const { browser, context } = await this._getBrowser();
    const page = await context.newPage();

    try {
      // Step 1: Navigate to profile page
      log.info({ msg: 'Step 1: Loading profile page', username });
      await page.goto(`${IG_BASE}/${encodeURIComponent(username)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // Check login
      const url = page.url();
      if (url.includes('/accounts/login') || url.includes('auth_platform')) {
        throw new Error(`Session expired - redirected to login`);
      }

      // Step 2: Extract shortcodes from DOM
      log.info({ msg: 'Step 2: Extracting post shortcodes from DOM', username });
      const shortcodes = await page.evaluate((maxPosts) => {
        // Try multiple selectors for post links
        const selectors = [
          'a[href*="/p/"]',
          'a[href*="/reel/"]',
          'div[role="button"] a[href*="/p/"]',
          'article a[href*="/p/"]',
        ];

        const found = new Set();
        for (const sel of selectors) {
          const links = document.querySelectorAll(sel);
          for (const link of links) {
            const href = link.getAttribute('href') || '';
            const match = href.match(/\/(?:p|reel)\/([^/]+)/);
            if (match && match[1]) {
              found.add({
                shortcode: match[1],
                isReel: href.includes('/reel/'),
              });
            }
            if (found.size >= maxPosts) break;
          }
          if (found.size >= maxPosts) break;
        }

        return Array.from(found).slice(0, maxPosts);
      }, limit);

      log.info({
        msg: 'Shortcodes extracted',
        count: shortcodes.length,
        username,
        shortcodes: shortcodes.map(s => s.shortcode),
      });

      if (shortcodes.length === 0) {
        log.warn({ msg: 'No post links found on profile page', username });
        return [];
      }

      // Step 3: For each shortcode, fetch post details
      log.info({ msg: 'Step 3: Fetching post details for each shortcode', count: shortcodes.length });
      const posts = [];
      for (const { shortcode, isReel } of shortcodes) {
        try {
          const postDetails = await this._fetchPostDetails(page, shortcode, isReel, username);
          if (postDetails) {
            posts.push(postDetails);
            log.debug({
              msg: 'Post details fetched',
              shortcode,
              type: postDetails.type,
              mediaUrlCount: postDetails.mediaUrls?.length || 0,
              hasCaption: !!postDetails.caption,
            });
          }
        } catch (e) {
          log.warn({ msg: 'Failed to fetch post details', shortcode, error: e.message });
        }

        // Small delay between posts
        await page.waitForTimeout(1000);
      }

      log.info({
        msg: 'All post details fetched',
        count: posts.length,
        withMediaUrls: posts.filter(p => p.mediaUrls?.length > 0).length,
        username,
      });

      // Cache username→pk mapping (if we got user info)
      return posts.map(p => this._normalizePost(p, { username }));

    } finally {
      await page.close();
      this.browserLastActivity = Date.now();
    }
  }

  /**
   * Fetch details for a single post by shortcode
   *
   * این متد به صفحه /p/{shortcode}/ (یا /reel/{shortcode}/) میره و اطلاعات کامل رو استخراج می‌کنه:
   *   - URLs مدیا (فقط از همین پست، نه پست‌های پیشنهادی)
   *   - Caption کامل
   *   - Timestamp
   *   - نوع پست (photo/video/carousel/reel)
   *   - تعداد likes/comments
   *   - تعداد بازدید ویدیو
   *   - اطلاعات موزیک (برای reels)
   *
   * نکته مهم: برای reels از /reel/{shortcode}/ استفاده می‌کنیم.
   */
  async _fetchPostDetails(page, shortcode, isReelHint, ownerUsername) {
    // Reels have /reel/ URL instead of /p/
    const postUrl = isReelHint
      ? `${IG_BASE}/reel/${shortcode}/`
      : `${IG_BASE}/p/${shortcode}/`;

    log.info({ msg: 'Fetching post details', shortcode, url: postUrl, isReelHint });

    await page.goto(postUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Check login
    const url = page.url();
    if (url.includes('/accounts/login') || url.includes('auth_platform')) {
      throw new Error('Session expired - redirected to login');
    }

    // Detect reel from final URL (in case Instagram redirected)
    const isReel = url.includes('/reel/') || isReelHint;

    // For reels/videos, wait for video element to load
    if (isReelHint || isReel) {
      try {
        await page.waitForSelector('video source, video[src*="fbcdn"], video[src*="cdninstagram"]', {
          timeout: 10000,
        });
        log.debug({ msg: 'Video element found, waiting for src to load', shortcode });
        await page.waitForTimeout(2000);
      } catch (e) {
        log.warn({ msg: 'Video element not found, proceeding anyway', shortcode, error: e.message });
      }
    } else {
      // For photos/carousels, wait for images to load
      try {
        await page.waitForSelector('img[src*="fbcdn"], img[src*="cdninstagram"]', {
          timeout: 10000,
        });
      } catch (e) {
        log.warn({ msg: 'Image element not found, proceeding anyway', shortcode });
      }
    }

    // Extract post details from page DOM and meta tags
    const details = await page.evaluate((sc, reelHint) => {
      const result = {
        shortcode: sc,
        mediaUrls: [],
        carouselItems: [],
        caption: '',
        takenAt: 0,
        type: 'photo',
        isVideo: false,
        isReel: false,
        likeCount: 0,
        commentCount: 0,
        viewCount: 0,
        musicInfo: null,
        location: null,
        usertags: [],
      };

      // ============================================
      // Step 1: Get OG meta tags (reliable)
      // ============================================
      const ogImage = document.querySelector('meta[property="og:image"]');
      const ogVideo = document.querySelector('meta[property="og:video"]');
      const ogVideoTag = document.querySelector('meta[property="og:video:type"]');
      const ogType = document.querySelector('meta[property="og:type"]');
      const ogDescription = document.querySelector('meta[property="og:description"]');
      const ogTitle = document.querySelector('meta[property="og:title"]');

      // ============================================
      // Step 2: Find the main article element (the post container)
      // Instagram has ONE main article for the post; other articles are suggestions
      // ============================================
      const articles = document.querySelectorAll('article');
      // The main article is usually the first one with substantial content
      let mainArticle = null;
      for (const art of articles) {
        // Check if this article has media (img or video)
        const hasMedia = art.querySelector('img[src*="fbcdn"], video[src*="fbcdn"], video source[src*="fbcdn"]');
        if (hasMedia) {
          mainArticle = art;
          break;
        }
      }
      // Fallback to body if no article found
      const mainContent = mainArticle || document.body;

      // ============================================
      // Step 3: Find media in the main article ONLY
      // This prevents collecting images from suggested posts
      //
      // نکته مهم: Instagram گاهی src رو با تأخیر لود می‌کنه. برای همین:
      //   - اول از src استفاده می‌کنیم
      //   - اگه خالی بود، از data-src یا srcset استفاده می‌کنیم
      //   - در نهایت og:image رو به‌عنوان fallback داریم
      // ============================================
      const allImages = Array.from(mainContent.querySelectorAll('img'));
      const cdnImages = allImages.filter(img => {
        // Try src first
        let src = img.src || img.getAttribute('src') || '';
        // Fallback to data-src (lazy loading)
        if (!src) src = img.getAttribute('data-src') || '';
        // Fallback to srcset (responsive images - take the first URL)
        if (!src) {
          const srcset = img.getAttribute('srcset') || '';
          if (srcset) {
            const firstUrl = srcset.split(',')[0]?.trim().split(' ')[0];
            if (firstUrl) src = firstUrl;
          }
        }
        // Also set the src on the element so later code can access it
        if (src && !img.src) {
          try { img.src = src; } catch {}
        }
        return src.includes('fbcdn.net') || src.includes('cdninstagram');
      });

      const allVideos = Array.from(mainContent.querySelectorAll('video'));
      const cdnVideos = allVideos.filter(video => {
        const src = video.src || video.getAttribute('src') || '';
        const source = video.querySelector('source');
        const sourceSrc = source?.src || source?.getAttribute('src') || '';
        return src.includes('fbcdn.net') || sourceSrc.includes('fbcdn.net') ||
               src.includes('cdninstagram') || sourceSrc.includes('cdninstagram');
      });

      const videoSources = Array.from(mainContent.querySelectorAll('video source'))
        .filter(s => {
          const src = s.src || s.getAttribute('src') || '';
          return src.includes('fbcdn.net') || src.includes('cdninstagram');
        })
        .map(s => ({ src: s.src, type: s.getAttribute('type') || '' }));

      // ============================================
      // Step 4: Determine post type
      // ============================================
      const hasVideo = cdnVideos.length > 0 || videoSources.length > 0 || !!ogVideo;
      const isReelPost = reelHint || location.pathname.includes('/reel/');
      const isCarousel = !hasVideo && cdnImages.length > 1;

      result.isVideo = hasVideo;
      result.isReel = isReelPost && hasVideo;

      if (isReelPost && hasVideo) {
        result.type = 'reel';
      } else if (isCarousel) {
        result.type = 'carousel';
      } else if (hasVideo) {
        result.type = 'video';
      } else {
        result.type = 'photo';
      }

      // ============================================
      // Step 5: Extract media URLs
      // ============================================
      if (result.type === 'carousel') {
        // Multiple images (carousel) — only from main article
        cdnImages.forEach(img => {
          const src = img.src || img.getAttribute('src');
          if (src && !result.mediaUrls.includes(src)) {
            result.mediaUrls.push(src);
            result.carouselItems.push({
              type: 'photo',
              url: src,
              width: img.naturalWidth || null,
              height: img.naturalHeight || null,
            });
          }
        });
      } else if (hasVideo) {
        // Single video or reel
        // Prefer video sources (higher quality)
        let videoUrl = null;
        let videoType = '';
        if (videoSources.length > 0) {
          // Pick the highest quality (usually the last/mp4)
          videoUrl = videoSources[videoSources.length - 1].src;
          videoType = videoSources[videoSources.length - 1].type;
        }
        if (!videoUrl && cdnVideos[0]) {
          videoUrl = cdnVideos[0].src || cdnVideos[0].getAttribute('src');
        }
        if (!videoUrl && ogVideo) {
          videoUrl = ogVideo.content;
        }

        if (videoUrl) {
          result.mediaUrls.push(videoUrl);
          result.carouselItems.push({
            type: 'video',
            url: videoUrl,
            mime: videoType || 'video/mp4',
          });
        }
      } else if (cdnImages[0]) {
        // Single image — prefer larger versions
        let bestImg = cdnImages[0];
        // Find the image with largest dimensions
        let maxArea = 0;
        for (const img of cdnImages) {
          const area = (img.naturalWidth || 0) * (img.naturalHeight || 0);
          if (area > maxArea) {
            maxArea = area;
            bestImg = img;
          }
        }
        const imgSrc = bestImg.src || bestImg.getAttribute('src');
        if (imgSrc) {
          result.mediaUrls.push(imgSrc);
          result.carouselItems.push({
            type: 'photo',
            url: imgSrc,
            width: bestImg.naturalWidth || null,
            height: bestImg.naturalHeight || null,
          });
        }
      } else if (ogImage) {
        // Fallback to og:image
        result.mediaUrls.push(ogImage.content);
        result.carouselItems.push({
          type: 'photo',
          url: ogImage.content,
        });
      }

      // ============================================
      // Step 6: Extract caption (improved selectors)
      // ============================================
      // Instagram post caption is usually in a specific element
      // Try multiple approaches to find it
      const captionSelectors = [
        // Modern Instagram
        'article div[class*="_ae1j"]',  // common caption class
        'article h1',
        'article ul li span',
        'article div[data-testid="post-caption"]',
        // Fallbacks
        'div[class*="Caption"]',
        'span[class*="Caption"]',
        'div[role="button"] span[dir="auto"]',
      ];

      for (const sel of captionSelectors) {
        const els = mainContent.querySelectorAll(sel);
        for (const el of els) {
          const text = el.textContent?.trim();
          if (text && text.length > 5 && !text.match(/^@[a-zA-Z0-9._]+$/)) {
            // Skip if it's just a number (likes/views)
            if (!/^\d+$/.test(text)) {
              result.caption = text;
              break;
            }
          }
        }
        if (result.caption) break;
      }

      // Fallback: extract caption from og:description
      if (!result.caption && ogDescription) {
        const desc = ogDescription.content || '';
        // og:description usually starts with username and has caption-like text
        // Format: "1,234 Likes, 56 Comments - @username on Instagram: caption..."
        const captionMatch = desc.match(/on Instagram:\s*(.+)$/i);
        if (captionMatch && captionMatch[1]) {
          result.caption = captionMatch[1].trim();
        } else if (desc.length > 50) {
          // Just use the description as-is (truncated)
          result.caption = desc.slice(0, 500);
        }
      }

      // ============================================
      // Step 7: Extract timestamp
      // ============================================
      const timeEl = mainContent.querySelector('time[datetime]');
      if (timeEl) {
        const datetime = timeEl.getAttribute('datetime');
        if (datetime) {
          const date = new Date(datetime);
          if (!isNaN(date.getTime())) {
            result.takenAt = Math.floor(date.getTime() / 1000);
          }
        }
      }

      // ============================================
      // Step 8: Extract likes, comments, views
      // ============================================
      const bodyText = mainContent.innerText || '';

      // Likes
      const likeMatch = bodyText.match(/([\d,.]+[KkMm]?)\s+likes?/i);
      if (likeMatch) {
        const val = likeMatch[1].toLowerCase();
        let num = parseFloat(val);
        if (val.includes('k')) num *= 1000;
        if (val.includes('m')) num *= 1000000;
        result.likeCount = Math.floor(num) || 0;
      }

      // Comments
      const commentMatch = bodyText.match(/([\d,.]+[KkMm]?)\s+comments?/i);
      if (commentMatch) {
        const val = commentMatch[1].toLowerCase();
        let num = parseFloat(val);
        if (val.includes('k')) num *= 1000;
        if (val.includes('m')) num *= 1000000;
        result.commentCount = Math.floor(num) || 0;
      }

      // Views (for videos)
      const viewMatch = bodyText.match(/([\d,.]+[KkMm]?)\s+views?/i);
      if (viewMatch) {
        const val = viewMatch[1].toLowerCase();
        let num = parseFloat(val);
        if (val.includes('k')) num *= 1000;
        if (val.includes('m')) num *= 1000000;
        result.viewCount = Math.floor(num) || 0;
      }

      // ============================================
      // Step 9: Extract music info (for reels)
      // ============================================
      if (result.isReel) {
        // Try to find audio attribution
        const audioLink = mainContent.querySelector('a[href*="/reels/audio/"], a[href*="/music/"]');
        if (audioLink) {
          const audioText = audioLink.textContent?.trim();
          if (audioText) {
            result.musicInfo = { title: audioText };
          }
        }
      }

      // ============================================
      // Step 10: Extract location
      // ============================================
      const locationLink = mainContent.querySelector('a[href*="/explore/locations/"]');
      if (locationLink) {
        result.location = { name: locationLink.textContent?.trim() || null };
      }

      return result;
    }, shortcode, isReel);

    // Set pk to shortcode if not set
    if (!details.pk) {
      details.pk = shortcode;
      details.id = shortcode;
    }

    log.info({
      msg: 'Post details extracted',
      shortcode,
      type: details.type,
      isReel: details.isReel,
      mediaUrls: details.mediaUrls.length,
      hasCaption: !!details.caption,
      captionLength: details.caption?.length || 0,
      takenAt: details.takenAt,
      likeCount: details.likeCount,
    });

    return details;
  }

  /**
   * Get username by pk (cached)
   */
  async _getUsernameByPk(pk) {
    if (this._pkCache?.has(String(pk))) {
      return this._pkCache.get(String(pk));
    }
    throw new Error(`Cannot resolve username from pk=${pk}. Pass username directly.`);
  }

  /**
   * Get user stories via Playwright
   *
   * Stories are accessible on user's profile page (highlighted circles at top)
   */
  async getUserStories(pkOrUsername) {
    const username = typeof pkOrUsername === 'string' && !pkOrUsername.match(/^\d+$/)
      ? pkOrUsername
      : await this._getUsernameByPk(pkOrUsername).catch(() => null);

    if (!username) {
      log.warn({ msg: 'Cannot fetch stories without username', pk: pkOrUsername });
      return [];
    }

    log.info({ msg: 'Fetching user stories', username });

    const { browser, context } = await this._getBrowser();
    const page = await context.newPage();

    try {
      await page.goto(`${IG_BASE}/${encodeURIComponent(username)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // Check login
      const url = page.url();
      if (url.includes('/accounts/login') || url.includes('auth_platform')) {
        throw new Error('Session expired - redirected to login');
      }

      // Try to find story link (red ring around profile pic)
      const storyLink = await page.$('a[href*="/stories/"]');
      if (!storyLink) {
        log.info({ msg: 'No active stories', username });
        return [];
      }

      // Click on story to open viewer
      await storyLink.click();
      await page.waitForTimeout(3000);

      // Now we should be in story viewer
      // Extract story items (each story is a video/image)
      const stories = [];
      let storyIndex = 0;
      const maxStories = 30;

      while (storyIndex < maxStories) {
        try {
          // Check if we're still in story viewer
          const storyViewer = await page.$('section[aria-label*="Story"], section._ac0a, div[role="dialog"]');
          if (!storyViewer) break;

          // Extract current story info
          const storyInfo = await page.evaluate(() => {
            // Try to find video or image
            const video = document.querySelector('video source, video');
            const img = document.querySelector('img[srcset][src*="fbcdn"]');

            // Find timestamp if available
            const timeEl = document.querySelector('time');
            const takenAt = timeEl?.getAttribute('datetime')
              ? Math.floor(new Date(timeEl.getAttribute('datetime')).getTime() / 1000)
              : 0;

            // Find owner username
            const ownerLink = document.querySelector('a[href*="/stories/"]');
            const ownerMatch = ownerLink?.getAttribute('href')?.match(/\/stories\/([^/]+)/);
            const ownerUsername = ownerMatch ? ownerMatch[1] : null;

            if (video) {
              const src = video.src || video.getAttribute('src');
              if (src) {
                return {
                  type: 'video',
                  url: src,
                  thumbnail: null,
                  takenAt,
                  ownerUsername,
                };
              }
            }

            if (img) {
              const src = img.src || img.getAttribute('src');
              if (src) {
                return {
                  type: 'photo',
                  url: src,
                  thumbnail: src,
                  takenAt,
                  ownerUsername,
                };
              }
            }

            return null;
          });

          if (storyInfo) {
            stories.push({
              pk: `story_${Date.now()}_${storyIndex}`,
              id: `story_${Date.now()}_${storyIndex}`,
              type: 'story',
              subtype: storyInfo.type,
              isVideo: storyInfo.type === 'video',
              caption: '',
              takenAt: storyInfo.takenAt || Math.floor(Date.now() / 1000),
              takenAtIso: storyInfo.takenAt
                ? new Date(storyInfo.takenAt * 1000).toISOString()
                : new Date().toISOString(),
              mediaUrl: storyInfo.url,
              thumbnailUrl: storyInfo.thumbnail,
              ownerUsername: storyInfo.ownerUsername || username,
              mentions: [],
              hashtags: [],
              isCloseFriends: false,
            });
            log.debug({ msg: 'Story extracted', index: storyIndex, type: storyInfo.type });
          }

          // Click next (right side of viewer)
          await page.keyboard.press('ArrowRight');
          await page.waitForTimeout(2000);
          storyIndex++;

        } catch (e) {
          log.debug({ msg: 'Error extracting story', index: storyIndex, error: e.message });
          break;
        }
      }

      log.info({ msg: 'Stories fetched', count: stories.length, username });
      return stories;

    } finally {
      try { await page.close(); } catch {}
      this.browserLastActivity = Date.now();
    }
  }

  /**
   * Normalize a post to our standard format
   */
  _normalizePost(p, user) {
    const type = p.type || (p.isVideo ? 'video' : 'photo');
    const isReel = p.isReel || (type === 'reel');

    return {
      pk: String(p.pk),
      id: String(p.id),
      type,
      mediaType: type === 'carousel' ? 8 : (type === 'video' || type === 'reel' ? 2 : 1),
      isReel,
      isVideo: p.isVideo || type === 'video' || type === 'reel',
      caption: p.caption || '',
      shortcode: p.shortcode,
      takenAt: p.takenAt,
      takenAtIso: p.takenAt ? new Date(p.takenAt * 1000).toISOString() : null,
      mediaUrls: p.mediaUrls || [],
      carouselItems: p.carouselItems || [],
      likeCount: p.likeCount || 0,
      commentCount: p.commentCount || 0,
      viewCount: p.viewCount || 0,
      location: p.location || null,
      user: {
        pk: user?.id,
        username: user?.username,
        fullName: user?.full_name,
        profilePicUrl: user?.profile_pic_url,
        isVerified: user?.is_verified,
      },
      music: p.musicInfo || null,
      usertags: p.usertags || [],
      coauthorProducers: [],
      hasAudio: p.isVideo || type === 'video' || type === 'reel',
      videoDuration: null,
      source: p.source || 'playwright',
    };
  }

  /**
   * Logout - close browser
   */
  async logout() {
    await this._closeBrowser();
    this.isLoggedIn = false;
    log.info('Logged out from Instagram');
  }

  /**
   * Persist session (no-op for now)
   */
  async persistSession() {}

  /**
   * Get debug info
   */
  getDebugInfo() {
    let sessionFileInfo = null;
    if (this.sessionFilePath && existsSync(this.sessionFilePath)) {
      try {
        const stats = statSync(this.sessionFilePath);
        sessionFileInfo = {
          path: this.sessionFilePath,
          exists: true,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        };
      } catch (e) {
        sessionFileInfo = { path: this.sessionFilePath, exists: true, error: e.message };
      }
    } else {
      sessionFileInfo = { path: this.sessionFilePath, exists: false };
    }

    return {
      isLoggedIn: this.isLoggedIn,
      sessionFile: sessionFileInfo,
      hasSession: !!this.session,
      sessionInfo: this.session ? {
        version: this.session.version,
        type: this.session.type,
        username: this.session.username,
        createdAt: this.session.createdAt,
        cookieCount: this.session.cookies ? Object.keys(this.session.cookies).length : 0,
        hasSessionId: !!this.session.cookies?.sessionid,
        hasCsrfToken: !!this.session.cookies?.csrftoken,
        hasDsUserId: !!this.session.cookies?.ds_user_id,
        dsUserId: this.session.cookies?.ds_user_id,
      } : null,
      browser: {
        isLaunched: !!this.browser,
        lastActivity: this.browserLastActivity ? new Date(this.browserLastActivity).toISOString() : null,
        idleTimeMs: this.browserLastActivity ? Date.now() - this.browserLastActivity : null,
      },
      proxy: {
        configMode: config.proxy.mode,
        stickyProxy: this.stickyProxy ? {
          host: this.stickyProxy.host,
          port: this.stickyProxy.port,
          type: this.stickyProxy.type,
        } : null,
        note: config.proxy.mode === 'list'
          ? 'Proxy DISABLED for Instagram (list mode is unstable)'
          : (config.proxy.mode === 'static' ? 'Static proxy enabled' : 'No proxy'),
      },
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      currentUser: this.currentUser ? {
        id: this.currentUser.id,
        username: this.currentUser.username,
      } : null,
    };
  }
}

const igClient = new IgClient();
export default igClient;
