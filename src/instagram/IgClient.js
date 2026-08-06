/**
 * instagram/IgClient.js
 * Wrapper برای Instagram Web API — فقط با GraphQL + axios (بدون Playwright)
 *
 * این نسخه از Playwright استفاده نمی‌کنه چون:
 *   - Playwright Chromium روی Railway crash می‌کنه (کمبود حافظه)
 *   - GraphQL API با cookies سریع‌تر و قابل اتکاتر هست
 *   - نیازی به مرورگر نداریم — فقط HTTP requests با cookies
 *
 * Session: فایل JSON حاوی cookies که توسط scripts/setup-instagram.js ساخته میشه.
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import config from '../config/env.js';
import { igLogger as log } from '../utils/Logger.js';
import { randomDelay } from '../utils/Helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

const IG_BASE = 'https://www.instagram.com';
const IG_API = 'https://www.instagram.com/api/v1';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IG_APP_ID = '936619743392459';

class IgClient {
  constructor() {
    this.session = null;
    this.sessionFilePath = null;
    this.isLoggedIn = false;
    this.currentUser = null;
    this.stickyProxy = null;
    this.lastError = null;
    this.lastErrorAt = null;
    this.axiosInstance = null;
  }

  init() {
    this._setupSessionPath();
    log.info({ msg: 'Instagram client initialized (GraphQL API, no Playwright)', username: config.instagram.username });
  }

  _setupSessionPath() {
    const sessionDir = resolve(projectRoot, config.instagram.sessionDir);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    this.sessionFilePath = join(sessionDir, `${config.instagram.username}.web-session.json`);
  }

  async login() {
    const restored = await this._restoreSession();
    if (restored) {
      log.info('Instagram session restored');
      const valid = await this._verifySession();
      if (valid) {
        this.isLoggedIn = true;
        log.info('Session verified, login successful');
        return;
      }
      this.lastError = 'Session verification failed';
      this.lastErrorAt = new Date().toISOString();
      log.warn({ msg: 'Session may be invalid', error: this.lastError });
      this.isLoggedIn = true;
      return;
    }

    this.lastError = `Session file not found at: ${this.sessionFilePath}`;
    this.lastErrorAt = new Date().toISOString();
    log.error({ msg: 'No Instagram session found', path: this.sessionFilePath });
    throw new Error('No Instagram session found. Run: npm run setup:instagram');
  }

  async _restoreSession() {
    if (!existsSync(this.sessionFilePath)) {
      // Try IG_SESSION_BASE64 env var
      const sessionBase64 = process.env.IG_SESSION_BASE64;
      if (sessionBase64) {
        log.info('Found IG_SESSION_BASE64 env var, restoring session from it');
        return this._restoreSessionFromBase64(sessionBase64);
      }
      return false;
    }

    try {
      const stateStr = readFileSync(this.sessionFilePath, 'utf8');
      this.session = JSON.parse(stateStr);

      if (!this.session.cookies || !this.session.cookies.csrftoken) {
        this.lastError = 'Session file is invalid (missing cookies)';
        return false;
      }

      log.info({
        msg: 'Session file loaded',
        cookieCount: Object.keys(this.session.cookies).length,
        username: this.session.username,
      });

      this._buildAxiosInstance();
      return true;
    } catch (e) {
      this.lastError = `Could not restore session: ${e.message}`;
      log.error({ msg: 'Could not restore session', error: e.message });
      return false;
    }
  }

  async _restoreSessionFromBase64(sessionBase64) {
    try {
      const sessionJson = Buffer.from(sessionBase64, 'base64').toString('utf8');
      const sessionData = JSON.parse(sessionJson);

      if (!sessionData.cookies || !sessionData.cookies.csrftoken) {
        this.lastError = 'Session from env var is invalid';
        return false;
      }

      this.session = sessionData;
      log.info({ msg: 'Session loaded from IG_SESSION_BASE64', cookieCount: Object.keys(this.session.cookies).length });

      try {
        const { writeFileSync } = await import('fs');
        const sessionDir = dirname(this.sessionFilePath);
        if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
        writeFileSync(this.sessionFilePath, sessionJson, 'utf8');
      } catch (e) {}

      this._buildAxiosInstance();
      return true;
    } catch (e) {
      this.lastError = `Could not restore session from env var: ${e.message}`;
      return false;
    }
  }

  _buildAxiosInstance() {
    const cookieStr = Object.entries(this.session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    this.axiosInstance = axios.create({
      timeout: 20000,
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
      headers: {
        'User-Agent': this.session.userAgent || BROWSER_UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-IG-App-ID': IG_APP_ID,
        'Cookie': cookieStr,
        'X-CSRFToken': this.session.cookies.csrftoken,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Requested-With': 'XMLHttpRequest',
        'X-ASBD-ID': '198477',
      },
    });
  }

  async _verifySession() {
    const essential = ['sessionid', 'csrftoken', 'ds_user_id'];
    const missing = essential.filter(c => !this.session.cookies[c]);
    if (missing.length > 0) {
      this.lastError = `Missing essential cookies: ${missing.join(', ')}`;
      return false;
    }

    try {
      const res = await this.axiosInstance.get(`${IG_API}/web/accounts/current_user/?include_dummy=true`);
      if (res.data?.viewer?.is_logged_in === true) {
        this.currentUser = res.data.viewer;
        log.info({ msg: 'Session verified via API', userId: this.currentUser.id });
        return true;
      }
      // Trust cookies even if API fails
      return true;
    } catch (e) {
      log.warn({ msg: 'API verification error', error: e.message });
      return true;
    }
  }

  /**
   * Get user info by username — GraphQL API
   */
  async getUserByUsername(username) {
    log.info({ msg: 'Fetching user info', username });

    if (!this.axiosInstance) {
      throw new Error('No axios instance — session not loaded');
    }

    const searchUrl = `${IG_API}/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}&include_reel=true`;

    const res = await this.axiosInstance.get(searchUrl, {
      headers: { 'Referer': `${IG_BASE}/` },
    });

    const users = res.data?.users || [];
    const user = users.find(u => u.user?.username?.toLowerCase() === username.toLowerCase());

    if (!user?.user) {
      throw new Error(`User @${username} not found`);
    }

    const u = user.user;
    return {
      pk: u.pk,
      username: u.username,
      fullName: u.full_name,
      isPrivate: u.is_private,
      isVerified: u.is_verified,
      profilePicUrl: u.profile_pic_url,
      followerCount: u.follower_count,
      followingCount: u.following_count,
      mediaCount: u.media_count,
      biography: null,
    };
  }

  /**
   * Get user feed (recent posts)
   *
   * روش‌های مختلف برای دریافت پست‌ها (به ترتیب اولویت):
   *   1. feed/user/{pk}/ endpoint (پایدارترین)
   *   2. GraphQL query (fallback)
   *   3. web/search/topsearch برای پیدا کردن pk
   */
  async getUserFeed(pkOrUsername, options = {}) {
    const { limit = 10 } = options;
    const username = typeof pkOrUsername === 'string' && !pkOrUsername.match(/^\d+$/)
      ? pkOrUsername
      : pkOrUsername;

    log.info({ msg: 'Fetching user feed', username, limit });

    if (!this.axiosInstance) {
      throw new Error('No axios instance — session not loaded');
    }

    // Step 1: Get user pk via search
    const searchUrl = `${IG_API}/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}&include_reel=true`;

    const searchRes = await this.axiosInstance.get(searchUrl, {
      headers: { 'Referer': `${IG_BASE}/${username}/` },
    });

    const users = searchRes.data?.users || [];
    const userMatch = users.find(u => u.user?.username?.toLowerCase() === username.toLowerCase());

    if (!userMatch?.user) {
      log.warn({ msg: 'User not found in search', username });
      return [];
    }

    const userPk = userMatch.user.pk;
    log.info({ msg: 'Found user', username, pk: userPk });

    // Step 2: Try feed/user/{pk}/ endpoint (most reliable)
    try {
      const posts = await this._getFeedViaUserEndpoint(userPk, username, limit, userMatch.user);
      if (posts.length > 0) {
        log.info({ msg: 'Feed fetched via feed/user endpoint', count: posts.length });
        return posts;
      }
      log.warn({ msg: 'feed/user endpoint returned no posts' });
    } catch (e) {
      log.warn({ msg: 'feed/user endpoint failed', error: e.message });
    }

    // Step 3: Fallback to GraphQL
    try {
      const posts = await this._getFeedViaGraphQL(userPk, username, limit, userMatch.user);
      if (posts.length > 0) {
        log.info({ msg: 'Feed fetched via GraphQL', count: posts.length });
        return posts;
      }
    } catch (e) {
      log.warn({ msg: 'GraphQL failed', error: e.message });
    }

    log.warn({ msg: 'All methods failed for feed fetch', username });
    return [];
  }

  /**
   * Method 1: feed/user/{pk}/ endpoint
   * این endpoint قدیمی اما پایدار هست و با cookies کار می‌کنه.
   */
  async _getFeedViaUserEndpoint(userPk, username, limit, userInfo) {
    const feedUrl = `${IG_API}/feed/user/${userPk}/?count=${limit}`;

    log.debug({ msg: 'Trying feed/user endpoint', pk: userPk });

    const res = await this.axiosInstance.get(feedUrl, {
      headers: { 'Referer': `${IG_BASE}/${username}/` },
    });

    if (res.status !== 200) {
      throw new Error(`feed/user returned ${res.status}`);
    }

    const items = res.data?.items;
    if (!items || !Array.isArray(items)) {
      log.debug({ msg: 'feed/user: no items array', dataType: typeof res.data });
      throw new Error('feed/user: no items in response');
    }

    log.info({ msg: 'feed/user: items found', count: items.length });

    const posts = [];
    for (const item of items) {
      if (posts.length >= limit) break;

      const mediaType = item.media_type; // 1=photo, 2=video, 8=carousel
      const isVideo = mediaType === 2;
      const isCarousel = mediaType === 8;

      let mediaUrls = [];
      let carouselItems = [];

      if (isCarousel && item.carousel_media) {
        for (const child of item.carousel_media) {
          const childIsVideo = child.media_type === 2;
          if (childIsVideo && child.video_versions?.length > 0) {
            mediaUrls.push(child.video_versions[0].url);
            carouselItems.push({ type: 'video', url: child.video_versions[0].url });
          } else if (child.image_versions2?.candidates?.length > 0) {
            mediaUrls.push(child.image_versions2.candidates[0].url);
            carouselItems.push({ type: 'photo', url: child.image_versions2.candidates[0].url });
          }
        }
      } else if (isVideo && item.video_versions?.length > 0) {
        mediaUrls.push(item.video_versions[0].url);
        carouselItems.push({ type: 'video', url: item.video_versions[0].url });
      } else if (item.image_versions2?.candidates?.length > 0) {
        mediaUrls.push(item.image_versions2.candidates[0].url);
        carouselItems.push({ type: 'photo', url: item.image_versions2.candidates[0].url });
      }

      const caption = item.caption?.text || '';

      posts.push({
        pk: String(item.id),
        id: String(item.id),
        type: isCarousel ? 'carousel' : (isVideo ? 'video' : 'photo'),
        isVideo,
        isReel: item.product_type === 'clips',
        caption,
        shortcode: item.code,
        takenAt: item.taken_at,
        takenAtIso: item.taken_at ? new Date(item.taken_at * 1000).toISOString() : null,
        mediaUrls,
        carouselItems,
        likeCount: item.like_count || 0,
        commentCount: item.comment_count || 0,
        viewCount: item.play_count || item.view_count || 0,
        location: item.location ? { name: item.location.name } : null,
        user: {
          pk: userPk,
          username,
          fullName: userInfo.full_name,
          profilePicUrl: userInfo.profile_pic_url,
          isVerified: userInfo.is_verified,
        },
        music: null,
        hasAudio: isVideo,
        videoDuration: item.video_duration || null,
      });
    }

    return posts;
  }

  /**
   * Method 2: GraphQL query (fallback)
   */
  async _getFeedViaGraphQL(userPk, username, limit, userInfo) {
    const queryHash = '69cad40e6a9c9d9b5d2d44f2b6ac649f';
    const variables = JSON.stringify({
      id: userPk,
      first: limit,
      after: null,
    });

    const graphqlUrl = `${IG_API}/graphql/query/?query_hash=${queryHash}&variables=${encodeURIComponent(variables)}`;

    log.debug({ msg: 'Trying GraphQL', pk: userPk });

    const feedRes = await this.axiosInstance.get(graphqlUrl, {
      headers: { 'Referer': `${IG_BASE}/${username}/` },
    });

    const media = feedRes.data?.data?.user?.edge_owner_to_timeline_media;
    if (!media?.edges) {
      throw new Error(`GraphQL: no media edges (status ${feedRes.status})`);
    }

    log.info({ msg: 'GraphQL: media found', count: media.edges.length });

    const posts = [];
    for (const edge of media.edges) {
      if (posts.length >= limit) break;
      const node = edge.node;
      if (!node) continue;

      const isVideo = node.is_video;
      const isCarousel = node.__typename === 'GraphSidecar';
      const isReel = node.product_type === 'clips';

      let mediaUrls = [];
      let carouselItems = [];

      if (isCarousel && node.edge_sidecar_to_children?.edges) {
        for (const childEdge of node.edge_sidecar_to_children.edges) {
          const child = childEdge.node;
          if (child.is_video) {
            mediaUrls.push(child.video_url);
            carouselItems.push({ type: 'video', url: child.video_url });
          } else {
            mediaUrls.push(child.display_url);
            carouselItems.push({ type: 'photo', url: child.display_url });
          }
        }
      } else if (isVideo) {
        mediaUrls.push(node.video_url);
        carouselItems.push({ type: 'video', url: node.video_url });
      } else {
        mediaUrls.push(node.display_url);
        carouselItems.push({ type: 'photo', url: node.display_url });
      }

      posts.push({
        pk: String(node.id),
        id: String(node.id),
        type: isCarousel ? 'carousel' : (isReel ? 'reel' : (isVideo ? 'video' : 'photo')),
        isVideo,
        isReel,
        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        shortcode: node.shortcode,
        takenAt: node.taken_at_timestamp,
        takenAtIso: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
        mediaUrls,
        carouselItems,
        likeCount: node.edge_media_preview_like?.count || 0,
        commentCount: node.edge_media_to_comment?.count || 0,
        viewCount: node.video_view_count || 0,
        user: { pk: userPk, username, fullName: userInfo.full_name, isVerified: userInfo.is_verified },
        music: null,
        hasAudio: isVideo,
        videoDuration: null,
      });
    }

    return posts;
  }

  /**
   * Get user stories — via GraphQL API
   *
   * Stories نیاز به endpoint خاص داره که با cookies کار می‌کنه.
   */
  async getUserStories(pkOrUsername) {
    const username = typeof pkOrUsername === 'string' && !pkOrUsername.match(/^\d+$/)
      ? pkOrUsername
      : pkOrUsername;

    log.info({ msg: 'Fetching user stories', username });

    if (!this.axiosInstance) {
      return [];
    }

    try {
      // First get user pk
      const searchUrl = `${IG_API}/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}&include_reel=true`;
      const searchRes = await this.axiosInstance.get(searchUrl, {
        headers: { 'Referer': `${IG_BASE}/` },
      });

      const users = searchRes.data?.users || [];
      const userMatch = users.find(u => u.user?.username?.toLowerCase() === username.toLowerCase());

      if (!userMatch?.user?.pk) {
        log.warn({ msg: 'Cannot find user for stories', username });
        return [];
      }

      const userPk = userMatch.user.pk;

      // Try to fetch stories via the reels endpoint
      const storiesUrl = `${IG_API}/feed/reels_media/?user_ids=${userPk}`;
      const storiesRes = await this.axiosInstance.get(storiesUrl, {
        headers: { 'Referer': `${IG_BASE}/` },
      });

      const reelsMedia = storiesRes.data?.reels;
      if (!reelsMedia || !reelsMedia[userPk]) {
        log.info({ msg: 'No active stories', username });
        return [];
      }

      const reel = reelsMedia[userPk];
      const items = reel.items || [];
      const stories = items.map(item => {
        const isVideo = item.media_type === 2;
        let mediaUrl = null;

        if (isVideo && item.video_versions?.length > 0) {
          mediaUrl = item.video_versions[0].url;
        } else if (item.image_versions2?.candidates?.length > 0) {
          mediaUrl = item.image_versions2.candidates[0].url;
        }

        return {
          pk: String(item.pk),
          id: String(item.id),
          type: 'story',
          subtype: isVideo ? 'video' : 'photo',
          isVideo,
          caption: item.caption || '',
          takenAt: item.taken_at,
          takenAtIso: item.taken_at ? new Date(item.taken_at * 1000).toISOString() : null,
          mediaUrl,
          thumbnailUrl: mediaUrl,
          ownerUsername: username,
          mentions: [],
          hashtags: [],
          isCloseFriends: item.audience === 'besties',
        };
      });

      log.info({ msg: 'Stories fetched', count: stories.length, username });
      return stories;
    } catch (e) {
      log.warn({ msg: 'Failed to fetch stories', username, error: e.message });
      return [];
    }
  }

  async logout() {
    this.isLoggedIn = false;
    log.info('Logged out from Instagram');
  }

  getCurrentUser() {
    return this.currentUser;
  }

  async persistSession() {}

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
      browser: null, // No Playwright anymore
      proxy: {
        configMode: config.proxy.mode,
        note: 'Using GraphQL API (no browser needed)',
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
