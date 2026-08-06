/**
 * telegram/MessageFormatter.js
 * قالب پیام‌های ارسالی به کانال تلگرام
 *
 * طراحی: ساده، زیبا، حرفه‌ای، همیشه در یک پیام
 * محدودیت caption فایل: 1024 کاراکتر
 *
 * استراتژی:
 *   - header (عنوان + منبع): ~100 کاراکتر
 *   - کپشن پست: انعطاف‌پذیر (هرچه جا بشه)
 *   - footer (لینک + زمان + آمار + bot): ~200 کاراکتر
 *   - اگه کل بیشتر از maxLen بشه، کپشن کوتاه میشه
 */

import { truncate } from '../utils/Helpers.js';

const TEHRAN_TIMEZONE = 'Asia/Tehran';

class MessageFormatter {
  formatIranTime(ts) {
    if (!ts) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: TEHRAN_TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(ts * 1000));
    } catch { return ''; }
  }

  formatRelativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - (ts * 1000);
    const m = Math.floor(diff / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (diff < 60000) return 'همین الان';
    if (m < 60) return `${m} دقیقه پیش`;
    if (h < 24) return `${h} ساعت پیش`;
    if (d < 7) return `${d} روز پیش`;
    return this.formatIranTime(ts);
  }

  esc(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  fmtNum(n) { return (n || 0).toLocaleString('en-US'); }

  /**
   * Format caption with HTML linkify
   */
  formatCaption(caption, maxLen) {
    if (!caption) return '';
    let text = truncate(caption, maxLen);
    text = this.esc(text);
    text = text.replace(/#([\w\u0600-\u06FF]+)/g, '<a href="https://instagram.com/explore/tags/$1">$&</a>');
    text = text.replace(/@([a-zA-Z0-9._]+)/g, '<a href="https://instagram.com/$1">$&</a>');
    return text;
  }

  /**
   * Format post — زیبا و فشرده
   *
   * ساختار:
   *   📸 عنوان
   *   👤 منبع | 👥 فالوور | 📸 پست
   *   ───
   *   📝 کپشن (انعطاف‌پذیر)
   *   ───
   *   🔗 لینک | 🕐 زمان | 📍 موقعیت | 📊 آمار
   *   🤖 فوتر
   */
  formatPost(post, accountInfo, options = {}) {
    const maxLen = options.maxLen || 1020;
    const author = post.user || accountInfo;

    // ── Determine type ──
    let icon = '📸', label = 'پست';
    if (post.type === 'reel') { icon = '🎬'; label = 'ریلز'; }
    else if (post.type === 'video') { icon = '🎥'; label = 'ویدیو'; }
    else if (post.type === 'carousel') { icon = '🖼'; label = 'گالری'; }

    let tag = '';
    if (post.isEdited) tag = ' ✏️';
    if (post.isDeleted) tag = ' 🗑';

    // ── Build header (fixed, ~100 chars) ──
    let header = `<b>${icon} ${label}${tag}</b>`;

    if (author) {
      const uname = this.esc(author.username);
      const name = this.esc(author.fullName || author.username);
      const v = author.isVerified ? ' ✓' : '';
      header += `\n👤 <a href="https://instagram.com/${uname}">${name}${v}</a>`;

      const s = [];
      const fc = author.followerCount || accountInfo?.followerCount;
      const mc = author.mediaCount || accountInfo?.mediaCount;
      if (fc) s.push(`👥${this.fmtNum(fc)}`);
      if (mc) s.push(`📸${this.fmtNum(mc)}`);
      if (s.length) header += ` │ <code>${s.join(' │ ')}</code>`;
    }

    // ── Build footer (fixed, ~250 chars) ──
    const footerParts = [];

    if (post.shortcode) {
      footerParts.push(`🔗 <a href="https://instagram.com/p/${post.shortcode}">لینک</a>`);
    }
    if (post.takenAt) {
      footerParts.push(`🕐 ${this.esc(this.formatIranTime(post.takenAt))} (${this.esc(this.formatRelativeTime(post.takenAt))})`);
    }
    if (post.location?.name) {
      footerParts.push(`📍 ${this.esc(post.location.name)}`);
    }
    if (post.music?.title) {
      footerParts.push(`🎵 ${this.esc(post.music.title)}`);
    }
    if (post.type === 'carousel' && post.carouselItems?.length > 0) {
      footerParts.push(`🖼 ${post.carouselItems.length} تصویر`);
    }

    // Post stats
    const ps = [];
    if (post.likeCount) ps.push(`❤️${this.fmtNum(post.likeCount)}`);
    if (post.commentCount) ps.push(`💬${this.fmtNum(post.commentCount)}`);
    if (post.viewCount) ps.push(`👁${this.fmtNum(post.viewCount)}`);
    if (ps.length) footerParts.push(ps.join(' '));

    const footer = `\n${footerParts.join(' │ ')}\n\n<i>🤖 IG Monitor Bot</i>`;

    // ── Calculate available space for caption ──
    const headerLen = header.length;
    const footerLen = footer.length;
    const separator = '\n\n';
    const availableForCaption = maxLen - headerLen - footerLen - (separator.length * 2) - 20;

    // ── Build caption ──
    let captionHtml = '';
    if (post.caption && availableForCaption > 50) {
      captionHtml = this.formatCaption(post.caption, availableForCaption);
    }

    // ── Assemble ──
    const result = header + separator + captionHtml + separator + footer;

    // Final safety check
    if (result.length > maxLen) {
      // Truncate caption more aggressively
      const overflow = result.length - maxLen + 10;
      if (captionHtml.length > overflow) {
        const truncatedCaption = captionHtml.slice(0, captionHtml.length - overflow) + '…';
        return header + separator + truncatedCaption + separator + footer;
      }
      // Last resort: hard truncate
      return result.slice(0, maxLen - 10) + '…';
    }

    return result;
  }

  /**
   * Format story — زیبا و فشرده
   */
  formatStory(story, accountInfo, options = {}) {
    const maxLen = options.maxLen || 1020;
    const author = accountInfo || story.user;

    let icon = '📖', label = 'استوری';
    if (story.isVideo) { icon = '🎥'; label = 'استوری ویدیویی'; }
    const cf = story.isCloseFriends ? ' ⭐' : '';
    let tag = '';
    if (story.isDeleted) tag = ' 🗑';

    const parts = [`<b>${icon} ${label}${cf}${tag}</b>`];

    if (author) {
      const uname = this.esc(author.username);
      const name = this.esc(author.fullName || author.username);
      let line = `👤 <a href="https://instagram.com/${uname}">${name}</a>`;
      const mc = author.mediaCount;
      if (mc) line += ` │ <code>📸${this.fmtNum(mc)}</code>`;
      parts.push(line);
    }

    if (story.caption) {
      parts.push('');
      parts.push(this.formatCaption(story.caption, 300));
    }

    const details = [];
    if (story.mentions?.length > 0) {
      details.push(`👥 ${story.mentions.map(m => '@' + this.esc(m)).join(' ')}`);
    }
    if (story.takenAt) {
      details.push(`🕐 ${this.esc(this.formatIranTime(story.takenAt))} (${this.esc(this.formatRelativeTime(story.takenAt))})`);
    }
    if (details.length) {
      parts.push('');
      parts.push(details.join(' │ '));
    }

    parts.push('');
    parts.push(`<i>🤖 IG Monitor Bot</i>`);

    let result = parts.join('\n');
    if (result.length > maxLen) {
      result = result.slice(0, maxLen - 10) + '…';
    }
    return result;
  }

  formatHighlight(highlight, accountInfo) {
    const parts = [`<b>⭐ هایلایت${highlight.isNew ? ' ✨' : ' 🗑'}</b>`];
    if (accountInfo) {
      parts.push(`👤 <a href="https://instagram.com/${this.esc(accountInfo.username)}">${this.esc(accountInfo.fullName || accountInfo.username)}</a>`);
    }
    parts.push(`📌 ${this.esc(highlight.title || 'بدون عنوان')}`);
    if (highlight.itemCount) parts.push(`🎬 ${highlight.itemCount} مورد`);
    if (highlight.takenAt) parts.push(`🕐 ${this.esc(this.formatIranTime(highlight.takenAt))}`);
    parts.push('');
    parts.push(`<i>🤖 IG Monitor Bot</i>`);
    return parts.join('\n');
  }

  formatBanAlert(username, reason) {
    return `<b>🚫 بن شد</b>\n\n👤 <code>@${this.esc(username)}</code>\n📋 ${this.esc(reason || 'نامشخص')}\n🕐 ${this.esc(this.formatIranTime(Math.floor(Date.now() / 1000)))}\n\n<i>🤖 IG Monitor Bot</i>`;
  }

  formatDailyStats(stats) {
    const today = this.formatIranTime(Math.floor(Date.now() / 1000));
    return `<b>📊 آمار امروز</b>\n\n📅 <code>${this.esc(today)}</code>\n✅ ارسال: <b>${this.fmtNum(stats.sent || 0)}</b>\n📸 پست: ${this.fmtNum(stats.posts || 0)} │ 📖 استوری: ${this.fmtNum(stats.stories || 0)} │ 🎬 ریلز: ${this.fmtNum(stats.reels || 0)}\n❌ ناموفق: ${this.fmtNum(stats.failed || 0)}\n\n<i>🤖 IG Monitor Bot</i>`;
  }

  formatAlert(title, details) {
    return `🚨 <b>${this.esc(title)}</b>\n\n<code>${this.esc(details)}</code>`;
  }

  formatError(error, context = {}) {
    const parts = [`❌ <b>خطا</b>`, ''];
    parts.push(`<code>${this.esc(error.message || String(error))}</code>`);
    if (context.account) parts.push(`👤 @${this.esc(context.account)}`);
    return parts.join('\n');
  }

  formatFailureReport(details) {
    const { type, account, mediaPk, shortcode, error, downloadStage } = details;
    const stageLabel = downloadStage === 'download' ? 'دانلود' : 'ارسال';
    const parts = [
      `<b>❌ خطا در ${stageLabel}</b>`,
      '',
      `👤 <code>@${this.esc(account)}</code>`,
      `🆔 <code>${this.esc(String(mediaPk))}</code>`,
    ];
    if (shortcode) parts.push(`🔗 <a href="https://instagram.com/p/${this.esc(shortcode)}">لینک</a>`);
    if (error) parts.push(`\n<code>${this.esc(truncate(error.message || String(error), 400))}</code>`);
    parts.push('');
    parts.push(`<i>🤖 IG Monitor Bot</i>`);
    return parts.join('\n');
  }

  formatBackupNotification(info) {
    return `<b>💾 بکاپ روزانه</b>\n\n📅 <code>${this.esc(this.formatIranTime(Math.floor(Date.now() / 1000)))}</code>\n📦 DB: <code>${info.dbSize || '?'}</code>\n📊 <code>${info.totalItems || 0} آیتم</code>\n\n<i>🤖 IG Monitor Bot</i>`;
  }
}

const messageFormatter = new MessageFormatter();
export default messageFormatter;
