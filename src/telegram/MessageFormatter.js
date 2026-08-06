/**
 * telegram/MessageFormatter.js
 * تبدیل محتوای اینستاگرام به پیام تلگرام (HTML format)
 *
 * استفاده از تمام قابلیت‌های HTML تلگرام طبق core.telegram.org:
 *   - <blockquote> برای بخش‌بندی
 *   - <code> برای مقادیر
 *   - <b>, <i> برای تأکید
 *   - <a> برای لینک‌ها
 *
 * تمام زمان‌ها به وقت ایران (Asia/Tehran).
 */

import { truncate } from '../utils/Helpers.js';

const TEHRAN_TIMEZONE = 'Asia/Tehran';

class MessageFormatter {
  formatIranTime(timestamp, opts = {}) {
    if (!timestamp) return null;
    try {
      const date = new Date(timestamp * 1000);
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: TEHRAN_TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
        ...opts,
      }).format(date);
    } catch { return null; }
  }

  formatRelativeTime(timestamp) {
    if (!timestamp) return null;
    const diff = Date.now() - (timestamp * 1000);
    const m = Math.floor(diff / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (diff < 60000) return 'همین الان';
    if (m < 60) return `${m} دقیقه پیش`;
    if (h < 24) return `${h} ساعت پیش`;
    if (d < 7) return `${d} روز پیش`;
    return this.formatIranTime(timestamp, { dateStyle: 'short' });
  }

  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  formatCaption(caption, options = {}) {
    if (!caption) return '';
    const { maxLength = 1000 } = options;
    let text = truncate(caption, maxLength);
    text = this.escapeHtml(text);
    text = text.replace(/#([\w\u0600-\u06FF]+)/g, '<a href="https://instagram.com/explore/tags/$1">$&</a>');
    text = text.replace(/@([a-zA-Z0-9._]+)/g, '<a href="https://instagram.com/$1">$&</a>');
    return text;
  }

  formatNumber(num) {
    if (!num) return '0';
    return num.toLocaleString('en-US');
  }

  /**
   * Format post message — professional design with Telegram HTML features
   */
  formatPost(post, accountInfo) {
    const parts = [];
    const author = post.user || accountInfo;

    // ── Header ──
    let icon = '📸', label = 'پست';
    if (post.type === 'reel') { icon = '🎬'; label = 'ریلز'; }
    else if (post.type === 'video') { icon = '🎥'; label = 'ویدیو'; }
    else if (post.type === 'carousel') { icon = '🖼'; label = 'گالری'; }

    // Edit/Delete tags
    let tag = '';
    if (post.isEdited) tag = ' <i>✏️ [ویرایش شده]</i>';
    if (post.isDeleted) tag = ' <i>🗑 [حذف شده]</i>';

    parts.push(`<b>${icon} اینستاگرام | ${label}${tag}</b>`);

    // ── Author block ──
    if (author) {
      const name = this.escapeHtml(author.fullName || author.username);
      const uname = this.escapeHtml(author.username);
      const vBadge = author.isVerified ? ' ✓' : '';
      parts.push(`<blockquote>👤 <a href="https://instagram.com/${uname}">${name}${vBadge}</a> <code>@${uname}</code>`);

      const stats = [];
      if (author.followerCount || accountInfo?.followerCount)
        stats.push(`👥 ${this.formatNumber(author.followerCount || accountInfo?.followerCount)}`);
      if (author.followingCount || accountInfo?.followingCount)
        stats.push(`➡️ ${this.formatNumber(author.followingCount || accountInfo?.followingCount)}`);
      if (author.mediaCount || accountInfo?.mediaCount)
        stats.push(`📸 ${this.formatNumber(author.mediaCount || accountInfo?.mediaCount)}`);
      if (stats.length) parts.push(`<code>${stats.join(' │ ')}</code>`);
      parts.push('</blockquote>');
    }

    // ── Caption ──
    if (post.caption) {
      parts.push('');
      parts.push(this.formatCaption(post.caption, { maxLength: 800 }));
    }

    // ── Details block ──
    parts.push('');
    parts.push('<blockquote>');

    if (post.shortcode) {
      parts.push(`🔗 <a href="https://instagram.com/p/${post.shortcode}">مشاهده در اینستاگرام</a>`);
    }

    if (post.takenAt) {
      parts.push(`🕐 <code>${this.escapeHtml(this.formatIranTime(post.takenAt))}</code> <i>(${this.escapeHtml(this.formatRelativeTime(post.takenAt))})</i>`);
    }

    if (post.type === 'carousel' && post.carouselItems?.length > 0) {
      parts.push(`🖼 تصاویر: <code>${post.carouselItems.length}</code>`);
    }
    if (post.isVideo) {
      parts.push(`🎥 نوع: <code>${post.isReel ? 'ریلز' : 'ویدیو'}</code>`);
    }
    if (post.location?.name) {
      parts.push(`📍 <code>${this.escapeHtml(post.location.name)}</code>`);
    }
    if (post.music?.title) {
      parts.push(`🎵 ${this.escapeHtml(post.music.title)}`);
    }
    if (post.usertags?.length > 0) {
      parts.push(`👥 ${post.usertags.slice(0, 10).map(u => '@' + this.escapeHtml(u)).join(' ')}`);
    }

    // Stats
    const sp = [];
    if (post.likeCount) sp.push(`❤️ ${this.formatNumber(post.likeCount)}`);
    if (post.commentCount) sp.push(`💬 ${this.formatNumber(post.commentCount)}`);
    if (post.viewCount) sp.push(`👁 ${this.formatNumber(post.viewCount)}`);
    if (sp.length) parts.push(`📊 <code>${sp.join(' │ ')}</code>`);

    parts.push('</blockquote>');
    parts.push('');
    parts.push(`<i>🤖 IG Monitor Bot</i>`);

    return parts.join('\n');
  }

  /**
   * Format story message
   */
  formatStory(story, accountInfo) {
    const parts = [];
    const author = accountInfo || story.user;
    let icon = '📖', label = 'استوری';
    if (story.isVideo) { icon = '🎥'; label = 'استوری ویدیویی'; }

    const cf = story.isCloseFriends ? ' ⭐' : '';
    let tag = '';
    if (story.isDeleted) tag = ' <i>🗑 [حذف شده]</i>';

    parts.push(`<b>${icon} اینستاگرام | ${label}${cf}${tag}</b>`);

    if (author) {
      const name = this.escapeHtml(author.fullName || author.username);
      const uname = this.escapeHtml(author.username);
      const vBadge = author.isVerified ? ' ✓' : '';
      parts.push(`<blockquote>👤 <a href="https://instagram.com/${uname}">${name}${vBadge}</a> <code>@${uname}</code>`);

      const stats = [];
      if (author.followerCount) stats.push(`👥 ${this.formatNumber(author.followerCount)}`);
      if (author.mediaCount) stats.push(`📸 ${this.formatNumber(author.mediaCount)}`);
      if (stats.length) parts.push(`<code>${stats.join(' │ ')}</code>`);
      parts.push('</blockquote>');
    }

    if (story.caption) {
      parts.push('');
      parts.push(this.formatCaption(story.caption, { maxLength: 400 }));
    }

    parts.push('');
    parts.push('<blockquote>');
    if (story.mentions?.length > 0) {
      parts.push(`👥 ${story.mentions.map(m => '@' + this.escapeHtml(m)).join(' ')}`);
    }
    if (story.hashtags?.length > 0) {
      parts.push(`#️⃣ ${story.hashtags.map(h => '#' + this.escapeHtml(h)).join(' ')}`);
    }
    if (story.locations?.length > 0) {
      parts.push(`📍 <code>${story.locations.map(l => this.escapeHtml(l)).join(', ')}</code>`);
    }
    if (story.takenAt) {
      parts.push(`🕐 <code>${this.escapeHtml(this.formatIranTime(story.takenAt))}</code> <i>(${this.escapeHtml(this.formatRelativeTime(story.takenAt))})</i>`);
    }
    if (story.expiringAt) {
      parts.push(`⏰ انقضا: <code>${this.escapeHtml(this.formatIranTime(story.expiringAt))}</code>`);
    }
    parts.push('</blockquote>');

    parts.push('');
    parts.push(`<i>🤖 IG Monitor Bot</i>`);

    return parts.join('\n');
  }

  /**
   * Format highlight message (new!)
   */
  formatHighlight(highlight, accountInfo) {
    const parts = [];
    const author = accountInfo;

    parts.push(`<b>⭐ اینستاگرام | هایلایت${highlight.isNew ? ' ✨ [جدید]' : ' 🗑 [حذف شده]'}</b>`);

    if (author) {
      const uname = this.escapeHtml(author.username);
      const name = this.escapeHtml(author.fullName || author.username);
      parts.push(`<blockquote>👤 <a href="https://instagram.com/${uname}">${name}</a> <code>@${uname}</code>`);
      parts.push('</blockquote>');
    }

    parts.push('');
    parts.push('<blockquote>');
    parts.push(`📌 عنوان: <b>${this.escapeHtml(highlight.title || 'بدون عنوان')}</b>`);
    if (highlight.itemCount) {
      parts.push(`🎬 تعداد: <code>${highlight.itemCount}</code>`);
    }
    if (highlight.takenAt) {
      parts.push(`🕐 <code>${this.escapeHtml(this.formatIranTime(highlight.takenAt))}</code>`);
    }
    parts.push('</blockquote>');

    parts.push('');
    parts.push(`<i>🤖 IG Monitor Bot</i>`);

    return parts.join('\n');
  }

  /**
   * Format ban alert
   */
  formatBanAlert(username, reason) {
    return `<b>🚫 اکانت اینستاگرام مسدود شد</b>

<blockquote>
👤 اکانت: <code>@${this.escapeHtml(username)}</code>
📋 دلیل: <code>${this.escapeHtml(reason || 'نامشخص')}</code>
⏰ زمان: <code>${this.escapeHtml(this.formatIranTime(Math.floor(Date.now() / 1000)))}</code>
</blockquote>

<b>اقدامات لازم:</b>
• بررسی وضعیت اکانت در instagram.com
• اگه اکانت ربات شما بن شده، session جدید بسازید
• اگه اکانت هدف بن شده، اون رو از لیست حذف کنید

<i>🤖 IG Monitor Bot</i>`;
  }

  /**
   * Format daily stats
   */
  formatDailyStats(stats) {
    const today = this.formatIranTime(Math.floor(Date.now() / 1000), { dateStyle: 'full' });
    return `<b>📊 آمار امروز</b>

<blockquote>
📅 <code>${this.escapeHtml(today)}</code>
✅ ارسال شده: <b>${this.formatNumber(stats.sent || 0)}</b>
📸 پست‌ها: <code>${this.formatNumber(stats.posts || 0)}</code>
📖 استوری‌ها: <code>${this.formatNumber(stats.stories || 0)}</code>
🎬 ریلزها: <code>${this.formatNumber(stats.reels || 0)}</code>
⭐ هایلایت‌ها: <code>${this.formatNumber(stats.highlights || 0)}</code>
❌ ناموفق: <code>${this.formatNumber(stats.failed || 0)}</code>
⏭ نادیده: <code>${this.formatNumber(stats.skipped || 0)}</code>
</blockquote>

<i>🤖 IG Monitor Bot</i>`;
  }

  formatAlert(title, details) {
    return `🚨 <b>${this.escapeHtml(title)}</b>\n\n<blockquote><code>${this.escapeHtml(details)}</code></blockquote>`;
  }

  formatError(error, context = {}) {
    const parts = [`❌ <b>خطا</b>`, ''];
    parts.push(`<blockquote>`);
    parts.push(`📋 <code>${this.escapeHtml(error.message || String(error))}</code>`);
    if (context.module) parts.push(`ماژول: <code>${this.escapeHtml(context.module)}</code>`);
    if (context.account) parts.push(`اکانت: <code>@${this.escapeHtml(context.account)}</code>`);
    parts.push(`</blockquote>`);
    return parts.join('\n');
  }

  formatFailureReport(details) {
    const { type, account, mediaPk, shortcode, caption, mediaUrls, error, downloadStage, timestamp } = details;
    const typeEmoji = type === 'story' ? '📖' : (type === 'reel' ? '🎬' : '📸');
    const stageLabel = downloadStage === 'download' ? 'دانلود' : 'ارسال';
    const parts = [
      `<b>❌ خطا در ${stageLabel} ${typeEmoji}</b>`,
      '',
      '<blockquote>',
      `📊 اکانت: <code>@${this.escapeHtml(account)}</code>`,
      `🆔 مدیا: <code>${this.escapeHtml(String(mediaPk))}</code>`,
    ];
    if (shortcode) parts.push(`🔗 <a href="https://instagram.com/p/${this.escapeHtml(shortcode)}">مشاهده</a>`);
    if (caption) parts.push(`\n📝 ${this.escapeHtml(truncate(caption, 150))}`);
    if (error) {
      parts.push(`\n❌ <code>${this.escapeHtml(truncate(error.message || String(error), 500))}</code>`);
    }
    parts.push('</blockquote>');
    parts.push(`<i>🤖 IG Monitor Bot</i>`);
    return parts.join('\n');
  }

  /**
   * Format backup notification
   */
  formatBackupNotification(backupInfo) {
    return `<b>💾 بکاپ روزانه</b>

<blockquote>
📅 تاریخ: <code>${this.escapeHtml(this.formatIranTime(Math.floor(Date.now() / 1000)))}</code>
📦 دیتابیس: <code>${backupInfo.dbSize || 'نامشخص'}</code>
🍪 سشن IG: <code>${backupInfo.igSessionSize || 'نامشخص'}</code>
📱 سشن TG: <code>${backupInfo.tgSessionSize || 'نامشخص'}</code>
📊 آمار: <code>${backupInfo.totalItems || 0} آیتم</code>
</blockquote>

<i>🤖 IG Monitor Bot</i>`;
  }
}

const messageFormatter = new MessageFormatter();
export default messageFormatter;
