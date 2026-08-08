/**
 * telegram/HtmlEntities.js
 *
 * تبدیل HTML محدودِ سازگار با Bot API به «متن ساده + MessageEntity های MTProto»
 * طبق core.telegram.org/api/entities
 *
 * چرا لازم است؟
 *  - parser HTML در teleproto/GramJS فقط b,i,u,s,code,pre,a را می‌شناسد؛
 *    <blockquote expandable> (فرمت Bot API) یا خام چاپ می‌شود یا حذف می‌گردد.
 *    معادل رسمی MTProto آن MessageEntityBlockquote با فلگ collapsed است.
 *  - همه‌ی offset/length ها باید UTF-16 code unit باشند؛ str.length در JS
 *    دقیقاً همین است، پس هیچ‌جا از Array.from/codePointAt استفاده نمی‌کنیم.
 */

import { Api } from 'teleproto';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
};

const SUPPORTED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'code', 'pre', 'a', 'blockquote', 'span', 'tg-spoiler',
]);

/** decode کردن HTML entity ها (بعد از حذف تگ‌ها) */
function decodeHtml(str) {
  return String(str).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, code) => {
    if (NAMED_ENTITIES[code] !== undefined) return NAMED_ENTITIES[code];
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const num = isHex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (Number.isFinite(num) && num > 0 && num <= 0x10ffff) {
        try { return String.fromCodePoint(num); } catch { return raw; }
      }
    }
    return raw;
  });
}

function getAttribute(attrs, name) {
  if (!attrs) return null;
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = attrs.match(re);
  if (!m) return null;
  return decodeHtml(m[1] ?? m[2] ?? m[3] ?? '');
}

function hasFlag(attrs, name) {
  if (!attrs) return false;
  return new RegExp(`(^|\\s)${name}(\\s|=|$)`, 'i').test(attrs);
}

/** توصیف‌گر میانی (قبل از تبدیل به Api) تا بشود امن برش زد */
function describe(tag, attrs, offset, length) {
  switch (tag) {
    case 'b': case 'strong': return { type: 'bold', offset, length };
    case 'i': case 'em': return { type: 'italic', offset, length };
    case 'u': case 'ins': return { type: 'underline', offset, length };
    case 's': case 'strike': case 'del': return { type: 'strike', offset, length };
    case 'code': return { type: 'code', offset, length };
    case 'pre': return { type: 'pre', offset, length, language: getAttribute(attrs, 'language') || '' };
    case 'a': {
      const url = getAttribute(attrs, 'href');
      return url ? { type: 'textUrl', offset, length, url } : null;
    }
    case 'blockquote':
      // expandable در Bot API == collapsed در MTProto
      return { type: 'blockquote', offset, length, collapsed: hasFlag(attrs, 'expandable') };
    case 'tg-spoiler': return { type: 'spoiler', offset, length };
    case 'span': {
      const cls = (getAttribute(attrs, 'class') || '').toLowerCase();
      return cls.includes('tg-spoiler') ? { type: 'spoiler', offset, length } : null;
    }
    default: return null;
  }
}

function toApiEntity(d) {
  switch (d.type) {
    case 'bold': return new Api.MessageEntityBold({ offset: d.offset, length: d.length });
    case 'italic': return new Api.MessageEntityItalic({ offset: d.offset, length: d.length });
    case 'underline': return new Api.MessageEntityUnderline({ offset: d.offset, length: d.length });
    case 'strike': return new Api.MessageEntityStrike({ offset: d.offset, length: d.length });
    case 'code': return new Api.MessageEntityCode({ offset: d.offset, length: d.length });
    case 'pre': return new Api.MessageEntityPre({ offset: d.offset, length: d.length, language: d.language || '' });
    case 'spoiler': return new Api.MessageEntitySpoiler({ offset: d.offset, length: d.length });
    case 'textUrl': return new Api.MessageEntityTextUrl({ offset: d.offset, length: d.length, url: d.url });
    case 'blockquote':
      return new Api.MessageEntityBlockquote({
        offset: d.offset,
        length: d.length,
        collapsed: !!d.collapsed,
      });
    default: return null;
  }
}

/** HTML -> { text, descriptors } */
function parseHtml(html) {
  const source = String(html ?? '');
  const tagRe = /<(\/?)([a-zA-Z0-9-]+)((?:"[^"]*"|'[^']*'|[^>])*?)\/?>/g;
  const stack = [];
  const descriptors = [];
  let text = '';
  let lastIndex = 0;
  let match;

  while ((match = tagRe.exec(source)) !== null) {
    text += decodeHtml(source.slice(lastIndex, match.index));
    lastIndex = tagRe.lastIndex;

    const isClosing = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attrs = match[3] || '';

    if (tag === 'br') { text += '\n'; continue; }
    if (!SUPPORTED_TAGS.has(tag)) continue;

    if (isClosing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        const open = stack.splice(i, 1)[0];
        const length = text.length - open.offset;
        if (length > 0) {
          const d = describe(open.tag, open.attrs, open.offset, length);
          if (d) descriptors.push(d);
        }
        break;
      }
      continue;
    }

    stack.push({ tag, attrs, offset: text.length });
  }

  text += decodeHtml(source.slice(lastIndex));

  // تگ‌های بسته‌نشده (مثلاً وقتی متن روی مرز خط تکه شده) را تا انتها می‌بندیم
  for (const open of stack) {
    const length = text.length - open.offset;
    if (length > 0) {
      const d = describe(open.tag, open.attrs, open.offset, length);
      if (d) descriptors.push(d);
    }
  }

  descriptors.sort((a, b) => a.offset - b.offset || a.length - b.length);
  return { text, descriptors };
}

/**
 * برش امن روی مرز UTF-16 (نصف کردن surrogate pair ممنوع است، وگرنه
 * همه‌ی offset های بعدی و کل entity ها جابه‌جا می‌شوند)
 */
function clamp(text, descriptors, maxLength) {
  if (!Number.isFinite(maxLength) || text.length <= maxLength) {
    return { text, descriptors, truncated: false };
  }

  let cut = Math.max(0, maxLength - 1); // یک جا برای «…»
  const prev = text.charCodeAt(cut - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;

  const clipped = text.slice(0, cut) + '…';
  const kept = [];
  for (const d of descriptors) {
    if (d.offset >= cut) continue;
    const length = Math.min(d.length, cut - d.offset);
    if (length <= 0) continue;
    kept.push({ ...d, length });
  }
  return { text: clipped, descriptors: kept, truncated: true };
}

/**
 * تبدیل نهایی: HTML -> { text, entities, truncated }
 * @param {string} html
 * @param {{ maxLength?: number }} options  محدودیت UTF-16 (کپشن 1024، پیام 4096)
 */
export function htmlToMessage(html, options = {}) {
  const { maxLength = Infinity } = options;
  const parsed = parseHtml(html);
  const clamped = clamp(parsed.text, parsed.descriptors, maxLength);
  const entities = clamped.descriptors.map(toApiEntity).filter(Boolean);
  return { text: clamped.text, entities, truncated: clamped.truncated };
}

/** طول واقعی رندرشده (UTF-16) برای لاگ/تصمیم‌گیری */
export function renderedLength(html) {
  return parseHtml(html).text.length;
}

export default { htmlToMessage, renderedLength };