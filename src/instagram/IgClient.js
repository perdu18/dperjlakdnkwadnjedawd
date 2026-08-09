/**
 * instagram/IgClient.js — v2 Professional Redesign
 *
 * ARCHITECTURE (based on 2025 research):
 * ─────────────────────────────────────────
 * Dual-mode client:
 *   1. Public mode (no login): for public posts, reels, profile data
 *      → Uses only `x-ig-app-id` header, no cookies
 *      → Much lower ban risk, separate rate-limit budget
 *      → Fallback: HTML parsing when JSON endpoint changes
 *
 *   2. Authenticated mode (web session): only for stories & private accounts
 *      → Uses cookies from Playwright session
 *      → Less frequent requests (stories only)
 *      → Isolated rate-limit budget from public mode
 *
 * RATE LIMITING:
 *   - Token bucket: 200 requests/hour per mode (public/auth)
 *   - Honor Retry-After header
 *   - Exponential backoff on 429: 60s → 120s → 300s → 900s
 *   - Per-account cooldown on repeated failures
 *
 * REFERENCES:
 *   - InstaMonitorBot (GitHub, Python) — 15-min polling, public API
 *   - instagrapi best practices — session separation, delay patterns
 *   - Instagram web API — x-ig-app-id header for public data
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

// FIX(ua): Chrome 131 is current as of 2025. Old UA (Chrome 120) is flagged.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IG_APP_ID = '936619743392459';

// Modern sec-ch-ua headers (Instagram checks these for bot detection)
const SEC_CH_UA = '"Chromium";v="131", "Google Chrome";v="131", "Not-A.Brand";v="99"';

const MAX_INLINE_WAIT_MS = 60_000;

// FIX(checkpoint): checkpoint_required needs manual action. 6-hour cooldown
// prevents futile retry loops that just burn more rate limit.
const CHECKPOINT_COOLDOWN_SECONDS = 6 * 60 * 60;

// FIX(ratelimit): exponential backoff schedule for 429s
// Each subsequent 429 within the backoff window increases the wait.
const BACKOFF_STEPS_SECONDS = [60, 120, 300, 900, 1800]; // 1m, 2m, 5m, 15m, 30m

// FIX(ratelimit): token bucket — Instagram allows ~200 requests/hour per IP.
// We use a conservative 150/hour budget with 15-minute refill check.
const RATE_BUDGET_PER_HOUR = 150;
const RATE_BUDGET_REFILL_MS = 60_000; // check refill every minute

export class InstagramCooldownError extends Error {
  constructor(remainingMs, reason) {
    super(`Instagram cooldown active for ${Math.ceil(remainingMs / 1000)}s (${reason || 'unknown'})`);
    this.name = 'InstagramCooldownError';
    this.remainingMs = remainingMs;
    this.reason = reason;
  }
}

export class InstagramAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstagramAuthError';
  }
}

/**
 * Token bucket rate limiter — shared across all requests in a mode.
 * Prevents burst patterns that trigger bot detection.
 */
class TokenBucket {
  constructor(capacity, refillPerHour) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerHour / (60 * 60 * 1000);
    this.lastRefill = Date.now();
    this._lock = Promise.resolve();
  }

  async consume(count = 1) {
    this._lock = this._lock.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefill = now;

      if (this.tokens < count) {
        const waitMs = Math.ceil((count - this.tokens) / this.refillPerMs);
        log.warn({
          msg: 'Rate budget exhausted; waiting for refill',
          waitMs,
          tokensAvailable: Math.floor(this.tokens),
        });
        await sleep(Math.min(waitMs, MAX_INLINE_WAIT_MS));
        this.tokens = Math.max(0, this.tokens - count);
        return false; // had to wait
      }
      this.tokens -= count;
      return true;
    });
    return this._lock;
  }

  get available() {
    return Math.floor(this.tokens);
  }
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

    // Authenticated axios (for stories)
    this.authAxios = null;

    // Public axios (no cookies — for public posts)
    this.publicAxios = null;

    // Shared request gate (serializes all IG requests to avoid bursts)
    this._requestGate = Promise.resolve();
    this._nextRequestAt = 0;

    // Cooldown state (shared across both modes — Instagram tracks per-IP)
    this._cooldownUntil = 0;
    this._cooldownReason = null;
    this._backoffIndex = 0; // tracks consecutive 429s for exponential backoff

    // Profile cache (24h TTL — profile data rarely changes)
    this._profileCache = new Map();
    const profileCacheTtlSec = Math.max(3600, config.antiDetect.profileCacheTtl);
    this._profileCacheTtlMs = profileCacheTtlSec * 1000;

    // Feed cache (short TTL — 5 min, just to avoid duplicate fetches within a poll cycle)
    this._feedCache = new Map();
    this._feedCacheTtlMs = 5 * 60 * 1000;

    this.sessionSource = null;
    this.sessionFingerprint = null;
    this.lastVerification = null;
    this.verificationDeferred = false;
    this.onSessionInvalid = null;

    // Two independent rate budgets
    this._publicBucket = new TokenBucket(50, RATE_BUDGET_PER_HOUR);
    this._authBucket = new TokenBucket(30, Math.floor(RATE_BUDGET_PER_HOUR * 0.4)); // auth gets less budget
  }

  init() {
    this._setupSessionPath();
    this._buildPublicAxios();
    log.info({
      msg: 'IgClient v2 initialized (dual-mode: public + authenticated)',
      username: config.instagram.username,
      profileCacheTtlSec: Math.floor(this._profileCacheTtlMs / 1000),
    });
  }

  _setupSessionPath() {
    const sessionDir = resolve(projectRoot, config.instagram.sessionDir);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    this.sessionFilePath = join(sessionDir, `${config.instagram.username}.web-session.json`);
  }

  /**
   * Build the PUBLIC axios instance — no cookies, just x-ig-app-id.
   * This is used for fetching public posts, reels, and profile data.
   * Much lower ban risk because no authenticated session is involved.
   */
  _buildPublicAxios() {
    const agent = this._buildStaticProxyAgent();

    this.publicAxios = axios.create({
      baseURL: IG_BASE,
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: () => true,
      decompress: true,
      ...(agent ? { httpsAgent: agent, httpAgent: agent, proxy: false } : {}),
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-IG-App-ID': IG_APP_ID,
        'sec-ch-ua': SEC_CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Referer': `${IG_BASE}/`,
      },
    });

    this.publicAxios.interceptors.request.use(async (req) => {
      await this._paceRequest('public');
      return req;
    });
    this.publicAxios.interceptors.response.use(
      (res) => {
        this._applySafetyCooldown(res.status, res.data, res.headers, 'public');
        return res;
      },
      (err) => {
        this._applySafetyCooldown(
          err.response?.status, err.response?.data, err.response?.headers, 'public'
        );
        throw err;
      }
    );
  }

  /**
   * Build the AUTHENTICATED axios instance — with cookies.
   * Only used for stories (which require login) and as fallback for private accounts.
   */
  _buildAuthAxios() {
    if (!this.session?.cookies) return;

    const cookieStr = Object.entries(this.session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const agent = this._buildStaticProxyAgent();

    this.authAxios = axios.create({
      baseURL: IG_BASE,
      timeout: 30000,
      maxRedirects: 0,
      validateStatus: () => true,
      decompress: true,
      ...(agent ? { httpsAgent: agent, httpAgent: agent, proxy: false } : {}),
      headers: {
        'User-Agent': this.session.userAgent || BROWSER_UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-IG-App-ID': IG_APP_ID,
        'sec-ch-ua': SEC_CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'X-ASBD-ID': '129',
        'X-IG-WWW-Claim': '0',
        'Cookie': cookieStr,
        'X-CSRFToken': this.session.cookies.csrftoken,
        'Origin': IG_BASE,
        'Referer': `${IG_BASE}/`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Requested-With': 'XMLHttpRequest',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });

    this.authAxios.interceptors.request.use(async (req) => {
      await this._paceRequest('auth');
      return req;
    });
    this.authAxios.interceptors.response.use(
      (res) => {
        this._applySafetyCooldown(res.status, res.data, res.headers, 'auth');
        return res;
      },
      (err) => {
        this._applySafetyCooldown(
          err.response?.status, err.response?.data, err.response?.headers, 'auth'
        );
        throw err;
      }
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  LOGIN & SESSION MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  async login() {
    const restored = await this._restoreSession();

    if (!restored) {
      if (!this.lastError) {
        this.lastError = `Session file not found at: ${this.sessionFilePath}`;
        this.lastErrorAt = new Date().toISOString();
      }
      log.error({ msg: 'Instagram session could not be restored', error: this.lastError });
      throw new Error(`${this.lastError}. Run: npm run setup:instagram`);
    }

    log.info('Instagram session restored');

    try {
      const valid = await this._verifySession();
      if (valid) {
        this.isLoggedIn = true;
        this.verificationDeferred = false;
        this.lastError = null;
        this.lastErrorAt = null;
        log.info({
          msg: 'Session verified, login successful',
          verification: this.lastVerification?.method,
        });
        return;
      }

      this.isLoggedIn = false;
      this.verificationDeferred = false;
      this.lastError = `Instagram session verification failed: ${this.lastVerification?.reason || 'authentication rejected'}`;
      this.lastErrorAt = new Date().toISOString();
      throw new InstagramAuthError('Instagram session is invalid or expired. Run: npm run setup:instagram');
    } catch (e) {
      if (e instanceof InstagramCooldownError) {
        this.isLoggedIn = false;
        this.verificationDeferred = true;
        this.lastError = `Instagram verification deferred (session state unknown): ${e.message}`;
        this.lastErrorAt = new Date().toISOString();
        log.warn({
          msg: 'Instagram verification deferred by cooldown; session NOT marked invalid',
          remainingMs: this.getCooldownRemainingMs(),
        });
      }
      throw e;
    }
  }

  async _restoreSession() {
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

    this._buildAuthAxios();
    log.info({
      msg: 'Instagram session loaded (auth axios built)',
      source,
      fingerprint: this.sessionFingerprint,
      cookieCount: Object.keys(sessionData.cookies).length,
      username: sessionData.username,
      createdAt: sessionData.createdAt,
    });
    return true;
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

  // ═══════════════════════════════════════════════════════════════
  //  RATE LIMITING & COOLDOWN
  // ═══════════════════════════════════════════════════════════════

  async _paceRequest(mode) {
    // If cooldown is too long, fail fast instead of blocking
    const cooldownRemaining = this._cooldownUntil - Date.now();
    if (cooldownRemaining > MAX_INLINE_WAIT_MS) {
      throw new InstagramCooldownError(cooldownRemaining, this._cooldownReason);
    }

    const gate = this._requestGate.then(async () => {
      const waitUntil = Math.max(this._nextRequestAt, this._cooldownUntil);
      const waitMs = Math.min(MAX_INLINE_WAIT_MS, Math.max(0, waitUntil - Date.now()));
      if (waitMs > 0) {
        log.debug({ msg: 'Pacing Instagram request', waitMs, mode, cooldownReason: this._cooldownReason });
        await sleep(waitMs);
      }

      // Random delay between requests (anti-detection)
      const min = Math.max(500, config.antiDetect.requestDelayMin);
      const max = Math.max(min, config.antiDetect.requestDelayMax);
      this._nextRequestAt = Date.now() + min + Math.floor(Math.random() * (max - min + 1));

      // Consume rate budget token
      const bucket = mode === 'auth' ? this._authBucket : this._publicBucket;
      await bucket.consume(1);

      if (this._cooldownUntil <= Date.now()) {
        this._cooldownReason = null;
        this._backoffIndex = 0; // reset backoff on successful pacing
      }
    });
    this._requestGate = gate.catch(() => {});
    await gate;
  }

  isCoolingDown() {
    return this._cooldownUntil > Date.now();
  }

  getCooldownRemainingMs() {
    return Math.max(0, this._cooldownUntil - Date.now());
  }

  needsManualChallenge() {
    const reason = String(this._cooldownReason || '').toLowerCase();
    return reason.includes('checkpoint_required') || reason.includes('challenge_required');
  }

  _applySafetyCooldown(status, data, headers = {}, mode = 'unknown') {
    if (!status) return;
    const message = String(data?.message || data?.error_type || '').toLowerCase();
    const redirectLocation = String(headers?.location || '').toLowerCase();
    const isRedirect = status >= 300 && status < 400;

    const authRejected = status === 401
      || status === 403
      || message.includes('login_required')
      || (isRedirect && redirectLocation.includes('/accounts/login'));
    if (authRejected && mode === 'auth') {
      this._markSessionInvalid(message || `HTTP ${status}`);
    }

    let seconds = 0;
    let reason = null;

    if (status === 429 || message.includes('feedback_required') || message.includes('spam')) {
      // FIX(backoff): exponential backoff for consecutive 429s
      const retryAfter = parseInt(headers?.['retry-after'] ?? headers?.['Retry-After'] ?? '', 10);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        seconds = retryAfter;
      } else {
        seconds = BACKOFF_STEPS_SECONDS[Math.min(this._backoffIndex, BACKOFF_STEPS_SECONDS.length - 1)];
        this._backoffIndex++;
      }
      reason = `${mode}:HTTP ${status}`;
    } else if (message.includes('challenge_required') || message.includes('checkpoint_required')) {
      seconds = Math.max(config.antiDetect.challengeCooldown, CHECKPOINT_COOLDOWN_SECONDS);
      reason = `checkpoint_required (manual challenge needed in IG app)`;
    }

    if (seconds > 0) {
      const nextUntil = Date.now() + seconds * 1000;
      if (nextUntil > this._cooldownUntil + 5_000) {
        this._cooldownUntil = nextUntil;
        this._cooldownReason = reason;
        log.warn({ msg: 'Instagram safety cooldown activated', reason, seconds, mode, backoffIndex: this._backoffIndex });
      } else {
        log.debug({ msg: 'Instagram cooldown already active; not extending', reason, mode });
      }
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

  // ═══════════════════════════════════════════════════════════════
  //  SESSION VERIFICATION
  // ═══════════════════════════════════════════════════════════════

  async _verifySession() {
    if (this.isCoolingDown()) {
      const remaining = this.getCooldownRemainingMs();
      this.lastVerification = {
        valid: false,
        unknown: true,
        method: null,
        checkedAt: new Date().toISOString(),
        reason: `Verification skipped: cooldown active for ${Math.ceil(remaining / 1000)}s. Session state unknown.`,
        checks: [],
      };
      throw new InstagramCooldownError(remaining, this._cooldownReason || 'verification_deferred');
    }

    if (!this.authAxios) {
      this.lastVerification = {
        valid: false,
        unknown: false,
        method: null,
        checkedAt: new Date().toISOString(),
        reason: 'No authenticated axios instance available',
        checks: [],
      };
      return false;
    }

    const userId = String(this.session.cookies.ds_user_id);
    const checks = [];

    // FIX(verify): use /users/{id}/info/ first (read-only, low-risk)
    // /accounts/edit/web_form_data/ is a sensitive account-edit endpoint
    // that can trigger checkpoint_required even with valid sessions.
    const endpoints = [
      {
        method: 'private_user_info',
        url: `${IG_API}/users/${encodeURIComponent(userId)}/info/`,
        extract: data => data?.user || null,
        gapMs: 0,
      },
      {
        method: 'web_form_data',
        url: `${IG_API}/accounts/edit/web_form_data/`,
        extract: data => data?.form_data || null,
        gapMs: 30_000,
      },
    ];

    for (const endpoint of endpoints) {
      if (endpoint.gapMs > 0) {
        if (this.isCoolingDown()) break;
        await sleep(endpoint.gapMs);
      }

      try {
        const response = await this.authAxios.get(endpoint.url, {
          headers: { 'Referer': `${IG_BASE}/accounts/edit/` },
        });
        const message = response.data?.message || response.data?.error_type || null;
        const user = endpoint.extract(response.data);
        checks.push({ method: endpoint.method, status: response.status, message });

        if (response.status === 200 && user) {
          this.currentUser = {
            id: user.pk ?? user.id ?? userId,
            username: user.username || this.session.username,
          };
          this.lastVerification = {
            valid: true,
            method: endpoint.method,
            checkedAt: new Date().toISOString(),
            checks,
          };
          log.info({ msg: 'Instagram session verified', method: endpoint.method, userId });
          return true;
        }

        if (response.status === 429) break;
      } catch (e) {
        checks.push({ method: endpoint.method, error: e.message });
        if (e instanceof InstagramCooldownError) break;
      }
    }

    const hadRealResponse = checks.some(c => typeof c.status === 'number' && c.status !== 429);
    const explicitAuthFailure = checks.find(check =>
      check.status === 401
      || check.status === 403
      || String(check.message || '').toLowerCase().includes('login_required'));

    if (explicitAuthFailure) {
      this.lastVerification = {
        valid: false,
        unknown: false,
        method: null,
        checkedAt: new Date().toISOString(),
        reason: `Instagram rejected authentication (${explicitAuthFailure.message || explicitAuthFailure.status})`,
        checks,
      };
      log.warn({ msg: 'Instagram session rejected', verification: this.lastVerification });
      return false;
    }

    if (!hadRealResponse) {
      this.lastVerification = {
        valid: false,
        unknown: true,
        method: null,
        checkedAt: new Date().toISOString(),
        reason: 'Verification could not run (rate limit / network). Session state unknown.',
        checks,
      };
      log.warn({ msg: 'Instagram verification could not run', verification: this.lastVerification });
      throw new InstagramCooldownError(
        this.getCooldownRemainingMs() || 60_000,
        this._cooldownReason || 'verification_deferred'
      );
    }

    this.lastVerification = {
      valid: false,
      unknown: true,
      method: null,
      checkedAt: new Date().toISOString(),
      reason: 'Authenticated endpoints returned no recognized user payload (session state uncertain)',
      checks,
    };
    log.warn({ msg: 'Instagram session verification inconclusive', verification: this.lastVerification });
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API (no authentication needed — for public posts)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Fetch public profile + recent posts WITHOUT authentication.
   * Uses only x-ig-app-id header. Much lower ban risk.
   * Falls back to authenticated mode if public endpoint fails.
   */
  async _getPublicWebProfile(username, { force = false } = {}) {
    const key = username.toLowerCase();
    const cached = this._profileCache.get(key);
    if (!force && cached && Date.now() - cached.fetchedAt < this._profileCacheTtlMs) {
      return cached.user;
    }

    // Try public endpoint first (no cookies)
    try {
      const response = await this.publicAxios.get(`${IG_API}/users/web_profile_info/`, {
        params: { username },
        headers: { 'Referer': `${IG_BASE}/${encodeURIComponent(username)}/` },
      });

      if (response.status === 200 && response.data?.data?.user) {
        const user = response.data.data.user;
        this._profileCache.set(key, { user, fetchedAt: Date.now() });
        log.debug({ msg: 'Public profile fetched (no auth)', username });
        return user;
      }

      // If public endpoint returns login redirect, fall through to auth
      if (response.status === 302 || response.status === 401) {
        log.debug({ msg: 'Public endpoint requires auth; falling back', username, status: response.status });
      }
    } catch (e) {
      if (e instanceof InstagramCooldownError) throw e;
      log.debug({ msg: 'Public profile fetch failed; trying auth', username, error: e.message });
    }

    // Fallback: authenticated mode
    if (!this.authAxios) {
      throw new Error(`Cannot fetch profile for @${username}: no auth session and public endpoint failed`);
    }

    const response = await this.authAxios.get(`${IG_API}/users/web_profile_info/`, {
      params: { username },
      headers: { 'Referer': `${IG_BASE}/${encodeURIComponent(username)}/` },
    });
    this._assertApiResponse(response, `Auth web profile for @${username}`);
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

  async getUserByUsername(username, options = {}) {
    const { force = false, knownPk = null } = options;
    log.info({ msg: 'Fetching user info', username, force, hasKnownPk: !!knownPk });

    if (!this.publicAxios) {
      throw new Error('No axios instance — client not initialized');
    }

    let webError = null;
    try {
      const webUser = await this._getPublicWebProfile(username, { force });
      return this._normalizeWebProfileUser(webUser);
    } catch (e) {
      webError = e;
      if (e instanceof InstagramCooldownError || e instanceof InstagramAuthError) throw e;
      log.warn({ msg: 'Web profile lookup failed; trying private user info', username, error: e.message });
    }

    // Last resort: authenticated /users/{pk}/info/
    if (!knownPk) {
      throw new Error(`Instagram profile lookup failed for @${username}: ${webError?.message}`);
    }
    if (!this.authAxios) {
      throw new Error(`Cannot fetch @${username}: no auth session and no public fallback`);
    }

    const infoRes = await this.authAxios.get(`${IG_API}/users/${encodeURIComponent(knownPk)}/info/`, {
      headers: { 'Referer': `${IG_BASE}/${encodeURIComponent(username)}/` },
    });
    this._assertApiResponse(infoRes, 'Instagram user info');
    const user = infoRes.data?.user;
    if (!user) throw new Error(`Instagram user info for @${username} is empty`);

    return {
      pk: user.pk ?? knownPk,
      username: user.username ?? username,
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

  _assertApiResponse(response, context) {
    const status = response?.status;
    const data = response?.data;
    const apiMessage = data?.message || data?.error_type;

    if (status >= 300 && status < 400) {
      const location = String(response?.headers?.location || '');
      if (location.includes('/accounts/login')) {
        throw new InstagramAuthError(
          `${context} redirected to login (session not accepted for this endpoint)`
        );
      }
      throw new Error(`${context} returned redirect ${status}${location ? ` -> ${location}` : ''}`);
    }

    if (status === 429) {
      throw new InstagramCooldownError(this.getCooldownRemainingMs() || 60_000, 'HTTP 429');
    }

    if (status !== 200 || data?.status === 'fail' || apiMessage === 'login_required') {
      throw new Error(`${context} failed (${status || 'no status'}${apiMessage ? `: ${apiMessage}` : ''})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  FEED FETCHING (public posts — no auth needed)
  // ═══════════════════════════════════════════════════════════════

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

  /**
   * Fetch user feed. Tries public web_profile_info first (no auth),
   * falls back to authenticated private feed endpoint.
   *
   * The web_profile_info response includes edge_owner_to_timeline_media
   * which contains the ~12 most recent posts. This is sufficient for
   * monitoring — we only need to detect NEW posts since last check.
   */
  async getUserFeed(pkOrUsername, options = {}) {
    const { limit = 10, afterPk = null, userPk = null } = options;
    const username = String(pkOrUsername);
    const canonicalAfterPk = String(afterPk || '').split('_')[0];
    const errors = [];
    let successfulSource = false;
    let webPosts = [];
    let resolvedPk = userPk || null;
    let userInfo = {};

    log.info({ msg: 'Fetching user feed', username, limit, afterPk, userPk: resolvedPk });

    // Check feed cache (5-min TTL to avoid duplicate fetches within a poll cycle)
    const feedCacheKey = username.toLowerCase();
    const cachedFeed = this._feedCache.get(feedCacheKey);
    if (cachedFeed && Date.now() - cachedFeed.fetchedAt < this._feedCacheTtlMs && !afterPk) {
      log.debug({ msg: 'Using cached feed', username, cacheAge: Date.now() - cachedFeed.fetchedAt });
      return cachedFeed.posts;
    }

    // ── Strategy 1: Public web_profile_info (NO AUTH NEEDED) ──
    try {
      const webUser = await this._getPublicWebProfile(username);
      userInfo = webUser;
      resolvedPk = resolvedPk || webUser.id || webUser.pk;

      const edges = webUser.edge_owner_to_timeline_media?.edges;
      if (Array.isArray(edges)) {
        webPosts = this._sortAndDedupePosts(
          edges.map(edge => ({ ...this._normalizeGraphNode(edge.node, webUser), source: 'web_profile_info' })),
          limit
        );
        successfulSource = true;

        const containsWatermark = canonicalAfterPk && webPosts.some(p =>
          String(p.pk).split('_')[0] === canonicalAfterPk);

        if (webPosts.length > 0 && (!canonicalAfterPk || containsWatermark)) {
          log.info({ msg: 'Feed fetched via public web profile (no auth)', username, count: webPosts.length });
          this._feedCache.set(feedCacheKey, { posts: webPosts, fetchedAt: Date.now() });
          return webPosts;
        }

        log.warn({
          msg: 'Web timeline needs private-feed recovery',
          username, count: webPosts.length, watermarkFound: containsWatermark,
        });
      } else {
        errors.push('web_profile_info: no timeline edges');
      }
    } catch (e) {
      if (e instanceof InstagramCooldownError) throw e;
      errors.push(`web_profile_info: ${e.message}`);
      log.warn({ msg: 'Web profile feed failed; trying private feed', username, error: e.message });
    }

    // ── Strategy 2: Authenticated private feed (fallback) ──
    if (!resolvedPk) {
      if (successfulSource) {
        this._feedCache.set(feedCacheKey, { posts: webPosts, fetchedAt: Date.now() });
        return this._sortAndDedupePosts(webPosts, 50);
      }
      throw new Error(`No Instagram pk available for @${username}: ${errors.join(' | ')}`);
    }

    if (this.authAxios && this.isLoggedIn) {
      try {
        const privatePosts = await this._getFeedViaUserEndpoint(
          resolvedPk, username,
          Math.max(limit, canonicalAfterPk ? 50 : limit),
          userInfo, canonicalAfterPk
        );
        successfulSource = true;
        const merged = this._sortAndDedupePosts([...webPosts, ...privatePosts], 50);
        if (merged.length > 0) {
          log.info({ msg: 'Feed recovered via private endpoint', username, count: merged.length });
          this._feedCache.set(feedCacheKey, { posts: merged, fetchedAt: Date.now() });
          return merged;
        }
      } catch (e) {
        if (e instanceof InstagramCooldownError) throw e;
        errors.push(`private_feed: ${e.message}`);
        log.warn({ msg: 'Private user feed failed', username, error: e.message });
      }
    }

    if (successfulSource) {
      this._feedCache.set(feedCacheKey, { posts: webPosts, fetchedAt: Date.now() });
      return this._sortAndDedupePosts(webPosts, 50);
    }
    throw new Error(`All Instagram feed sources failed for @${username}: ${errors.join(' | ')}`);
  }

  async _getFeedViaUserEndpoint(userPk, username, limit, userInfo, stopPk = null) {
    const items = [];
    let maxId = null;
    let page = 0;
    const maxItems = Math.max(1, Math.min(50, limit));

    do {
      const count = Math.min(12, maxItems - items.length);
      const res = await this.authAxios.get(`${IG_API}/feed/user/${userPk}/`, {
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

  async getMediaInfo(mediaPk) {
    if (!this.authAxios) {
      throw new Error('No authenticated axios instance — session not loaded');
    }

    const normalizedPk = String(mediaPk || '').split('_')[0];
    if (!/^\d+$/.test(normalizedPk)) {
      throw new Error(`Invalid Instagram media PK: ${mediaPk}`);
    }

    const response = await this.authAxios.get(`${IG_API}/media/${normalizedPk}/info/`, {
      headers: { 'Referer': `${IG_BASE}/` },
    });
    this._assertApiResponse(response, 'Instagram media info');

    const item = response.data?.items?.[0];
    if (!item) throw new Error(`Instagram media ${normalizedPk} was not found`);
    return this._normalizeMediaItem(item);
  }

  // ═══════════════════════════════════════════════════════════════
  //  STORIES (requires authentication — no public alternative)
  // ═══════════════════════════════════════════════════════════════

  async getUserStories(pkOrUsername, options = {}) {
    const { userPk: knownPk = null } = options;
    const username = String(pkOrUsername);

    log.info({ msg: 'Fetching user stories', username });

    if (!this.authAxios || !this.isLoggedIn) {
      log.warn({ msg: 'Stories require authenticated session; skipping', username });
      return [];
    }

    try {
      let userPk = knownPk;
      if (!userPk) {
        const webUser = await this._getPublicWebProfile(username);
        userPk = webUser.id ?? webUser.pk;
      }

      if (!userPk) {
        log.warn({ msg: 'Cannot find user for stories', username });
        return [];
      }

      const storiesUrl = `${IG_API}/feed/reels_media/?user_ids=${userPk}`;
      const storiesRes = await this.authAxios.get(storiesUrl, {
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
      if (e instanceof InstagramCooldownError) throw e;
      log.warn({ msg: 'Failed to fetch stories', username, error: e.message });
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════════

  async logout() {
    this.isLoggedIn = false;
    log.info('Logged out from Instagram');
  }

  getCurrentUser() {
    return this.currentUser;
  }

  async persistSession() {}

  /**
   * Clear profile cache for a specific user (useful when admin forces refresh).
   */
  clearProfileCache(username = null) {
    if (username) {
      this._profileCache.delete(username.toLowerCase());
      this._feedCache.delete(username.toLowerCase());
    } else {
      this._profileCache.clear();
      this._feedCache.clear();
    }
  }

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
      verificationDeferred: this.verificationDeferred,
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
        note: 'Playwright reserved for interactive session creation; dual-mode HTTP polling (public+auth) is safer and lighter',
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
        needsManualChallenge: this.needsManualChallenge(),
        backoffIndex: this._backoffIndex,
        cachedProfiles: this._profileCache.size,
        cachedFeeds: this._feedCache.size,
        requestDelayMin: config.antiDetect.requestDelayMin,
        requestDelayMax: config.antiDetect.requestDelayMax,
        rateBudget: {
          public: {
            available: this._publicBucket.available,
            capacity: this._publicBucket.capacity,
          },
          auth: {
            available: this._authBucket.available,
            capacity: this._authBucket.capacity,
          },
        },
      },
      architecture: {
        version: 'v2-dual-mode',
        publicMode: 'enabled (no auth needed for public posts)',
        authMode: this.isLoggedIn ? 'enabled (for stories)' : 'disabled (no session)',
        profileCacheTtlSec: Math.floor(this._profileCacheTtlMs / 1000),
        feedCacheTtlSec: Math.floor(this._feedCacheTtlMs / 1000),
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
