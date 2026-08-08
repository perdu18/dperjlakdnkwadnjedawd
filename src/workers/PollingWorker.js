/**
 * workers/PollingWorker.js
 * Worker اصلی: چک دوره‌ای اکانت‌ها برای پست و استوری جدید
 */

import cron from 'node-cron';
import { Mutex } from 'async-mutex';

import config from '../config/env.js';
import { workerLogger as log } from '../utils/Logger.js';
import { sleep, randomDelay, containsKeyword, extractHashtags } from '../utils/Helpers.js';
import { logEvent, incrementDailyStat } from '../database/db.js';
import TrackedAccountsRepository from '../database/TrackedAccountsRepository.js';
import SentItemsRepository from '../database/SentItemsRepository.js';
import igClient from '../instagram/IgClient.js';
import mediaDownloader from '../instagram/MediaDownloader.js';
import channelSender from '../telegram/ChannelSender.js';
import sendWorker from './SendWorker.js';

class PollingWorker {
  constructor() {
    this.postMutex = new Mutex();
    this.storyMutex = new Mutex();
    this.postCronTask = null;
    this.storyCronTask = null;
    this.isPollingPosts = false;
    this.isPollingStories = false;
  }

  /**
   * Start the polling workers
   */
  start() {
    // Posts polling
    const postIntervalSec = config.monitoring.pollIntervalPosts;
    const postCronExpr = this._secondsToCron(postIntervalSec);
    log.info({ msg: 'Starting post polling', interval: `${postIntervalSec}s`, cron: postCronExpr });

    this.postCronTask = cron.schedule(postCronExpr, async () => {
      if (this.isPollingPosts) {
        log.debug('Post polling already running, skipping');
        return;
      }
      await this.pollPosts();
    });

    // Stories polling
    const storyIntervalSec = config.monitoring.pollIntervalStories;
    const storyCronExpr = this._secondsToCron(storyIntervalSec);
    log.info({ msg: 'Starting story polling', interval: `${storyIntervalSec}s`, cron: storyCronExpr });

    this.storyCronTask = cron.schedule(storyCronExpr, async () => {
      if (this.isPollingStories) {
        log.debug('Story polling already running, skipping');
        return;
      }
      await this.pollStories();
    });

    // Initial run after 5 seconds
    setTimeout(async () => {
      log.info('Running initial poll...');
      await this.pollPosts();
      await sleep(2000);
      await this.pollStories();
    }, 5000);
  }

  /**
   * Stop polling
   */
  stop() {
    if (this.postCronTask) {
      this.postCronTask.stop();
      this.postCronTask = null;
    }
    if (this.storyCronTask) {
      this.storyCronTask.stop();
      this.storyCronTask = null;
    }
    log.info('Polling workers stopped');
  }

  /**
   * Poll posts for all active accounts
   */
  async pollPosts() {
    const release = await this.postMutex.acquire();
    this.isPollingPosts = true;

    try {
      const accounts = TrackedAccountsRepository.getAllActive();
      if (accounts.length === 0) {
        log.debug('No active accounts to poll for posts');
        return;
      }

      log.info({ msg: 'Polling posts for accounts', count: accounts.length });

      for (const account of accounts) {
        try {
          await this._pollPostsForAccount(account);
          // Random delay between accounts
          await randomDelay(config.antiDetect.requestDelayMin, config.antiDetect.requestDelayMax);
        } catch (e) {
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
   * Poll stories for all active accounts
   */
  async pollStories() {
    const release = await this.storyMutex.acquire();
    this.isPollingStories = true;

    try {
      const accounts = TrackedAccountsRepository.getAllActive();
      if (accounts.length === 0) {
        log.debug('No active accounts to poll for stories');
        return;
      }

      log.info({ msg: 'Polling stories for accounts', count: accounts.length });

      for (const account of accounts) {
        try {
          await this._pollStoriesForAccount(account);
          await randomDelay(config.antiDetect.requestDelayMin, config.antiDetect.requestDelayMax);
        } catch (e) {
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
   * Poll posts for one account
   */
  async _pollPostsForAccount(account) {
    log.info({ msg: 'Polling posts for account', username: account.username, hasPk: !!account.pk, lastPostPk: account.last_post_pk });

    // Refresh profile statistics on every poll so queued jobs carry current data.
    log.info({ msg: 'Refreshing user info for account', username: account.username, hasPk: !!account.pk });
    try {
      const info = await igClient.getUserByUsername(account.username);

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
        msg: 'User info refreshed',
        username: account.username,
        pk: info.pk,
        isPrivate: info.isPrivate,
        followers: info.followerCount,
        following: info.followingCount,
        posts: info.mediaCount,
      });

      if (info.isPrivate) {
        log.warn({ msg: 'Account is private - cannot fetch posts', username: account.username });
        TrackedAccountsRepository.recordError(account.username, 'Account is private');
        return;
      }
    } catch (e) {
      TrackedAccountsRepository.recordError(account.username, `getUserByUsername: ${e.message}`);
      if (!account.pk) {
        throw e;
      }
      log.warn({
        msg: 'Profile refresh failed; continuing with cached account data',
        username: account.username,
        error: e.message,
      });
    }

    // Fetch recent posts - استفاده از username به‌جای pk چون API جدید username می‌خواد
    let recentPosts;
    try {
      recentPosts = await igClient.getUserFeed(account.username, { limit: 5 });
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
      if (canonicalLastSeenPk && canonicalPostPk === canonicalLastSeenPk) break;
      newPosts.push(post);
    }

    log.info({
      msg: 'New posts analysis',
      username: account.username,
      totalFetched: recentPosts.length,
      newCount: newPosts.length,
      lastSeenPk,
      newestPk: recentPosts[0]?.pk,
    });

    if (newPosts.length === 0) {
      log.debug({ msg: 'No new posts', username: account.username });
      return;
    }

    log.info({ msg: 'New posts detected', username: account.username, count: newPosts.length });

    // Update last seen post PK (newest first)
    const newestPk = recentPosts[0].pk;
    TrackedAccountsRepository.updateLastPost(account.username, newestPk);

    // Filter and enqueue
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

      // Add to queue
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

    TrackedAccountsRepository.resetErrors(account.username);
  }

  /**
   * Poll stories for one account
   */
  async _pollStoriesForAccount(account) {
    log.info({ msg: 'Polling stories for account', username: account.username });

    // Use username directly (new API doesn't need pk for stories)
    let stories;
    try {
      stories = await igClient.getUserStories(account.username);
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
      if (story.pk === lastSeenPk) break;
      newStories.push(story);
    }

    if (newStories.length === 0) {
      log.debug({ msg: 'No new stories', username: account.username });
      return;
    }

    log.info({ msg: 'New stories detected', username: account.username, count: newStories.length });

    // Update last seen (newest first)
    const newestPk = stories[0].pk;
    TrackedAccountsRepository.updateLastStory(account.username, newestPk);

    // Enqueue (oldest first)
    for (const story of newStories.reverse()) {
      const exists = SentItemsRepository.exists(account.id, story.pk, 'story');
      if (exists) {
        log.debug({ msg: 'Story already in DB', storyPk: story.pk });
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

      await sendWorker.enqueue({
        sentItemId: created.lastInsertRowid,
        type: 'story',
        account,
        item: story,
      });
    }

    TrackedAccountsRepository.resetErrors(account.username);
  }

  /**
   * Check if a post should be sent (based on keyword/hashtag filters)
   */
  _shouldSendPost(post) {
    const keywords = config.monitoring.keywordFilter;
    const hashtags = config.monitoring.hashtagFilter;

    if (keywords.length === 0 && hashtags.length === 0) {
      return { pass: true };
    }

    // Check keywords in caption
    if (keywords.length > 0) {
      if (!containsKeyword(post.caption, keywords)) {
        return { pass: false, reason: `Caption does not match keywords: ${keywords.join(', ')}` };
      }
    }

    // Check hashtags
    if (hashtags.length > 0) {
      const postHashtags = extractHashtags(post.caption).map(h => h.slice(1).toLowerCase());
      const matched = hashtags.some(h => postHashtags.includes(h.toLowerCase()));
      if (!matched) {
        return { pass: false, reason: `Does not contain required hashtags: ${hashtags.join(', ')}` };
      }
    }

    return { pass: true };
  }

  /**
   * Convert seconds to cron expression
   * Supports: 30s, 60s, 90s, 120s, 300s, 600s, etc.
   */
  _secondsToCron(seconds) {
    if (seconds < 60) {
      return `*/${seconds} * * * * *`;  // Every N seconds
    }
    if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      return `*/${minutes} * * * *`;
    }
    const hours = Math.floor(seconds / 3600);
    return `0 */${hours} * * *`;
  }
}

const pollingWorker = new PollingWorker();
export default pollingWorker;
