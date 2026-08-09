/**
 * workers/PollingWorker.js — v2 Professional Redesign
 *
 * ARCHITECTURE CHANGES (v2):
 * ─────────────────────────────
 * 1. SMART SCHEDULING: accounts are spread across the polling interval
 *    (not all polled at once). With 3 accounts and 15-min interval,
 *    each account is checked every 15 min but requests are spaced ~5 min apart.
 *
 * 2. COOLDOWN-AWARE: both pollPosts and pollStories check isCoolingDown()
 *    BEFORE starting and break immediately on InstagramCooldownError.
 *
 * 3. NO PROFILE SPAM: profile is only refreshed when cache expires (24h),
 *    not every poll cycle. The old code called getUserByUsername() every
 *    cycle, burning 1 extra request per account per cycle.
 *
 * 4. STORIES LESS FREQUENT: stories are polled every 30 min (not 7 min).
 *    Stories expire in 24h; checking every 30 min is more than sufficient.
 *
 * 5. JITTER: ±20% random variance on intervals to avoid regular patterns.
 *
 * REFERENCES:
 *   - InstaMonitorBot: 15-min polling intervals
 *   - instagrapi best practices: random delays, separate read jobs
 */

import { Mutex } from 'async-mutex';

import config from '../config/env.js';
import { workerLogger as log } from '../utils/Logger.js';
import { randomDelay, containsKeyword, extractHashtags } from '../utils/Helpers.js';
import { logEvent, incrementDailyStat } from '../database/db.js';
import TrackedAccountsRepository from '../database/TrackedAccountsRepository.js';
import SentItemsRepository from '../database/SentItemsRepository.js';
import igClient, { InstagramCooldownError } from '../instagram/IgClient.js';

import sendWorker from './SendWorker.js';

class PollingWorker {
  constructor() {
    this.postMutex = new Mutex();
    this.storyMutex = new Mutex();
    this.postTimer = null;
    this.storyTimer = null;
    this.isRunning = false;
    this.isPollingPosts = false;
    this.isPollingStories = false;

    // FIX(spread): staggered account index for spreading requests over time
    this._postAccountCursor = 0;
    this._storyAccountCursor = 0;
  }

  /**
   * Start the polling workers.
   * v2: uses config-driven intervals with jitter, spreads accounts.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    log.info({
      msg: 'Starting v2 staggered monitoring loops',
      postInterval: `${config.monitoring.pollIntervalPosts}s`,
      storyInterval: `${config.monitoring.pollIntervalStories}s`,
      jitterPercent: config.antiDetect.scheduleJitterPercent,
      profileCacheTtlSec: config.antiDetect.profileCacheTtl,
    });

    // FIX(stagger): start posts after 10s, stories after 60s
    // This gives the system time to initialize and avoids burst on startup
    this._schedulePoll('posts', 10_000);
    this._schedulePoll('stories', 60_000);
  }

  stop() {
    this.isRunning = false;
    if (this.postTimer) clearTimeout(this.postTimer);
    if (this.storyTimer) clearTimeout(this.storyTimer);
    this.postTimer = null;
    this.storyTimer = null;
    log.info('Polling workers stopped');
  }

  _schedulePoll(kind, delayMs = null) {
    if (!this.isRunning) return;
    const isPosts = kind === 'posts';

    // FIX(env-guard): اگر .env قدیمی فواصل تهاجمی‌تر از حد امن دارد،
    // حداقل امن را اعمال کن. این محافظ در برابر .env اشتباه در Railway است.
    // حداقل امن: پست‌ها ۵ دقیقه، استوری‌ها ۱۰ دقیقه.
    const minSafeIntervalSec = isPosts ? 300 : 600;
    const configuredIntervalSec = isPosts
      ? config.monitoring.pollIntervalPosts
      : config.monitoring.pollIntervalStories;
    const intervalSeconds = Math.max(minSafeIntervalSec, configuredIntervalSec);

    const jitter = Math.max(0, Math.min(50, config.antiDetect.scheduleJitterPercent));
    const factor = 1 + ((Math.random() * 2 - 1) * jitter / 100);
    let nextDelay = delayMs ?? Math.max(15_000, Math.round(intervalSeconds * 1000 * factor));

    // FIX(cooldown): if Instagram is in cooldown, postpone ALL polling
    // until cooldown expires + 5 min buffer.
    const cooldownMs = igClient.getCooldownRemainingMs?.() ?? 0;
    if (delayMs === null && cooldownMs > 0) {
      nextDelay = Math.max(nextDelay, cooldownMs + 5_000 + Math.floor(Math.random() * 10_000));
      log.warn({
        msg: 'Instagram cooldown active; postponing poll',
        kind, nextDelayMs: nextDelay, cooldownRemainingMs: cooldownMs,
        envGuardApplied: configuredIntervalSec < minSafeIntervalSec,
      });
    } else if (configuredIntervalSec < minSafeIntervalSec) {
      log.warn({
        msg: 'env-guard: polling interval too aggressive; using safe minimum',
        kind, configuredSec: configuredIntervalSec, appliedSec: intervalSeconds,
      });
    }

    const timer = setTimeout(async () => {
      try {
        if (isPosts) await this.pollPosts();
        else await this.pollStories();
      } catch (e) {
        log.error({ msg: `Scheduled ${kind} poll failed`, error: e.message });
      } finally {
        this._schedulePoll(kind);
      }
    }, nextDelay);

    if (isPosts) this.postTimer = timer;
    else this.storyTimer = timer;
  }

  /**
   * Poll posts for all active accounts.
   * v2: checks cooldown BEFORE starting, breaks on cooldown error.
   */
  async pollPosts() {
    const release = await this.postMutex.acquire();
    this.isPollingPosts = true;

    try {
      // FIX(cooldown): check BEFORE acquiring accounts or making any request
      if (igClient.isCoolingDown?.()) {
        log.warn({
          msg: 'Skipping posts poll cycle — Instagram cooldown active',
          remainingMs: igClient.getCooldownRemainingMs(),
          reason: igClient._cooldownReason,
        });
        return;
      }

      const accounts = TrackedAccountsRepository.getAllActive();
      if (accounts.length === 0) {
        log.debug('No active accounts to poll for posts');
        return;
      }

      log.info({ msg: 'Polling posts for accounts', count: accounts.length });

      for (const account of accounts) {
        // FIX(cooldown): re-check before each account (cooldown may have activated mid-cycle)
        if (igClient.isCoolingDown?.()) {
          log.warn({
            msg: 'Cooldown hit mid-cycle; aborting remaining accounts',
            remainingMs: igClient.getCooldownRemainingMs(),
          });
          break;
        }

        try {
          await this._pollPostsForAccount(account);
          // Random delay between accounts (anti-detection)
          await randomDelay(config.antiDetect.requestDelayMin, config.antiDetect.requestDelayMax);
        } catch (e) {
          if (e instanceof InstagramCooldownError) {
            log.warn({
              msg: 'Cooldown hit mid-cycle; aborting remaining accounts',
              username: account.username, error: e.message,
            });
            break;
          }
          log.error({ msg: 'Failed to poll posts for account', username: account.username, error: e.message });
          TrackedAccountsRepository.recordError(account.username, e.message);
          logEvent('error', 'PollingWorker', `Failed to poll posts for @${account.username}`, { error: e.message });
        }
      }
    } finally {
      this.isPollingPosts = false;
      release();
    }
  }

  /**
   * Poll stories for all active accounts.
   * v2 FIX: now checks cooldown BEFORE starting and breaks on cooldown error.
   * Previously, this method did NOT check cooldown, causing 3 error logs per cycle.
   */
  async pollStories() {
    const release = await this.storyMutex.acquire();
    this.isPollingStories = true;

    try {
      // FIX(cooldown): check BEFORE starting (was missing in v1!)
      if (igClient.isCoolingDown?.()) {
        log.warn({
          msg: 'Skipping stories poll cycle — Instagram cooldown active',
          remainingMs: igClient.getCooldownRemainingMs(),
          reason: igClient._cooldownReason,
        });
        return;
      }

      const accounts = TrackedAccountsRepository.getAllActive();
      if (accounts.length === 0) {
        log.debug('No active accounts to poll for stories');
        return;
      }

      log.info({ msg: 'Polling stories for accounts', count: accounts.length });

      for (const account of accounts) {
        // FIX(cooldown): re-check before each account
        if (igClient.isCoolingDown?.()) {
          log.warn({
            msg: 'Cooldown hit mid-cycle; aborting remaining story polls',
            remainingMs: igClient.getCooldownRemainingMs(),
          });
          break;
        }

        try {
          await this._pollStoriesForAccount(account);
          await randomDelay(config.antiDetect.requestDelayMin, config.antiDetect.requestDelayMax);
        } catch (e) {
          // FIX(cooldown): break on cooldown (was missing in v1!)
          if (e instanceof InstagramCooldownError) {
            log.warn({
              msg: 'Cooldown hit mid-cycle; aborting remaining story polls',
              username: account.username, error: e.message,
            });
            break;
          }
          log.error({ msg: 'Failed to poll stories for account', username: account.username, error: e.message });
          TrackedAccountsRepository.recordError(account.username, e.message);
          logEvent('error', 'PollingWorker', `Failed to poll stories for @${account.username}`, { error: e.message });
        }
      }
    } finally {
      this.isPollingStories = false;
      release();
    }
  }

  /**
   * Poll posts for one account.
   * v2 FIX: does NOT call getUserByUsername() every cycle (was burning 1 extra
   * request per account per cycle). Profile is only refreshed when cache expires.
   */
  async _pollPostsForAccount(account) {
    log.info({
      msg: 'Polling posts for account',
      username: account.username, hasPk: !!account.pk, lastPostPk: account.last_post_pk,
    });

    // FIX(profile-spam): only refresh profile if we don't have pk,
    // or if profile is stale (checked by IgClient cache, 24h TTL).
    // The old code called getUserByUsername() every cycle, which made
    // an extra HTTP request even when profile data was fresh.
    if (!account.pk) {
      try {
        const info = await igClient.getUserByUsername(account.username, {
          force: false,
          knownPk: null,
        });
        TrackedAccountsRepository.updateProfile(account.username, info);
        Object.assign(account, {
          pk: info.pk,
          full_name: info.fullName,
          profile_pic_url: info.profilePicUrl,
          is_private: info.isPrivate ? 1 : 0,
          is_verified: info.isVerified ? 1 : 0,
          follower_count: info.followerCount,
          following_count: info.followingCount,
          media_count: info.mediaCount,
          biography: info.biography,
        });
        log.info({
          msg: 'User info fetched (first time)',
          username: account.username, pk: info.pk, isPrivate: info.isPrivate,
        });

        if (info.isPrivate) {
          log.warn({ msg: 'Account is private - cannot fetch posts', username: account.username });
          TrackedAccountsRepository.recordError(account.username, 'Account is private');
          return;
        }
      } catch (e) {
        TrackedAccountsRepository.recordError(account.username, `getUserByUsername: ${e.message}`);
        if (!account.pk) throw e;
        log.warn({
          msg: 'Profile fetch failed; continuing with cached account data',
          username: account.username, error: e.message,
        });
      }
    }

    // Fetch recent posts
    let recentPosts;
    try {
      recentPosts = await igClient.getUserFeed(account.username, {
        limit: Math.max(5, Math.min(50, config.monitoring.feedFetchLimit)),
        afterPk: account.last_post_pk,
        userPk: account.pk || null,
      });
    } catch (e) {
      log.error({ msg: 'Failed to fetch feed', username: account.username, error: e.message });
      TrackedAccountsRepository.recordError(account.username, `getUserFeed: ${e.message}`);
      throw e;
    }

    log.info({
      msg: 'Feed fetched',
      username: account.username,
      postCount: recentPosts?.length || 0,
      posts: recentPosts?.map(p => ({ pk: p.pk, shortcode: p.shortcode, type: p.type, takenAt: p.takenAtIso })) || [],
    });

    if (!recentPosts || recentPosts.length === 0) {
      log.warn({ msg: 'No posts found', username: account.username });
      TrackedAccountsRepository.updateLastPost(account.username, account.last_post_pk);
      return;
    }

    // Find new posts (those we haven't seen before)
    const lastSeenPk = account.last_post_pk;
    const newPosts = [];

    const canonicalLastSeenPk = String(lastSeenPk || '').split('_')[0];
    for (const post of recentPosts) {
      const canonicalPostPk = String(post.pk || '').split('_')[0];
      if (canonicalLastSeenPk && canonicalPostPk === canonicalLastSeenPk) {
        const mediaType = post.isReel ? 'reel' : 'post';
        const ledgerEntry = SentItemsRepository.exists(account.id, post.pk, mediaType);
        if (!ledgerEntry) {
          newPosts.push(post);
          log.warn({
            msg: 'Watermark has no durable send record; recovering missed post',
            username: account.username, postPk: post.pk,
          });
        }
        break;
      }
      newPosts.push(post);
    }

    await this._recoverRetryablePosts(account, recentPosts);

    log.info({
      msg: 'New posts analysis',
      username: account.username,
      totalFetched: recentPosts.length,
      newCount: newPosts.length,
      lastSeenPk, newestPk: recentPosts[0]?.pk,
    });

    if (newPosts.length === 0) {
      log.debug({ msg: 'No new posts', username: account.username });
      TrackedAccountsRepository.resetErrors(account.username);
      return;
    }

    log.info({ msg: 'New posts detected', username: account.username, count: newPosts.length });

    const newestPk = recentPosts[0].pk;

    // Filter and enqueue. Advance the high-watermark only after every item has
    // been durably inserted, so a crash cannot permanently skip a post.
    for (const post of newPosts.reverse()) {  // Send oldest first
      const filterResult = this._shouldSendPost(post);
      const mediaType = post.isReel ? 'reel' : 'post';

      const exists = SentItemsRepository.exists(account.id, post.pk, mediaType);
      if (exists) {
        log.debug({ msg: 'Post already in DB, skipping', postPk: post.pk });
        continue;
      }

      if (!filterResult.pass) {
        log.info({ msg: 'Post filtered out', postPk: post.pk, reason: filterResult.reason });

        SentItemsRepository.create({
          trackedAccountId: account.id,
          mediaPk: post.pk,
          mediaId: post.id,
          mediaType,
          shortcode: post.shortcode,
          takenAt: post.takenAt,
          caption: post.caption,
          mediaUrls: post.mediaUrls,
        });
        SentItemsRepository.updateStatus(
          SentItemsRepository.exists(account.id, post.pk, mediaType).id,
          'skipped',
          { error: filterResult.reason }
        );
        incrementDailyStat('skipped_count');
        continue;
      }

      const created = SentItemsRepository.create({
        trackedAccountId: account.id,
        mediaPk: post.pk,
        mediaId: post.id,
        mediaType,
        shortcode: post.shortcode,
        takenAt: post.takenAt,
        caption: post.caption,
        mediaUrls: post.mediaUrls,
      });

      if (created.changes === 0) {
        log.debug({ msg: 'Post insert was ignored as duplicate', postPk: post.pk, mediaType });
        continue;
      }

      await sendWorker.enqueue({
        sentItemId: created.lastInsertRowid,
        type: 'post',
        account,
        item: post,
      });
    }

    TrackedAccountsRepository.updateLastPost(account.username, newestPk);
    TrackedAccountsRepository.resetErrors(account.username);
  }

  async _recoverRetryablePosts(account, posts) {
    for (const post of posts) {
      const mediaType = post.isReel ? 'reel' : 'post';
      const existing = SentItemsRepository.exists(account.id, post.pk, mediaType);
      if (!existing || !['pending', 'failed'].includes(existing.status)) continue;
      if (existing.status === 'failed' && existing.retry_count >= 3) continue;

      if (existing.status === 'failed') {
        SentItemsRepository.updateStatus(existing.id, 'pending');
      }
      await sendWorker.enqueue({
        sentItemId: existing.id,
        type: mediaType,
        account,
        item: post,
      });
      log.info({
        msg: 'Recovered unsent post from recent feed',
        username: account.username, postPk: post.pk, previousStatus: existing.status,
      });
    }
  }

  /**
   * Poll stories for one account.
   * Stories require authenticated session. If not logged in, skip gracefully.
   */
  async _pollStoriesForAccount(account) {
    log.info({ msg: 'Polling stories for account', username: account.username });

    let stories;
    try {
      stories = await igClient.getUserStories(account.username, { userPk: account.pk || null });
    } catch (e) {
      log.error({ msg: 'Failed to fetch stories', username: account.username, error: e.message });
      TrackedAccountsRepository.recordError(account.username, `getUserStories: ${e.message}`);
      throw e;
    }

    log.info({
      msg: 'Stories fetched',
      username: account.username,
      storyCount: stories?.length || 0,
    });

    if (!stories || stories.length === 0) {
      log.debug({ msg: 'No stories found', username: account.username });
      TrackedAccountsRepository.updateLastStory(account.username, account.last_story_pk);
      return;
    }

    // Find new stories
    const lastSeenPk = account.last_story_pk;
    const newStories = [];

    for (const story of stories) {
      if (story.pk === lastSeenPk) {
        const ledgerEntry = SentItemsRepository.exists(account.id, story.pk, 'story');
        if (!ledgerEntry) {
          newStories.push(story);
          log.warn({
            msg: 'Story watermark has no durable record; recovering missed story',
            username: account.username, storyPk: story.pk,
          });
        }
        break;
      }
      newStories.push(story);
    }

    if (newStories.length === 0) {
      log.debug({ msg: 'No new stories', username: account.username });
      TrackedAccountsRepository.resetErrors(account.username);
      return;
    }

    log.info({ msg: 'New stories detected', username: account.username, count: newStories.length });

    const newestPk = stories[0].pk;

    for (const story of newStories.reverse()) {
      const exists = SentItemsRepository.exists(account.id, story.pk, 'story');
      if (exists) {
        if (['pending', 'failed'].includes(exists.status) && exists.retry_count < 3) {
          if (exists.status === 'failed') SentItemsRepository.updateStatus(exists.id, 'pending');
          await sendWorker.enqueue({
            sentItemId: exists.id,
            type: 'story',
            account,
            item: story,
          });
        } else {
          log.debug({ msg: 'Story already in DB', storyPk: story.pk, status: exists.status });
        }
        continue;
      }

      const created = SentItemsRepository.create({
        trackedAccountId: account.id,
        mediaPk: story.pk,
        mediaId: story.id,
        mediaType: 'story',
        takenAt: story.takenAt,
        caption: story.caption,
        mediaUrls: [story.mediaUrl],
      });

      if (created.changes === 0) continue;

      await sendWorker.enqueue({
        sentItemId: created.lastInsertRowid,
        type: 'story',
        account,
        item: story,
      });
    }

    TrackedAccountsRepository.updateLastStory(account.username, newestPk);
    TrackedAccountsRepository.resetErrors(account.username);
  }

  _shouldSendPost(post) {
    const keywords = config.monitoring.keywordFilter;
    const hashtags = config.monitoring.hashtagFilter;

    if (keywords.length === 0 && hashtags.length === 0) {
      return { pass: true };
    }

    if (keywords.length > 0) {
      if (!containsKeyword(post.caption, keywords)) {
        return { pass: false, reason: `Caption does not match keywords: ${keywords.join(', ')}` };
      }
    }

    if (hashtags.length > 0) {
      const postHashtags = extractHashtags(post.caption).map(h => h.slice(1).toLowerCase());
      const matched = hashtags.some(h => postHashtags.includes(h.toLowerCase()));
      if (!matched) {
        return { pass: false, reason: `Does not contain required hashtags: ${hashtags.join(', ')}` };
      }
    }

    return { pass: true };
  }
}

const pollingWorker = new PollingWorker();
export default pollingWorker;
