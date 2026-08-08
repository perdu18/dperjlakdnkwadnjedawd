/**
 * telegram/MessageFormatter.js
 * تبدیل محتوای اینستاگرام به پیام تلگرام (HTML format)
 *
 * تمام زمان‌ها به وقت ایران (Asia/Tehran) نمایش داده میشه.
 * فرمت پیام‌ها حرفه‌ای و با جزئیات کامل هست.
 */

import { extractHashtags, extractMentions, truncate } from '../utils/Helpers.js';

const TEHRAN_TIMEZONE = 'Asia/Tehran';

class MessageFormatter {
  /**
   * Format timestamp to Iran time
   */
  formatIranTime(timestamp, opts = {}) {
    if (!timestamp) return null;
    try {
      const date = new Date(timestamp * 1000);
      const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
        timeZone: TEHRAN_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        ...opts,
      });
      return dateTimeFormat.format(date);
    } catch (e) {
      return new Date(timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  /**
   * Format relative time (e.g., "۲ ساعت پیش")
   */
  formatRelativeTime(timestamp) {
    if (!timestamp) return null;
    const now = Date.now();
    const diff = now - (timestamp * 1000);
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return 'همین الان';
    if (minutes < 60) return `${minutes} دقیقه پیش`;
    if (hours < 24) return `${hours} ساعت پیش`;
    if (days < 7) return `${days} روز پیش`;
    return this.formatIranTime(timestamp, { dateStyle: 'short' });
  }

  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  formatCaption(caption, options = {}) {
    if (!caption) return '';
    const { maxLength = Infinity, linkifyHashtags = true, linkifyMentions = true } = options;
    let text = Number.isFinite(maxLength) ? truncate(caption, maxLength) : caption;
    text = this.escapeHtml(text);
    if (linkifyHashtags) {
      text = text.replace(/#([\w\u0600-\u06FF]+)/g, (match, tag) =>
        `<a href="https://instagram.com/explore/tags/${encodeURIComponent(tag)}">${this.escapeHtml(match)}</a>`);
    }
    if (linkifyMentions) {
      text = text.replace(/@([a-zA-Z0-9._]+)/g, (match, username) =>
        `<a href="https://instagram.com/${username}">${this.escapeHtml(match)}</a>`);
    }
    return text;
  }

  formatNumber(num) {
    const value = Number(num ?? 0);
    return Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
  }

  /**
   * Telegram limits apply after HTML entity parsing, not to the raw markup.
   * JavaScript string length matches Telegram's UTF-16 entity offsets.
   */
  getRenderedLength(html) {
    if (!html) return 0;
    return String(html)
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(?:39|x27);/gi, "'")
      .replace(/&amp;/g, '&')
      .length;
  }

  /**
   * Keep all post metadata while fitting the Instagram caption into Telegram's
   * media-caption limit. The caption is rebuilt on every attempt, so HTML tags
   * and expandable-blockquote entities are never cut in half.
   */
  formatPostForMedia(post, accountInfo, maxLength = 1024) {
    const originalCaption = String(post.caption || '');
    const full = this.formatPost(post, accountInfo, { captionMaxLength: Infinity });
    if (this.getRenderedLength(full) <= maxLength) {
      return { html: full, captionTruncated: false };
    }

    let low = 0;
    let high = originalCaption.length;
    let best = this.formatPost(post, accountInfo, { captionMaxLength: 0 });

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = this.formatPost(post, accountInfo, { captionMaxLength: mid });
      if (this.getRenderedLength(candidate) <= maxLength) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (this.getRenderedLength(best) > maxLength) {
      throw new Error('Post metadata exceeds Telegram media caption limit');
    }

    return { html: best, captionTruncated: true };
  }

  /**
   * Format account stats (followers, following, posts)
   */
  formatAccountStats(account) {
    if (!account) return '';
    const parts = [];

    if (account.followerCount != null) {
      parts.push(`👥 فالوور: ${this.formatNumber(account.followerCount)}`);
    }
    if (account.followingCount != null) {
      parts.push(`👤 فالووینگ: ${this.formatNumber(account.followingCount)}`);
    }
    if (account.mediaCount != null) {
      parts.push(`📸 پست‌ها: ${this.formatNumber(account.mediaCount)}`);
    }

    return parts.join('  |  ');
  }

  /**
   * Build a message for a post — professional format with full details
   */
  formatPost(post, accountInfo, options = {}) {
    const { captionMaxLength = Infinity } = options;
    const parts = [];

    // ============================================
    // Header with type icon
    // ============================================
    let typeIcon = '📸';
    let typeLabel = 'پست';

    if (post.type === 'reel') {
      typeIcon = '🎬';
      typeLabel = 'ریلز';
    } else if (post.type === 'video') {
      typeIcon = '🎥';
      typeLabel = 'ویدیو';
    } else if (post.type === 'carousel') {
      typeIcon = '🖼';
      typeLabel = 'گالری';
    }

    parts.push(`<b>━━━ ${typeIcon} اینستاگرام | ${typeLabel} ━━━</b>`);
    parts.push('');

    // ============================================
    // Author info with stats
    // ============================================
    const author = post.user || accountInfo;
    if (author) {
      const name = this.escapeHtml(author.fullName || author.username);
      const username = this.escapeHtml(author.username);
      const verifiedBadge = author.isVerified ? ' ✅' : '';

      parts.push(`👤 <b>منبع:</b> <a href="https://instagram.com/${username}">${name}${verifiedBadge}</a> <code>(@${username})</code>`);

      // Account stats
      const stats = this.formatAccountStats({
        followerCount: author.followerCount ?? accountInfo?.followerCount,
        followingCount: author.followingCount ?? accountInfo?.followingCount,
        mediaCount: author.mediaCount ?? accountInfo?.mediaCount,
      });
      if (stats) {
        parts.push(`📊 <b>آمار اکانت:</b> ${stats}`);
      }
      parts.push('');
    }

    // ============================================
    // Caption
    // ============================================
    if (post.caption && captionMaxLength !== 0) {
      parts.push(`📝 <b>کپشن:</b>`);
      parts.push(`<blockquote expandable>${this.formatCaption(post.caption, { maxLength: captionMaxLength })}</blockquote>`);
      parts.push('');
    }

    // ============================================
    // Post details
    // ============================================
    parts.push('<b>━━━ جزئیات پست ━━━</b>');

    // Link to post
    if (post.shortcode) {
      parts.push(`🔗 <b>مشاهده پست:</b> <a href="https://instagram.com/p/${post.shortcode}">کلیک کنید</a>`);
    }

    // Time (Iran timezone)
    if (post.takenAt) {
      const iranTime = this.formatIranTime(post.takenAt);
      const relativeTime = this.formatRelativeTime(post.takenAt);
      parts.push(`🕐 <b>زمان انتشار:</b> ${this.escapeHtml(iranTime)} <i>(${this.escapeHtml(relativeTime)})</i>`);
    }

    // Post type details
    if (post.type === 'carousel' && post.carouselItems?.length > 0) {
      parts.push(`🖼 <b>تعداد تصاویر:</b> ${post.carouselItems.length}`);
    }
    if (post.isVideo) {
      parts.push(`🎥 <b>نوع:</b> ویدیو${post.isReel ? ' (ریلز)' : ''}`);
    }

    // Location
    if (post.location?.name) {
      parts.push(`📍 <b>موقعیت:</b> ${this.escapeHtml(post.location.name)}`);
    }

    // Music (for reels)
    if (post.music?.title) {
      parts.push(`🎵 <b>موسیقی:</b> ${this.escapeHtml(post.music.title)}`);
    }

    // Usertags
    if (post.usertags && post.usertags.length > 0) {
      const tags = post.usertags.slice(0, 10).map(u => `@${this.escapeHtml(u)}`).join(' ');
      parts.push(`👥 <b>تگ شده:</b> ${tags}`);
    }

    // ============================================
    // Stats (likes, comments, views)
    // ============================================
    const statsParts = [
      `❤️ ${this.formatNumber(post.likeCount)}`,
      `💬 ${this.formatNumber(post.commentCount)}`,
    ];
    if (post.viewCount != null) statsParts.push(`👁 ${this.formatNumber(post.viewCount)}`);

    parts.push('');
    parts.push(`📈 <b>آمار پست:</b> ${statsParts.join('  •  ')}`);

    // ============================================
    // Footer
    // ============================================
    parts.push('');
    parts.push(`<i>🤖 ارسال شده توسط ربات مانیتور اینستاگرام</i>`);

    return parts.filter(Boolean).join('\n');
  }

  formatStoryForMedia(story, accountInfo, maxLength = 1024) {
    const originalCaption = String(story.caption || '');
    const full = this.formatStory(story, accountInfo, { captionMaxLength: Infinity });
    if (this.getRenderedLength(full) <= maxLength) {
      return { html: full, captionTruncated: false };
    }

    let low = 0;
    let high = originalCaption.length;
    let best = this.formatStory(story, accountInfo, { captionMaxLength: 0 });
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = this.formatStory(story, accountInfo, { captionMaxLength: mid });
      if (this.getRenderedLength(candidate) <= maxLength) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (this.getRenderedLength(best) > maxLength) {
      throw new Error('Story metadata exceeds Telegram media caption limit');
    }
    return { html: best, captionTruncated: originalCaption.length > 0 };
  }

  /**
   * Build a message for a story — professional format
   */
  formatStory(story, accountInfo, options = {}) {
    const { captionMaxLength = Infinity } = options;
    const parts = [];

    // Header
    let typeIcon = '📖';
    let typeLabel = 'استوری';
    if (story.isVideo) {
      typeIcon = '🎥';
      typeLabel = 'استوری ویدیویی';
    }

    const cfLabel = story.isCloseFriends ? ' ⭐ (Close Friends)' : '';
    parts.push(`<b>━━━ ${typeIcon} اینستاگرام | ${typeLabel}${cfLabel} ━━━</b>`);
    parts.push('');

    // Author with stats
    const author = accountInfo || story.user;
    if (author) {
      const name = this.escapeHtml(author.fullName || author.username);
      const username = this.escapeHtml(author.username);
      const verifiedBadge = author.isVerified ? ' ✅' : '';

      parts.push(`👤 <b>منبع:</b> <a href="https://instagram.com/${username}">${name}${verifiedBadge}</a> <code>(@${username})</code>`);

      // Account stats
      const stats = this.formatAccountStats({
        followerCount: author.followerCount ?? accountInfo?.followerCount,
        followingCount: author.followingCount ?? accountInfo?.followingCount,
        mediaCount: author.mediaCount ?? accountInfo?.mediaCount,
      });
      if (stats) {
        parts.push(`📊 <b>آمار اکانت:</b> ${stats}`);
      }
      parts.push('');
    }

    // Caption
    if (story.caption && captionMaxLength !== 0) {
      parts.push(`📝 <b>کپشن:</b>`);
      parts.push(`<blockquote expandable>${this.formatCaption(story.caption, { maxLength: captionMaxLength })}</blockquote>`);
      parts.push('');
    }

    // Details
    parts.push('<b>━━━ جزئیات استوری ━━━</b>');

    // Mentions
    if (story.mentions && story.mentions.length > 0) {
      parts.push(`👥 <b>منشن‌ها:</b> ${story.mentions.map(m => '@' + this.escapeHtml(m)).join(' ')}`);
    }

    // Hashtags
    if (story.hashtags && story.hashtags.length > 0) {
      parts.push(`#️⃣ <b>هشتگ‌ها:</b> ${story.hashtags.map(h => '#' + this.escapeHtml(h)).join(' ')}`);
    }

    // Locations
    if (story.locations && story.locations.length > 0) {
      parts.push(`📍 <b>موقعیت:</b> ${story.locations.map(l => this.escapeHtml(l)).join(', ')}`);
    }

    // Time
    if (story.takenAt) {
      const iranTime = this.formatIranTime(story.takenAt);
      const relativeTime = this.formatRelativeTime(story.takenAt);
      parts.push(`🕐 <b>زمان انتشار:</b> ${this.escapeHtml(iranTime)} <i>(${this.escapeHtml(relativeTime)})</i>`);
    }

    // Expiry
    if (story.expiringAt) {
      const expiryTime = this.formatIranTime(story.expiringAt);
      parts.push(`⏰ <b>انقضا:</b> ${this.escapeHtml(expiryTime)}`);
    }

    // Footer
    parts.push('');
    parts.push(`<i>🤖 ارسال شده توسط ربات مانیتور اینستاگرام</i>`);

    return parts.filter(Boolean).join('\n');
  }

  /**
   * Build daily stats message
   */
  formatDailyStats(stats) {
    const parts = ['<b>━━━ 📊 آمار امروز ━━━</b>', ''];
    const today = this.formatIranTime(Math.floor(Date.now() / 1000), { dateStyle: 'full' });
    parts.push(`📅 <b>تاریخ:</b> ${this.escapeHtml(today)}`);
    parts.push(`✅ <b>ارسال شده:</b> ${this.formatNumber(stats.sent || 0)}`);
    parts.push(`📸 <b>پست‌ها:</b> ${this.formatNumber(stats.posts || 0)}`);
    parts.push(`📖 <b>استوری‌ها:</b> ${this.formatNumber(stats.stories || 0)}`);
    parts.push(`🎬 <b>ریلزها:</b> ${this.formatNumber(stats.reels || 0)}`);
    parts.push(`❌ <b>ناموفق:</b> ${this.formatNumber(stats.failed || 0)}`);
    parts.push(`⏭ <b>نادیده گرفته شده:</b> ${this.formatNumber(stats.skipped || 0)}`);
    parts.push(`📋 <b>در انتظار:</b> ${this.formatNumber(stats.pending || 0)}`);
    return parts.join('\n');
  }

  /**
   * Build alert message
   */
  formatAlert(title, details) {
    const parts = ['🚨 <b>هشدار</b>', ''];
    parts.push(`<b>${this.escapeHtml(title)}</b>`);
    if (details) {
      parts.push(`\n<code>${this.escapeHtml(details)}</code>`);
    }
    return parts.join('\n');
  }

  /**
   * Build error message
   */
  formatError(error, context = {}) {
    const parts = ['❌ <b>خطا</b>', ''];
    parts.push(`<b>پیام:</b> <code>${this.escapeHtml(error.message || String(error))}</code>`);
    if (context.module) parts.push(`<b>ماژول:</b> ${this.escapeHtml(context.module)}`);
    if (context.account) parts.push(`<b>اکانت:</b> @${this.escapeHtml(context.account)}`);
    if (context.operation) parts.push(`<b>عملیات:</b> ${this.escapeHtml(context.operation)}`);
    if (error.stack) {
      const stack = truncate(error.stack, 500);
      parts.push(`\n<code>${this.escapeHtml(stack)}</code>`);
    }
    return parts.join('\n');
  }

  /**
   * Build detailed failure report
   */
  formatFailureReport(details) {
    const {
      type = 'unknown', account = 'unknown', mediaPk = 'unknown',
      shortcode = null, caption = '', mediaUrls = [],
      error = null, downloadStage = 'unknown',
      timestamp = new Date().toISOString(),
    } = details;

    const parts = [];
    const typeEmoji = type === 'story' ? '📖' : (type === 'reel' ? '🎬' : '📸');
    const stageLabel = downloadStage === 'download' ? 'دانلود' : 'ارسال';
    parts.push(`<b>━━━ ❌ خطا در ${stageLabel} ${typeEmoji} ${this.escapeHtml(type)} ━━━</b>`);
    parts.push('');
    parts.push(`📊 <b>اکانت منبع:</b> @${this.escapeHtml(account)}`);
    parts.push(`🆔 <b>شناسه مدیا:</b> <code>${this.escapeHtml(String(mediaPk))}</code>`);
    if (shortcode) {
      parts.push(`🔗 <b>Shortcode:</b> <code>${this.escapeHtml(shortcode)}</code>`);
      parts.push(`🌐 <b>لینک:</b> <a href="https://instagram.com/p/${this.escapeHtml(shortcode)}">مشاهده در اینستاگرام</a>`);
    }
    if (caption) {
      const cap = truncate(caption, 200);
      parts.push(`\n📝 <b>کپشن:</b>\n<i>${this.escapeHtml(cap)}</i>`);
    }
    if (mediaUrls && mediaUrls.length > 0) {
      parts.push(`\n📎 <b>URLهای مدیا (${mediaUrls.length}):</b>`);
      for (let i = 0; i < Math.min(mediaUrls.length, 3); i++) {
        const url = String(mediaUrls[i]).slice(0, 100);
        parts.push(`<code>${this.escapeHtml(url)}${String(mediaUrls[i]).length > 100 ? '...' : ''}</code>`);
      }
      if (mediaUrls.length > 3) {
        parts.push(`<i>... و ${mediaUrls.length - 3} مورد دیگر</i>`);
      }
    }
    if (error) {
      const errorMsg = error.message || String(error);
      parts.push(`\n❌ <b>خطا:</b>`);
      parts.push(`<code>${this.escapeHtml(truncate(errorMsg, 1000))}</code>`);
      if (error.stack) {
        const stackLines = error.stack.split('\n').slice(0, 5).join('\n');
        parts.push(`\n📚 <b>Stack Trace:</b>`);
        parts.push(`<code>${this.escapeHtml(stackLines)}</code>`);
      }
    }
    parts.push(`\n🔧 <b>مرحله:</b> ${downloadStage === 'download' ? '📥 دانلود مدیا' : '📤 ارسال به تلگرام'}`);
    const iranTime = this.formatIranTime(Math.floor(new Date(timestamp).getTime() / 1000));
    parts.push(`🕐 <b>زمان:</b> ${this.escapeHtml(iranTime)}`);
    parts.push(`\n<i>🤖 ربات مانیتور اینستاگرام — گزارش خطا</i>`);
    return parts.join('\n');
  }
}

const messageFormatter = new MessageFormatter();
export default messageFormatter;
