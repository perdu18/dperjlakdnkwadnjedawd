/**
 * instagram/IgClient.js
 * Instagram web/private API client with browser-created session cookies.
 *
 * Production polling intentionally uses paced HTTP requests: keeping Chromium
 * alive on Railway consumes substantially more memory and browser automation
 * increases challenge risk. Playwright remains the interactive session setup
 * and recovery mechanism.
 *
 * Session: فایل JSON حاوی cookies که توسط scripts/setup-instagram.js ساخته میشه.
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

import config from '../config/env.js';
import { igLogger as log } from '../utils/Logger.js';
import { sleep } from '../utils/Helpers.js';

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
    this._requestGate = Promise.resolve();
    this._nextRequestAt = 0;
    this._cooldownUntil = 0;
    this._cooldownReason = null;
    this._profileCache = new Map();
    this.sessionSource = null;
    this.sessionFingerprint = null;
    this.lastVerification = null;
    this.onSessionInvalid = null;
  }

  init() {
    this._setupSessionPath();
    log.info({ msg: 'Instagram client initialized (web-profile-first HTTP polling)', username: config.instagram.username });
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
        this.lastError = null;
        this.lastErrorAt = null;
        log.info({ msg: 'Session verified, login successful', verification: this.lastVerification?.method });
        return;
      }
      this.lastError = `Instagram session verification failed: ${this.lastVerification?.reason || 'no authenticated endpoint succeeded'}`;
      this.lastErrorAt = new Date().toISOString();
      this.isLoggedIn = false;
      throw new Error('Instagram session is invalid or expired. Run: npm run setup:instagram');
    }

    if (!this.lastError) {
      this.lastError = `Session file not found at: ${this.sessionFilePath}`;
      this.lastErrorAt = new Date().toISOString();
    }
    log.error({ msg: 'Instagram session could not be restored', error: this.lastError });
    throw new Error(`${this.lastError}. Run: npm run setup:instagram`);
  }

  async _restoreSession() {
    // Environment configuration is authoritative in cloud deployments. Loading
    // the volume first caused newly rotated Railway sessions to be ignored.
    const sessionBase64 = process.env.IG_SESSION_BASE64;
    if (sessionBase64?.trim()) {
      log.info('Found IG_SESSION_BASE64; replacing any persisted session copy');
      return this._restoreSessionFromBase64(sessionBase64);
    }

    if (!existsSync(this.sessionFilePath)) return false;
    try {
      const stateStr = readFileSync(this.sessionFilePath, 'utf8');
      return this._applySessionData(JSON.parse(stateStr), 'file', false);
    } catch (e) {
      this.lastError = `Could not restore session file: ${e.message}`;
      log.error({ msg: 'Could not restore session file', error: e.message });
      return false;
    }
  }

  async _restoreSessionFromBase64(sessionBase64) {
    try {
      let normalized = String(sessionBase64).trim().replace(/\s+/g, '');
      normalized = normalized.replace(/^['"]|['"]$/g, '');
      if (normalized.startsWith('IG_SESSION_BASE64=')) {
        normalized = normalized.slice('IG_SESSION_BASE64='.length);
      }
      normalized = normalized.replace(/^['"]|['"]$/g, '');
      const sessionJson = Buffer.from(normalized, 'base64').toString('utf8');
      const sessionData = JSON.parse(sessionJson);
      return this._applySessionData(sessionData, 'environment', true);
    } catch (e) {
      this.lastError = `Could not restore IG_SESSION_BASE64: ${e.message}`;
      this.lastErrorAt = new Date().toISOString();
      log.error({ msg: 'Could not restore IG_SESSION_BASE64', error: e.message });
      return false;
    }
  }

  _applySessionData(sessionData, source, persist) {
    const essential = ['sessionid', 'csrftoken', 'ds_user_id'];
    const missing = essential.filter(name => !sessionData?.cookies?.[name]);
    if (missing.length > 0) {
      throw new Error(`Session is missing cookies: ${missing.join(', ')}`);
    }
    if (sessionData.username
        && sessionData.username.toLowerCase() !== config.instagram.username.toLowerCase()) {
      throw new Error(`Session belongs to @${sessionData.username}, not @${config.instagram.username}`);
    }

    this.session = sessionData;
    this.sessionSource = source;
    this.sessionFingerprint = createHash('sha256')
      .update(String(sessionData.cookies.sessionid))
      .digest('hex')
      .slice(0, 12);

    if (persist) {
      try {
        const sessionDir = dirname(this.sessionFilePath);
        if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
        writeFileSync(this.sessionFilePath, JSON.stringify(sessionData), 'utf8');
      } catch (e) {
        log.warn({ msg: 'Could not persist Instagram session copy', error: e.message });
      }
    }

    this._buildAxiosInstance();
    log.info({
      msg: 'Instagram session loaded',
      source,
      fingerprint: this.sessionFingerprint,
      cookieCount: Object.keys(sessionData.cookies).length,
      username: sessionData.username,
      createdAt: sessionData.createdAt,
    });
    return true;
  }

  _buildAxiosInstance() {
    const cookieStr = Object.entries(this.session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const agent = this._buildStaticProxyAgent();

    this.axiosInstance = axios.create({
      timeout: 20000,
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
      ...(agent ? { httpsAgent: agent, proxy: false } : {}),
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
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });

    this.axiosInstance.interceptors.request.use(async request => {
      await this._paceRequest();
      return request;
    });
    this.axiosInstance.interceptors.response.use(
      response => {
        this._applySafetyCooldown(response.status, response.data, response.headers);
        return response;
      },
      error => {
        this._applySafetyCooldown(
          error.response?.status,
          error.response?.data,
          error.response?.headers
        );
        throw error;
      }
    );
  }

  _buildStaticProxyAgent() {
    if (config.proxy.mode !== 'static' || !config.proxy.staticUrl) return null;
    try {
      const url = new URL(config.proxy.staticUrl);
      const isSocks = url.protocol === 'socks5:' || url.protocol === 'socks4:';
      this.stickyProxy = {
        protocol: url.protocol.replace(':', ''),
        host: url.hostname,
        port: url.port || null,
      };
      return isSocks
        ? new SocksProxyAgent(config.proxy.staticUrl)
        : new HttpsProxyAgent(config.proxy.staticUrl);
    } catch (e) {
      log.warn({ msg: 'Invalid static Instagram proxy; using direct connection', error: e.message });
      return null;
    }
  }

  async _paceRequest() {
    const gate = this._requestGate.then(async () => {
      const waitUntil = Math.max(this._nextRequestAt, this._cooldownUntil);
      const waitMs = Math.max(0, waitUntil - Date.now());
      if (waitMs > 0) {
        log.debug({
          msg: 'Pacing Instagram request',
          waitMs,
          cooldownReason: this._cooldownReason,
        });
        await sleep(waitMs);
      }

      const min = Math.max(500, config.antiDetect.requestDelayMin);
      const max = Math.max(min, config.antiDetect.requestDelayMax);
      this._nextRequestAt = Date.now() + min + Math.floor(Math.random() * (max - min + 1));
      if (this._cooldownUntil <= Date.now()) this._cooldownReason = null;
    });
    this._requestGate = gate.catch(() => {});
    await gate;
  }

  _applySafetyCooldown(status, data, headers = {}) {
    const message = String(data?.message || data?.error_type || '').toLowerCase();
    const redirectLocation = String(headers?.location || '').toLowerCase();
    const authRejected = status === 401
      || status === 403
      || message.includes('login_required')
      || redirectLocation.includes('/accounts/login');
    if (authRejected) {
      this._markSessionInvalid(message || `HTTP ${status}`);
    }
    let seconds = 0;
    let reason = null;

    if (status === 429 || message.includes('feedback_required') || message.includes('spam')) {
      seconds = config.antiDetect.rateLimitCooldown;
      reason = status === 429 ? 'HTTP 429' : message;
    } else if (message.includes('challenge_required') || message.includes('checkpoint_required')) {
      seconds = config.antiDetect.challengeCooldown;
      reason = message;
    }

    if (seconds > 0) {
      this._cooldownUntil = Math.max(this._cooldownUntil, Date.now() + seconds * 1000);
      this._cooldownReason = reason;
      log.warn({ msg: 'Instagram safety cooldown activated', reason, seconds });
    }
  }

  _markSessionInvalid(reason) {
    const wasLoggedIn = this.isLoggedIn;
    this.isLoggedIn = false;
    this.lastError = `Instagram authentication rejected: ${reason}`;
    this.lastErrorAt = new Date().toISOString();
    this._profileCache.clear();
    if (wasLoggedIn) {
      log.error({ msg: 'Instagram session became invalid', reason });
      Promise.resolve(this.onSessionInvalid?.(reason)).catch(error => {
        log.warn({ msg: 'Instagram invalid-session handler failed', error: error.message });
      });
    }
  }

  async _verifySession() {
    const userId = String(this.session.cookies.ds_user_id);
    const checks = [];
    const endpoints = [
      {
        method: 'current_user',
        url: `${IG_API}/web/accounts/current_user/?include_dummy=true`,
        extract: data => data?.viewer?.is_logged_in === true
          ? data.viewer
          : (data?.user || data?.data?.user || null),
      },
      {
        method: 'private_user_info',
        url: `${IG_API}/users/${encodeURIComponent(userId)}/info/`,
        extract: data => data?.user || null,
      },
      {
        method: 'account_edit',
        url: `${IG_BASE}/accounts/edit/?__a=1&__d=dis`,
        extract: data => data?.form_data || data?.user || data?.data?.user || null,
      },
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await this.axiosInstance.get(endpoint.url, {
          headers: { 'Referer': `${IG_BASE}/` },
        });
        const message = response.data?.message || response.data?.error_type || null;
        const user = endpoint.extract(response.data);
        checks.push({ method: endpoint.method, status: response.status, message });

        if (response.status === 200 && user) {
          this.currentUser = user;
          this.lastVerification = {
            valid: true,
            method: endpoint.method,
            checkedAt: new Date().toISOString(),
            checks,
          };
          log.info({ msg: 'Instagram session verified', method: endpoint.method, userId });
          return true;
        }
      } catch (e) {
        checks.push({ method: endpoint.method, error: e.message });
      }
    }

    const explicitAuthFailure = checks.find(check =>
      check.status === 401
      || check.status === 403
      || String(check.message || '').toLowerCase().includes('login_required'));
    this.lastVerification = {
      valid: false,
      method: null,
      checkedAt: new Date().toISOString(),
      reason: explicitAuthFailure
        ? `Instagram rejected authentication (${explicitAuthFailure.message || explicitAuthFailure.status})`
        : 'Authenticated endpoints returned no recognized user payload',
      checks,
    };
    log.warn({ msg: 'Instagram session verification failed', verification: this.lastVerification });
    return false;
  }

  _assertApiResponse(response, context) {
    const status = response?.status;
    const data = response?.data;
    const apiMessage = data?.message || data?.error_type;
    if (status !== 200 || data?.status === 'fail' || apiMessage === 'login_required') {
      throw new Error(`${context} failed (${status || 'no status'}${apiMessage ? `: ${apiMessage}` : ''})`);
    }
  }

  async _getWebProfile(username, { force = false } = {}) {
    const key = username.toLowerCase();
    const cached = this._profileCache.get(key);
    if (!force && cached && Date.now() - cached.fetchedAt < 60_000) {
      return cached.user;
    }

    const response = await this.axiosInstance.get(`${IG_API}/users/web_profile_info/`, {
      params: { username },
      headers: { 'Referer': `${IG_BASE}/${encodeURIComponent(username)}/` },
    });
    this._assertApiResponse(response, 'Instagram web profile info');
    const user = response.data?.data?.user;
    if (!user) throw new Error(`Instagram web profile for @${username} is empty`);

    this._profileCache.set(key, { user, fetchedAt: Date.now() });
    return user;
  }

  _normalizeWebProfileUser(user) {
    return {
      pk: user.id ?? user.pk,
      username: user.username,
      fullName: user.full_name,
      isPrivate: user.is_private,
      isVerified: user.is_verified,
      profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
      followerCount: user.edge_followed_by?.count ?? user.follower_count ?? 0,
      followingCount: user.edge_follow?.count ?? user.following_count ?? 0,
      mediaCount: user.edge_owner_to_timeline_media?.count ?? user.media_count ?? 0,
      biography: user.biography ?? null,
    };
  }

  /**
   * Get current profile details. The web profile endpoint is preferred because
   * it returns profile counters and the same timeline visible on instagram.com.
   */
  async getUserByUsername(username, options = {}) {
    const { force = true } = options;
    log.info({ msg: 'Fetching user info', username, force });

    if (!this.axiosInstance) {
      throw new Error('No axios instance — session not loaded');
    }

    try {
      const webUser = await this._getWebProfile(username, { force });
      return this._normalizeWebProfileUser(webUser);
    } catch (e) {
      log.warn({
        msg: 'Web profile lookup failed; falling back to private API search',
        username,
        error: e.message,
      });
    }

    const searchUrl = `${IG_API}/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}&include_reel=true`;
    const res = await this.axiosInstance.get(searchUrl, {
      headers: { 'Referer': `${IG_BASE}/` },
    });
    this._assertApiResponse(res, 'Instagram user search');

    const users = res.data?.users || [];
    const match = users.find(entry =>
      entry.user?.username?.toLowerCase() === username.toLowerCase());
    if (!match?.user) {
      throw new Error(`User @${username} not found`);
    }

    const searchUser = match.user;
    let detailedUser = {};
    if (searchUser.pk) {
      try {
        const infoRes = await this.axiosInstance.get(`${IG_API}/users/${searchUser.pk}/info/`, {
          headers: { 'Referer': `${IG_BASE}/${username}/` },
        });
        this._assertApiResponse(infoRes, 'Instagram user info');
        detailedUser = infoRes.data?.user || {};
      } catch (e) {
        const hasSearchCounters = searchUser.follower_count != null
          && searchUser.following_count != null
          && searchUser.media_count != null;
        if (!hasSearchCounters) throw e;
        log.warn({
          msg: 'Detailed profile request failed; using complete search data',
          username,
          error: e.message,
        });
      }
    }

    const user = { ...searchUser, ...detailedUser };
    return {
      pk: user.pk,
      username: user.username,
      fullName: user.full_name,
      isPrivate: user.is_private,
      isVerified: user.is_verified,
      profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
      followerCount: user.follower_count ?? 0,
      followingCount: user.following_count ?? 0,
      mediaCount: user.media_count ?? 0,
      biography: user.biography ?? null,
    };
  }

  _normalizeMediaItem(item, fallbackUser = {}) {
    if (!item) throw new Error('Instagram media item is empty');

    const isCarousel = item.media_type === 8;
    const isVideo = item.media_type === 2;
    const isReel = item.product_type === 'clips';
    const sourceItems = isCarousel ? (item.carousel_media || []) : [item];
    const carouselItems = [];

    for (const media of sourceItems) {
      const childIsVideo = media.media_type === 2;
      const url = childIsVideo
        ? media.video_versions?.[0]?.url
        : media.image_versions2?.candidates?.[0]?.url;
      if (url) carouselItems.push({ type: childIsVideo ? 'video' : 'photo', url });
    }

    const itemUser = item.user || {};
    // Keep the feed's existing ID shape for deduplication compatibility.
    // getMediaInfo() strips the owner suffix only when building its API URL.
    const mediaPk = String(item.id ?? item.pk ?? '');
    return {
      pk: mediaPk,
      id: String(item.id ?? item.pk ?? mediaPk),
      type: isCarousel ? 'carousel' : (isReel ? 'reel' : (isVideo ? 'video' : 'photo')),
      isVideo,
      isReel,
      caption: item.caption?.text ?? '',
      shortcode: item.code,
      takenAt: item.taken_at,
      takenAtIso: item.taken_at ? new Date(item.taken_at * 1000).toISOString() : null,
      mediaUrls: carouselItems.map(media => media.url),
      carouselItems,
      likeCount: item.like_count ?? 0,
      commentCount: item.comment_count ?? 0,
      viewCount: item.play_count ?? item.view_count ?? null,
      location: item.location ? { name: item.location.name } : null,
      usertags: item.usertags?.in?.map(tag => tag.user?.username).filter(Boolean) || [],
      user: {
        pk: itemUser.pk ?? fallbackUser.pk,
        username: itemUser.username ?? fallbackUser.username,
        fullName: itemUser.full_name ?? fallbackUser.full_name ?? fallbackUser.fullName,
        profilePicUrl: itemUser.profile_pic_url ?? fallbackUser.profile_pic_url ?? fallbackUser.profilePicUrl,
        isVerified: itemUser.is_verified ?? fallbackUser.is_verified ?? fallbackUser.isVerified,
      },
      music: item.music_metadata?.music_info?.music_asset_info?.title
        ? { title: item.music_metadata.music_info.music_asset_info.title }
        : null,
      hasAudio: item.has_audio ?? isVideo,
      videoDuration: item.video_duration ?? null,
    };
  }

  /**
   * Fetch the latest counters, caption, and media URLs for one post.
   */
  async getMediaInfo(mediaPk) {
    if (!this.axiosInstance) {
      throw new Error('No axios instance — session not loaded');
    }

    const normalizedPk = String(mediaPk || '').split('_')[0];
    if (!/^\d+$/.test(normalizedPk)) {
      throw new Error(`Invalid Instagram media PK: ${mediaPk}`);
    }

    const response = await this.axiosInstance.get(`${IG_API}/media/${normalizedPk}/info/`, {
      headers: { 'Referer': `${IG_BASE}/` },
    });
    this._assertApiResponse(response, 'Instagram media info');

    const item = response.data?.items?.[0];
    if (!item) throw new Error(`Instagram media ${normalizedPk} was not found`);
    return this._normalizeMediaItem(item);
  }

  _normalizeGraphNode(node, fallbackUser = {}) {
    const isVideo = !!node.is_video;
    const isCarousel = node.__typename === 'GraphSidecar';
    const isReel = node.product_type === 'clips';
    const children = isCarousel
      ? (node.edge_sidecar_to_children?.edges || []).map(edge => edge.node).filter(Boolean)
      : [node];
    const carouselItems = children.map(child => ({
      type: child.is_video ? 'video' : 'photo',
      url: child.is_video ? child.video_url : child.display_url,
    })).filter(media => media.url);

    return {
      pk: String(node.id),
      id: String(node.id),
      type: isCarousel ? 'carousel' : (isReel ? 'reel' : (isVideo ? 'video' : 'photo')),
      isVideo,
      isReel,
      caption: node.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
      shortcode: node.shortcode,
      takenAt: node.taken_at_timestamp,
      takenAtIso: node.taken_at_timestamp
        ? new Date(node.taken_at_timestamp * 1000).toISOString()
        : null,
      mediaUrls: carouselItems.map(media => media.url),
      carouselItems,
      likeCount: node.edge_media_preview_like?.count ?? node.edge_liked_by?.count ?? 0,
      commentCount: node.edge_media_to_comment?.count ?? 0,
      viewCount: node.video_view_count ?? node.video_play_count ?? null,
      location: node.location ? { name: node.location.name } : null,
      user: {
        pk: fallbackUser.id ?? fallbackUser.pk,
        username: fallbackUser.username,
        fullName: fallbackUser.full_name ?? fallbackUser.fullName,
        profilePicUrl: fallbackUser.profile_pic_url ?? fallbackUser.profilePicUrl,
        isVerified: fallbackUser.is_verified ?? fallbackUser.isVerified,
      },
      music: null,
      hasAudio: isVideo,
      videoDuration: null,
    };
  }

  _sortAndDedupePosts(posts, limit = Infinity) {
    const unique = new Map();
    for (const post of posts) {
      if (!post?.pk) continue;
      const key = String(post.pk).split('_')[0];
      const existing = unique.get(key);
      if (!existing || (post.mediaUrls?.length || 0) > (existing.mediaUrls?.length || 0)) {
        unique.set(key, post);
      }
    }
    return [...unique.values()]
      .sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0))
      .slice(0, limit);
  }

  async _getFeedViaWebProfile(username, limit) {
    const user = await this._getWebProfile(username);
    const edges = user.edge_owner_to_timeline_media?.edges;
    if (!Array.isArray(edges)) {
      throw new Error('Instagram web profile response has no timeline edges');
    }
    const posts = edges.map(edge => ({
      ...this._normalizeGraphNode(edge.node, user),
      source: 'web_profile_info',
    }));
    return this._sortAndDedupePosts(posts, limit);
  }

  /**
   * Get user feed (recent posts)
   *
   * Detection order:
   *   1. web_profile_info timeline (same source as instagram.com)
   *   2. feed/user/{pk}/ private endpoint
   *   3. legacy GraphQL query as a last-resort compatibility fallback
   */
  async getUserFeed(pkOrUsername, options = {}) {
    const { limit = 10, afterPk = null } = options;
    const username = String(pkOrUsername);
    const canonicalAfterPk = String(afterPk || '').split('_')[0];
    const errors = [];
    let successfulSource = false;
    let webPosts = [];

    log.info({ msg: 'Fetching user feed', username, limit, afterPk });
    if (!this.axiosInstance) throw new Error('No axios instance — session not loaded');

    try {
      webPosts = await this._getFeedViaWebProfile(username, limit);
      successfulSource = true;
      const containsWatermark = canonicalAfterPk && webPosts.some(post =>
        String(post.pk).split('_')[0] === canonicalAfterPk);
      if (webPosts.length > 0 && (!canonicalAfterPk || containsWatermark)) {
        log.info({ msg: 'Feed fetched via web profile endpoint', username, count: webPosts.length });
        return webPosts;
      }
      log.warn({
        msg: 'Web timeline needs private-feed recovery',
        username,
        count: webPosts.length,
        watermarkFound: containsWatermark,
      });
    } catch (e) {
      errors.push(`web_profile_info: ${e.message}`);
      log.warn({ msg: 'Web profile feed failed; trying private feed', username, error: e.message });
    }

    let userMatch;
    try {
      const searchUrl = `${IG_API}/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}&include_reel=true`;
      const searchRes = await this.axiosInstance.get(searchUrl, {
        headers: { 'Referer': `${IG_BASE}/${username}/` },
      });
      this._assertApiResponse(searchRes, 'Instagram feed user search');
      userMatch = (searchRes.data?.users || []).find(entry =>
        entry.user?.username?.toLowerCase() === username.toLowerCase());
      if (!userMatch?.user) throw new Error(`User @${username} not found`);
    } catch (e) {
      errors.push(`user_search: ${e.message}`);
    }

    if (userMatch?.user) {
      const userPk = userMatch.user.pk;
      try {
        const privatePosts = await this._getFeedViaUserEndpoint(
          userPk,
          username,
          Math.max(limit, canonicalAfterPk ? 50 : limit),
          userMatch.user,
          canonicalAfterPk
        );
        successfulSource = true;
        const merged = this._sortAndDedupePosts([...webPosts, ...privatePosts], 50);
        if (merged.length > 0) {
          log.info({ msg: 'Feed recovered via private endpoint', username, count: merged.length });
          return merged;
        }
      } catch (e) {
        errors.push(`private_feed: ${e.message}`);
        log.warn({ msg: 'Private user feed failed', username, error: e.message });
      }

      try {
        const graphqlPosts = await this._getFeedViaGraphQL(userPk, username, limit, userMatch.user);
        successfulSource = true;
        const merged = this._sortAndDedupePosts([...webPosts, ...graphqlPosts], 50);
        if (merged.length > 0) return merged;
      } catch (e) {
        errors.push(`legacy_graphql: ${e.message}`);
      }
    }

    if (successfulSource) return this._sortAndDedupePosts(webPosts, 50);
    throw new Error(`All Instagram feed sources failed for @${username}: ${errors.join(' | ')}`);
  }

  /**
   * Method 1: feed/user/{pk}/ endpoint
   * این endpoint قدیمی اما پایدار هست و با cookies کار می‌کنه.
   */
  async _getFeedViaUserEndpoint(userPk, username, limit, userInfo, stopPk = null) {
    const items = [];
    let maxId = null;
    let page = 0;
    const maxItems = Math.max(1, Math.min(50, limit));

    do {
      const count = Math.min(12, maxItems - items.length);
      const res = await this.axiosInstance.get(`${IG_API}/feed/user/${userPk}/`, {
        params: { count, ...(maxId ? { max_id: maxId } : {}) },
        headers: { 'Referer': `${IG_BASE}/${username}/` },
      });
      this._assertApiResponse(res, 'Instagram private user feed');
      const pageItems = res.data?.items;
      if (!Array.isArray(pageItems)) throw new Error('Private user feed has no items array');
      items.push(...pageItems);
      page++;

      const foundStop = stopPk && pageItems.some(item =>
        String(item.id ?? item.pk).split('_')[0] === stopPk);
      if (foundStop || pageItems.length === 0) break;
      maxId = res.data?.next_max_id || null;
    } while (maxId && items.length < maxItems && page < 5);

    log.info({ msg: 'Private user feed fetched', count: items.length, pages: page });
    const posts = items.slice(0, maxItems).map(item => ({
      ...this._normalizeMediaItem(item, {
        ...userInfo,
        pk: userPk,
        username,
      }),
      source: 'private_user_feed',
    }));
    return this._sortAndDedupePosts(posts, maxItems);
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
    this._assertApiResponse(feedRes, 'Instagram GraphQL feed');

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
        likeCount: node.edge_media_preview_like?.count ?? 0,
        commentCount: node.edge_media_to_comment?.count ?? 0,
        viewCount: node.video_view_count ?? null,
        user: { pk: userPk, username, fullName: userInfo.full_name, isVerified: userInfo.is_verified },
        music: null,
        hasAudio: isVideo,
        videoDuration: null,
      });
    }

    return posts.map(post => ({ ...post, source: 'legacy_graphql' }));
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
      let userPk;
      try {
        const webUser = await this._getWebProfile(username);
        userPk = webUser.id ?? webUser.pk;
      } catch {
        const searchUrl = `${IG_API}/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}&include_reel=true`;
        const searchRes = await this.axiosInstance.get(searchUrl, {
          headers: { 'Referer': `${IG_BASE}/` },
        });
        this._assertApiResponse(searchRes, 'Instagram story user search');
        const users = searchRes.data?.users || [];
        const userMatch = users.find(entry =>
          entry.user?.username?.toLowerCase() === username.toLowerCase());
        userPk = userMatch?.user?.pk;
      }

      if (!userPk) {
        log.warn({ msg: 'Cannot find user for stories', username });
        return [];
      }

      // Try to fetch stories via the reels endpoint
      const storiesUrl = `${IG_API}/feed/reels_media/?user_ids=${userPk}`;
      const storiesRes = await this.axiosInstance.get(storiesUrl, {
        headers: { 'Referer': `${IG_BASE}/` },
      });
      this._assertApiResponse(storiesRes, 'Instagram stories');

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
      sessionSource: this.sessionSource,
      sessionFingerprint: this.sessionFingerprint,
      lastVerification: this.lastVerification,
      sessionInfo: this.session ? {
        version: this.session.version,
        type: this.session.type,
        username: this.session.username,
        createdAt: this.session.createdAt,
        cookieCount: this.session.cookies ? Object.keys(this.session.cookies).length : 0,
        hasSessionId: !!this.session.cookies?.sessionid,
        hasCsrfToken: !!this.session.cookies?.csrftoken,
        hasDsUserId: !!this.session.cookies?.ds_user_id,
      } : null,
      browser: {
        runtimeEnabled: false,
        note: 'Playwright is reserved for interactive session creation; HTTP polling is safer and lighter in production',
      },
      proxy: {
        configMode: config.proxy.mode,
        active: this.stickyProxy,
        note: config.proxy.mode === 'static'
          ? 'Using one stable proxy identity for the Instagram session'
          : 'Direct connection; avoid rotating free proxies with an authenticated session',
      },
      requestSafety: {
        nextRequestAt: this._nextRequestAt ? new Date(this._nextRequestAt).toISOString() : null,
        cooldownUntil: this._cooldownUntil > Date.now()
          ? new Date(this._cooldownUntil).toISOString()
          : null,
        cooldownReason: this._cooldownReason,
        cachedProfiles: this._profileCache.size,
        requestDelayMin: config.antiDetect.requestDelayMin,
        requestDelayMax: config.antiDetect.requestDelayMax,
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
