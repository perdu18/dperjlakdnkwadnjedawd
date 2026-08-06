/**
 * telegram/MessageFormatter.js
 * قالب پیام‌های ارسالی به کانال تلگرام
 *
 * طراحی: ساده، زیبا، حرفه‌ای
 * - بخش‌بندی با خطوط ━━━
 * - کپشن به صورت expandable blockquote (collapsed)
 * - همیشه در یک پیام
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

  formatCaption(caption, maxLen) {
    if (!caption) return '';
    let text = truncate(caption, maxLen);
    text = this.esc(text);
    text = text.replace(/#([\w\u0600-\u06FF]+)/g, '<a href="https://instagram.com/explore/tags/$1">$&</a>');
    text = text.replace(/@([a-zA-Z0-9._]+)/g, '<a href="https://instagram.com/$1">$&</a>');
    return text;
  }

  /**
   * Format post — قالب زیبا با بخش‌بندی ━━━
   *
   * ساختار:
   *   ━━━ 📸 اینستاگرام | پست ━━━
   *   👤 منبع: ... (@username)
   *   📊 آمار اکانت: ...
   *   📝 کپشن:
   *   [expandable blockquote - متن کپشن]
   *   ━━━ جزئیات پست ━━━
   *   🔗 مشاهده پست | 🕐 زمان | 📍 موقعیت | 📊 آمار
   *   🤖 فوتر
   */
  formatPost(post, accountInfo, options = {}) {
    const maxLen = options.maxLen || 1020;
    const author = post.user || accountInfo;

    // ── Type ──
    let icon = '📸', label = 'پست';
    if (post.type === 'reel') { icon = '🎬'; label = 'ریلز'; }
    else if (post.type === 'video') { icon = '🎥'; label = 'ویدیو'; }
    else if (post.type === 'carousel') { icon = '🖼'; label = 'گالری'; }

    let tag = '';
    if (post.isEdited) tag = ' ✏️';
    if (post.isDeleted) tag = ' 🗑';

    // ── Header ──
    let header = `<b>━━━ ${icon} اینستاگرام | ${label}${tag} ━━━</b>\n`;

    if (author) {
      const uname = this.esc(author.username);
      const name = this.esc(author.fullName || author.username);
      const v = author.isVerified ? ' ✅' : '';
      header += `👤 منبع: <a href="https://instagram.com/${uname}">${name}${v}</a> <code>(@${uname})</code>\n`;

      const s = [];
      const fc = author.followerCount || accountInfo?.followerCount;
      const fgc = author.followingCount || accountInfo?.followingCount;
      const mc = author.mediaCount || accountInfo?.mediaCount;
      if (fc) s.push(`👥 فالوور: ${this.fmtNum(fc)}`);
      if (fgc) s.push(`👤 فالووینگ: ${this.fmtNum(fgc)}`);
      if (mc) s.push(`📸 پست‌ها: ${this.fmtNum(mc)}`);
      if (s.length) header += `📊 آمار اکانت: ${s.join('  |  ')}\n`;
    }

    // ── Footer (جزئیات پست) ──
    let footer = `<b>━━━ جزئیات پست ━━━</b>\n`;

    const fParts = [];
    if (post.shortcode) {
      fParts.push(`🔗 <a href="https://instagram.com/p/${post.shortcode}">مشاهده پست</a>`);
    }
    if (post.takenAt) {
      fParts.push(`🕐 زمان: <code>${this.esc(this.formatIranTime(post.takenAt))}</code> <i>(${this.esc(this.formatRelativeTime(post.takenAt))})</i>`);
    }
    if (post.location?.name) {
      fParts.push(`📍 موقعیت: <code>${this.esc(post.location.name)}</code>`);
    }
    if (post.music?.title) {
      fParts.push(`🎵 ${this.esc(post.music.title)}`);
    }
    if (post.type === 'carousel' && post.carouselItems?.length > 0) {
      fParts.push(`🖼 تصاویر: <code>${post.carouselItems.length}</code>`);
    }

    footer += fParts.join('\n') + '\n';

    // Post stats
    const ps = [];
    if (post.likeCount) ps.push(`❤️ ${this.fmtNum(post.likeCount)}`);
    if (post.commentCount) ps.push(`💬 ${this.fmtNum(post.commentCount)}`);
    if (post.viewCount) ps.push(`👁 ${this.fmtNum(post.viewCount)}`);
    if (ps.length) footer += `📈 آمار: ${ps.join('  •  ')}\n`;

    footer += `\n<i>🤖 ارسال شده توسط ربات مانیتور اینستاگرام</i>`;

    // ── Caption section ──
    // فضای باقی‌مونده برای کپشن
    const headerLen = header.length;
    const footerLen = footer.length;
    const captionLabel = '📝 کپشن:\n';
    const separator = '\n';
    const availableForCaption = maxLen - headerLen - footerLen - captionLabel.length - (separator.length * 3) - 20;

    let captionSection = '';
    if (post.caption && availableForCaption > 50) {
      const captionHtml = this.formatCaption(post.caption, availableForCaption);
      captionSection = captionLabel + captionHtml;
    }

    // ── Assemble ──
    let result = header + separator + captionSection + separator + separator + footer;

    // Final safety
    if (result.length > maxLen) {
      // کپشن رو بیشتر کوتاه کن
      if (post.caption && availableForCaption > 50) {
        const overflow = result.length - maxLen + 10;
        const newCapLen = Math.max(50, availableForCaption - overflow);
        const captionHtml = this.formatCaption(post.caption, newCapLen);
        captionSection = captionLabel + captionHtml;
        result = header + separator + captionSection + separator + separator + footer;
      }
      // آخرین راه: hard truncate
      if (result.length > maxLen) {
        result = result.slice(0, maxLen - 10) + '…';
      }
    }

    return result;
  }

  /**
   * Format story — قالب زیبا
   */
  formatStory(story, accountInfo, options = {}) {
    const maxLen = options.maxLen || 1020;
    const author = accountInfo || story.user;

    let icon = '📖', label = 'استوری';
    if (story.isVideo) { icon = '🎥'; label = 'استوری ویدیویی'; }
    const cf = story.isCloseFriends ? ' ⭐' : '';
    let tag = '';
    if (story.isDeleted) tag = ' 🗑';

    const parts = [`<b>━━━ ${icon} اینستاگرام | ${label}${cf}${tag} ━━━</b>`];

    if (author) {
      const uname = this.esc(author.username);
      const name = this.esc(author.fullName || author.username);
      const v = author.isVerified ? ' ✅' : '';
      parts.push(`👤 منبع: <a href="https://instagram.com/${uname}">${name}${v}</a> <code>(@${uname})</code>`);

      const s = [];
      const fc = author.followerCount;
      const mc = author.mediaCount;
      if (fc) s.push(`👥 فالوور: ${this.fmtNum(fc)}`);
      if (mc) s.push(`📸 پست‌ها: ${this.fmtNum(mc)}`);
      if (s.length) parts.push(`📊 آمار اکانت: ${s.join('  |  ')}`);
    }

    if (story.caption) {
      parts.push('');
      parts.push(`📝 کپشن:`);
      parts.push(this.formatCaption(story.caption, 300));
    }

    parts.push('');
    parts.push(`<b>━━━ جزئیات استوری ━━━</b>`);

    const details = [];
    if (story.mentions?.length > 0) {
      details.push(`👥 منشن‌ها: ${story.mentions.map(m => '@' + this.esc(m)).join(' ')}`);
    }
    if (story.hashtags?.length > 0) {
      details.push(`#️⃣ ${story.hashtags.map(h => '#' + this.esc(h)).join(' ')}`);
    }
    if (story.locations?.length > 0) {
      details.push(`📍 موقعیت: <code>${story.locations.map(l => this.esc(l)).join(', ')}</code>`);
    }
    if (story.takenAt) {
      details.push(`🕐 زمان: <code>${this.esc(this.formatIranTime(story.takenAt))}</code> <i>(${this.esc(this.formatRelativeTime(story.takenAt))})</i>`);
    }
    if (story.expiringAt) {
      details.push(`⏰ انقضا: <code>${this.esc(this.formatIranTime(story.expiringAt))}</code>`);
    }
    if (details.length) parts.push(details.join('\n'));

    parts.push('');
    parts.push(`<i>🤖 ارسال شده توسط ربات مانیتور اینستاگرام</i>`);

    let result = parts.join('\n');
    if (result.length > maxLen) {
      result = result.slice(0, maxLen - 10) + '…';
    }
    return result;
  }

  formatHighlight(highlight, accountInfo) {
    const parts = [`<b>━━━ ⭐ هایلایت${highlight.isNew ? ' ✨ [جدید]' : ' 🗑 [حذف شده]'} ━━━</b>`];
    if (accountInfo) {
      const uname = this.esc(accountInfo.username);
      const name = this.esc(accountInfo.fullName || accountInfo.username);
      parts.push(`👤 منبع: <a href="https://instagram.com/${uname}">${name}</a> <code>(@${uname})</code>`);
    }
    parts.push(`📌 عنوان: <b>${this.esc(highlight.title || 'بدون عنوان')}</b>`);
    if (highlight.itemCount) parts.push(`🎬 تعداد: <code>${highlight.itemCount}</code>`);
    if (highlight.takenAt) parts.push(`🕐 زمان: <code>${this.esc(this.formatIranTime(highlight.takenAt))}</code>`);
    parts.push('');
    parts.push(`<i>🤖 ارسال شده توسط ربات مانیتور اینستاگرام</i>`);
    return parts.join('\n');
  }

  formatBanAlert(username, reason) {
    return `<b>━━━ 🚫 اکانت مسدود شد ━━━</b>\n\n👤 اکانت: <code>@${this.esc(username)}</code>\n📋 دلیل: <code>${this.esc(reason || 'نامشخص')}</code>\n🕐 زمان: <code>${this.esc(this.formatIranTime(Math.floor(Date.now() / 1000)))}</code>\n\n<i>🤖 ربات مانیتور اینستاگرام</i>`;
  }

  formatDailyStats(stats) {
    const today = this.formatIranTime(Math.floor(Date.now() / 1000));
    return `<b>━━━ 📊 آمار امروز ━━━</b>\n\n📅 تاریخ: <code>${this.esc(today)}</code>\n✅ ارسال شده: <b>${this.fmtNum(stats.sent || 0)}</b>\n📸 پست‌ها: ${this.fmtNum(stats.posts || 0)}\n📖 استوری‌ها: ${this.fmtNum(stats.stories || 0)}\n🎬 ریلزها: ${this.fmtNum(stats.reels || 0)}\n❌ ناموفق: ${this.fmtNum(stats.failed || 0)}\n\n<i>🤖 ربات مانیتور اینستاگرام</i>`;
  }

  formatAlert(title, details) {
    return `<b>━━━ 🚨 هشدار ━━━</b>\n\n<b>${this.esc(title)}</b>\n\n<code>${this.esc(details)}</code>`;
  }

  formatError(error, context = {}) {
    const parts = [`<b>━━━ ❌ خطا ━━━</b>`, ''];
    parts.push(`<b>پیام:</b> <code>${this.esc(error.message || String(error))}</code>`);
    if (context.module) parts.push(`<b>ماژول:</b> ${this.esc(context.module)}`);
    if (context.account) parts.push(`<b>اکانت:</b> @${this.esc(context.account)}`);
    return parts.join('\n');
  }

  formatFailureReport(details) {
    const { type, account, mediaPk, shortcode, error, downloadStage } = details;
    const typeEmoji = type === 'story' ? '📖' : (type === 'reel' ? '🎬' : '📸');
    const stageLabel = downloadStage === 'download' ? 'دانلود' : 'ارسال';
    const parts = [
      `<b>━━━ ❌ خطا در ${stageLabel} ${typeEmoji} ━━━</b>`,
      '',
      `📊 اکانت منبع: @${this.esc(account)}`,
      `🆔 شناسه مدیا: <code>${this.esc(String(mediaPk))}</code>`,
    ];
    if (shortcode) {
      parts.push(`🔗 Shortcode: <code>${this.esc(shortcode)}</code>`);
      parts.push(`🌐 <a href="https://instagram.com/p/${this.esc(shortcode)}">مشاهده در اینستاگرام</a>`);
    }
    if (error) {
      parts.push(`\n❌ <b>خطا:</b>`);
      parts.push(`<code>${this.esc(truncate(error.message || String(error), 500))}</code>`);
    }
    parts.push(`\n🔧 مرحله: ${downloadStage === 'download' ? '📥 دانلود مدیا' : '📤 ارسال به تلگرام'}`);
    parts.push('');
    parts.push(`<i>🤖 ربات مانیتور اینستاگرام</i>`);
    return parts.join('\n');
  }

  formatBackupNotification(info) {
    return `<b>━━━ 💾 بکاپ روزانه ━━━</b>\n\n📅 تاریخ: <code>${this.esc(this.formatIranTime(Math.floor(Date.now() / 1000)))}</code>\n📦 دیتابیس: <code>${info.dbSize || 'نامشخص'}</code>\n🍪 سشن IG: <code>${info.igSessionSize || 'نامشخص'}</code>\n📊 آمار: <code>${info.totalItems || 0} آیتم</code>\n\n<i>🤖 ربات مانیتور اینستاگرام</i>`;
  }
}

const messageFormatter = new MessageFormatter();
export default messageFormatter;
