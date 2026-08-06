/**
 * telegram/MessageFormatter.js
 * تبدیل محتوای اینستاگرام به پیام تلگرام (HTML format)
 *
 * تمام زمان‌ها به وقت ایران (Asia/Tehran) نمایش داده میشن.
 */

import { extractHashtags, extractMentions, truncate, formatBytes } from '../utils/Helpers.js';

// Timezone offset for Iran (UTC+3:30 standard, UTC+4:30 DST)
// We use Intl with Tehran timezone for accurate DST handling
const TEHRAN_TIMEZONE = 'Asia/Tehran';

class MessageFormatter {
  /**
   * Format timestamp to Iran time
   *
   * @param {number|null|undefined} timestamp - Unix timestamp in seconds
   * @param {Object} opts - { dateStyle: 'full'|'long'|'medium'|'short', timeStyle: ... }
   * @returns {string} Formatted date/time in Iran timezone (in Persian-friendly format)
   */
  formatIranTime(timestamp, opts = {}) {
    if (!timestamp) return null;

    try {
      const date = new Date(timestamp * 1000);

      // Default format: "۱۴۰۳/۰۵/۱۵ ۱۴:۳۰"
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
      // Fallback to ISO string
      try {
        return new Date(timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ');
      } catch {
        return null;
      }
    }
  }

  /**
   * Format timestamp with relative time (e.g., "۲ ساعت پیش")
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

  /**
   * Escape HTML special characters
   */
  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Format caption with HTML linkification
   */
  formatCaption(caption, options = {}) {
    if (!caption) return '';

    const { maxLength = 1500, linkifyHashtags = true, linkifyMentions = true } = options;

    let text = caption;
    text = truncate(text, maxLength);
    text = this.escapeHtml(text);

    if (linkifyHashtags) {
      text = text.replace(/#([\w\u0600-\u06FF]+)/g, (match, tag) => {
        return `<a href="https://instagram.com/explore/tags/${encodeURIComponent(tag)}">${this.escapeHtml(match)}</a>`;
      });
    }

    if (linkifyMentions) {
      text = text.replace(/@([a-zA-Z0-9._]+)/g, (match, username) => {
        return `<a href="https://instagram.com/${username}">${this.escapeHtml(match)}</a>`;
      });
    }

    return text;
  }

  /**
   * Format user info
   */
  formatUserInfo(user) {
    if (!user) return '';
    const name = this.escapeHtml(user.fullName || user.username);
    const username = this.escapeHtml(user.username);
    const verifiedBadge = user.isVerified ? ' ✅' : '';

    return `<a href="https://instagram.com/${username}">${name}${verifiedBadge}</a> <code>(@${username})</code>`;
  }

  /**
   * Format location
   */
  formatLocation(location) {
    if (!location?.name) return '';
    return `<b>📍 موقعیت:</b> ${this.escapeHtml(location.name)}`;
  }

  /**
   * Format music info (for Reels)
   */
  formatMusic(music) {
    if (!music?.title) return '';
    return `🎵 <b>موسیقی:</b> ${this.escapeHtml(music.title)}`;
  }

  /**
   * Format stats (likes, comments, views) with Persian numerals
   */
  formatStats(item) {
    const parts = [];

    if (item.likeCount) parts.push(`❤️ ${this.formatNumber(item.likeCount)}`);
    if (item.commentCount) parts.push(`💬 ${this.formatNumber(item.commentCount)}`);
    if (item.viewCount) parts.push(`👁 ${this.formatNumber(item.viewCount)}`);

    return parts.join('  •  ');
  }

  /**
   * Format a number with thousand separators
   * Uses English digits but formats like "1,234,567"
   */
  formatNumber(num) {
    if (!num) return '0';
    return num.toLocaleString('en-US');
  }

  /**
   * Format usertags
   */
  formatUsertags(usertags) {
    if (!usertags || usertags.length === 0) return '';
    const list = usertags.slice(0, 10).map(u => `@${this.escapeHtml(u)}`).join(' ');
    return `<b>تگ شده:</b> ${list}`;
  }

  /**
   * Build a message for a post — professional format
   */
  formatPost(post, accountInfo) {
    const parts = [];

    // Header with type icon
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
    } else if (post.type === 'photo') {
      typeIcon = '📸';
      typeLabel = 'عکس';
    }

    parts.push(`<b>━━━ ${typeIcon} اینستاگرام | ${typeLabel} ━━━</b>`);
    parts.push('');

    // Author
    const author = post.user || accountInfo;
    if (author) {
      parts.push(`👤 <b>منبع:</b> ${this.formatUserInfo(author)}`);
    }

    // Caption
    if (post.caption) {
      parts.push('');
      parts.push(`📝 <b>کپشن:</b>`);
      parts.push(this.formatCaption(post.caption, { maxLength: 1500 }));
    }

    // Spacer
    parts.push('');

    // Link to post
    if (post.shortcode) {
      parts.push(`🔗 <b>مشاهده پست:</b> <a href="https://instagram.com/p/${post.shortcode}">اینجا کلیک کنید</a>`);
    }

    // Time (Iran timezone)
    if (post.takenAt) {
      const iranTime = this.formatIranTime(post.takenAt);
      const relativeTime = this.formatRelativeTime(post.takenAt);
      parts.push(`🕐 <b>زمان انتشار:</b> ${this.escapeHtml(iranTime)} <i>(${this.escapeHtml(relativeTime)})</i>`);
    }

    // Location
    if (post.location) {
      const loc = this.formatLocation(post.location);
      if (loc) parts.push(loc);
    }

    // Music (for reels)
    if (post.music) {
      const m = this.formatMusic(post.music);
      if (m) parts.push(m);
    }

    // Usertags
    if (post.usertags && post.usertags.length > 0) {
      const tags = this.formatUsertags(post.usertags);
      if (tags) parts.push(tags);
    }

    // Stats
    const stats = this.formatStats(post);
    if (stats) {
      parts.push('');
      parts.push(`📊 <b>آمار:</b> ${stats}`);
    }

    // Footer
    parts.push('');
    parts.push(`<i>🤖 ارسال شده توسط ربات مانیتور اینستاگرام</i>`);

    return parts.filter(Boolean).join('\n');
  }

  /**
   * Build a message for a story
   */
  formatStory(story, accountInfo) {
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

    // Author
    const author = accountInfo || story.user;
    if (author) {
      parts.push(`👤 <b>منبع:</b> ${this.formatUserInfo(author)}`);
    }

    // Caption
    if (story.caption) {
      parts.push('');
      parts.push(`📝 <b>کپشن:</b>`);
      parts.push(this.formatCaption(story.caption, { maxLength: 500 }));
    }

    // Mentions
    if (story.mentions && story.mentions.length > 0) {
      parts.push('');
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

    // Time (Iran timezone)
    parts.push('');
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
   * Build a daily stats message
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
   * Build an alert message
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

    if (context.module) {
      parts.push(`<b>ماژول:</b> ${this.escapeHtml(context.module)}`);
    }
    if (context.account) {
      parts.push(`<b>اکانت:</b> @${this.escapeHtml(context.account)}`);
    }
    if (context.operation) {
      parts.push(`<b>عملیات:</b> ${this.escapeHtml(context.operation)}`);
    }
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
      type = 'unknown',
      account = 'unknown',
      mediaPk = 'unknown',
      shortcode = null,
      caption = '',
      mediaUrls = [],
      error = null,
      downloadStage = 'unknown',
      timestamp = new Date().toISOString(),
    } = details;

    const parts = [];

    // Header
    const typeEmoji = type === 'story' ? '📖' : (type === 'reel' ? '🎬' : '📸');
    const stageLabel = downloadStage === 'download' ? 'دانلود' : 'ارسال';
    parts.push(`<b>━━━ ❌ خطا در ${stageLabel} ${typeEmoji} ${this.escapeHtml(type)} ━━━</b>`);
    parts.push('');

    // Source info
    parts.push(`📊 <b>اکانت منبع:</b> @${this.escapeHtml(account)}`);
    parts.push(`🆔 <b>شناسه مدیا:</b> <code>${this.escapeHtml(String(mediaPk))}</code>`);

    if (shortcode) {
      parts.push(`🔗 <b>Shortcode:</b> <code>${this.escapeHtml(shortcode)}</code>`);
      parts.push(`🌐 <b>لینک:</b> <a href="https://instagram.com/p/${this.escapeHtml(shortcode)}">مشاهده در اینستاگرام</a>`);
    }

    // Caption (truncated)
    if (caption) {
      const cap = truncate(caption, 200);
      parts.push(`\n📝 <b>کپشن:</b>\n<i>${this.escapeHtml(cap)}</i>`);
    }

    // Media URLs
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

    // Error info
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

    // Stage
    parts.push(`\n🔧 <b>مرحله:</b> ${downloadStage === 'download' ? '📥 دانلود مدیا' : '📤 ارسال به تلگرام'}`);

    // Timestamp (Iran time)
    const iranTime = this.formatIranTime(Math.floor(new Date(timestamp).getTime() / 1000));
    parts.push(`🕐 <b>زمان:</b> ${this.escapeHtml(iranTime)}`);

    // Footer
    parts.push(`\n<i>🤖 ربات مانیتور اینستاگرام — گزارش خطا</i>`);

    return parts.join('\n');
  }
}

const messageFormatter = new MessageFormatter();
export default messageFormatter;
