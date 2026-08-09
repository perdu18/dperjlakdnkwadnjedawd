# 🔍 راهنمای عیب‌یابی — چرا پست‌ها تشخیص داده نمی‌شوند؟

تاریخ: 2026-08-09
نسخه: v2.3 (با اصلاحات بحرانی)

---

## 🎯 خلاصه مشکل و راه‌حل

### مشکل اصلی که پیدا شد:

**اینستاگرام endpoint `web_profile_info` را برای سشن شما محدود کرده (۴۲۹)، ولی endpoint `/feed/user/{pk}/` هنوز کار می‌کند!**

کد قبلی (v2.2) ابتدا `web_profile_info` را صدا می‌زد. وقتی ۴۲۹ می‌گرفت، **کل عملیات fetch feed شکست می‌خورد** — حتی اگر `/feed/user/` کار می‌کرد.

### تست مستقیم (انجام‌شده):

```
Endpoint                                Status    Result
─────────────────────────────────────────────────────────────
/users/{id}/info/ (verify)              200 ✅    Session valid
/web_profile_info/?username=botfoori    429 ❌    Rate-limited
/web_profile_info/?username=ba3iraa     429 ❌    Rate-limited
/feed/user/62110858059/ (botfoori)      200 ✅    0 items (empty account)
/feed/user/76026823321/ (ba3iraa)       200 ✅    8 items! ✅
/feed/timeline/ (home feed)             200 ✅    Works
```

**نتیجه:** `/feed/user/` کاملاً کار می‌کند و ۸ پست ba3iraa را برمی‌گرداند!

---

## 🔧 اصلاحات v2.3

### رفع ۱: استراتژی جدید fetch feed

**فایل:** `src/instagram/IgClient.js` — متد `getUserFeed()`

**قبل (v2.2):**
```
1. web_profile_info  → 429 → ❌ FAIL (همینجا متوقف می‌شد)
2. feed/user/        → هرگز امتحان نمی‌شد
```

**بعد (v2.3):**
```
1. اگر userPk داریم → مستقیم /feed/user/{pk}/ (skip web_profile_info)
2. اگر پست پیدا شد → ✅ برگردان
3. اگر 0 پست بود یا pk نداریم → web_profile_info (برای گرفتن pk)
4. اگر web_profile_info هم کار کرد → /feed/user/ با pk جدید
```

**مزیت:** حتی وقتی `web_profile_info` محدود است، ربات کار می‌کند چون مستقیم به `/feed/user/` می‌رود.

### رفع ۲: اسکریپت تشخیصی

**فایل جدید:** `scripts/diagnose-instagram.js`

اجرا کنید:
```bash
node scripts/diagnose-instagram.js
```

این اسکریپت:
- ✅ سشن را تست می‌کند
- ✅ تمام endpointها را امتحان می‌کند
- ✅ تشخیص می‌دهد آیا IP محدود شده
- ✅ تشخیص می‌دهد آیا سشن throttled شده
- ✅ توصیه‌های مشخص می‌دهد

### رفع ۳: اسکریپت تست feed

**فایل جدید:** `scripts/test-feed-fetch.js`

اجرا کنید:
```bash
node scripts/test-feed-fetch.js
```

این اسکریپت مستقیماً `/feed/user/{pk}/` را برای اکانت‌های تست می‌زند و پست‌ها را نمایش می‌دهد.

---

## 🚀 مراحل اجرای روی ویندوز

### مرحله ۱: کد جدید را دانلود کنید

فایل `ig-tg-bot-v2.zip` را extract کنید. پوشه `ig-tg-bot-v2` را باز کنید.

### مرحله ۲: وابستگی‌ها را نصب کنید

```cmd
cd ig-tg-bot-v2
npm install
```

### مرحله ۳: سشن اینستاگرام را در `.env` قرار دهید

فایل `.env` را باز کنید و این خط را اضافه کنید:

```env
IG_SESSION_BASE64=<محتوای فایل ig-session-base64.txt>
```

برای گرفتن محتوای base64:

```cmd
type ig-session-base64.txt
```

یا اگر فایل ندارید، سشن جدید بسازید:

```cmd
npm run setup:instagram
```

### مرحله ۴: سشن تلگرام را در `.env` قرار دهید

در `.env` اضافه کنید:

```env
TG_SESSION_STRING=1AQAOMTQ5LjE1NC4xNzUuNTYBuz4O4AFBp69CZINth1V1xQxLBzkM8mUgJSi2ielF4eHZ1W8u5LzliSfaiTx59fJKTtSWSlUUEyzS5WHPXEoOcA/+hrOzWL6YIwWFhKMRO7l/wcxUFrMDWdJ+WX5eCudvsu1Is0DmB/CPkHrpCmjzhf56f/6c3eO6rGXn+T9XqXVHW4IwLV7IojSHYwMCpMKUwZhBAhzFZbxkmRVnx6zEaX9NvP6pTmHzePTP3xIcYaCZKI2/D7vJ2h+xjL2HFZUrTzzwuDVO8+WnckQ/OuQGe+yJLOx+c3n+8Mn0LElVVP7hEmnqc5etjsY88po2a5XnH8zpBlr+qc6PCXnkZdMdXlg=
```

### مرحله ۵: اکانت‌های هدف را تنظیم کنید

در `.env`:

```env
TARGET_ACCOUNTS=botfoori,ba3iraa,rasanknews
```

### مرحله ۶: اسکریپت تشخیصی را اجرا کنید

```cmd
node scripts/diagnose-instagram.js
```

باید ببینید:

```
Session validity:
  ✅ Session is valid

Feed access:
  feed/user/botfoori: 0 items returned   (اکانت خالی است)
  feed/user/ba3iraa:  8 items returned   ✅
  feed/timeline:      2 items returned   ✅

  ✅ Feed endpoints are working

Throttle detection:
  ✅ No throttle detected
```

### مرحله ۷: تست feed را اجرا کنید

```cmd
node scripts/test-feed-fetch.js
```

باید ۸ پست ba3iraa را ببینید.

### مرحله ۸: ربات را اجرا کنید

```cmd
npm start
```

---

## 📋 علت خطای `getUserByUsername: Instagram cooldown`

از خروجی شما:

```
⚠️ @ba3iraa  getUserByUsername: Instagram c
آخرین چک: هرگز
آخرین خطا: getUserByUsername: Instagram cooldown active for 120s (HTTP 429)
```

**علت:** کد قدلی برای ba3iraa، چون pk نداشت، `getUserByUsername` را صدا می‌زد. این متد `web_profile_info` را امتحان می‌کرد که ۴۲۹ می‌گرفت. بعد، کل عملیات با `InstagramCooldownError` شکست می‌خورد.

**رفع در v2.3:**

1. اگر `userPk` در DB ذخیره شده، `getUserByUsername` اصلاً صدا زده نمی‌شود
2. مستقیم به `/feed/user/{pk}/` می‌رود که کار می‌کند

### چطور pk اکانت‌ها را در DB ذخیره کنیم؟

اگر ba3iraa در DB pk ندارد، دو راه دارید:

#### راه ۱: از طریق ربات تلگرام (پیشنهادی)

به ربات مدیریت دستور بدهید:

```
/add ba3iraa
```

ربات اول `getUserByUsername` را صدا می‌زند (اگر cooldown نباشد، pk را می‌گیرد و در DB ذخیره می‌کند).

#### راه ۲: دستی در DB

```sql
-- با sqlite3:
sqlite3 data/app.db
UPDATE tracked_accounts SET pk = '76026823321' WHERE username = 'ba3iraa';
UPDATE tracked_accounts SET pk = '<pk_of_rasanknews>' WHERE username = 'rasanknews';
```

#### راه ۳: اسکریپت یکی‌بار pk بگیرید

```cmd
node -e "
const axios = require('axios');
axios.get('https://www.instagram.com/api/v1/users/web_profile_info/?username=ba3iraa', {
  headers: { 'x-ig-app-id': '936619743392459' }
}).then(r => console.log('pk:', r.data.data.user.id)).catch(e => console.log('err:', e.response?.status));
"
```

اگر ۴۲۹ گرفتید، صبر کنید (چند ساعت) و دوباره امتحان کنید.

---

## ⚠️ نکته مهم درباره IP شما

از لاگ‌ها مشخص است که IP شما (چه روی ویندوز، چه روی Railway) موقتاً محدود شده است. این به‌خاطر polling تهاجمی قبلی (v1 با 50s/90s) است.

**راه‌حل‌ها:**

### گزینه ۱: صبر کنید (پیشنهادی)

- ۶-۲۴ ساعت صبر کنید
- در این مدت ربات را اجرا نکنید
- بعد با `.env` جدید (POLL_INTERVAL_POSTS=900) اجرا کنید

### گزینه ۲: از پروکسی استفاده کنید

اگر عجله دارید:

```env
PROXY_MODE=static
PROXY_STATIC_URL=socks5://user:pass@stable-host:port
```

یک پروکسی residential پولی بگیرید (مثلاً از BrightData یا Smartproxy) و تنظیم کنید.

### گزینه ۳: از VPN استفاده کنید

روی ویندوز، یک VPN با IP آمریکا/اروپا وصل کنید و ربات را اجرا کنید.

---

## 📊 خلاصه

| مشکل | علت | رفع |
|------|-----|------|
| پست‌های ba3iraa تشخیص داده نمی‌شود | `web_profile_info` ۴۲۹ می‌گیرد، کل fetch شکست می‌خورد | مستقیم به `/feed/user/{pk}/` برو |
| `getUserByUsername` fail می‌شود | `web_profile_info` محدود شده | اگر pk داریم، `getUserByUsername` صدا نزن |
| IP محدود شده | polling تهاجمی قبلی | صبر کنید یا پروکسی استفاده کنید |
| تلگرام متصل نمی‌شود (روی Railway) | `TG_SESSION_STRING` تنظیم نشده | env var را اضافه کنید |

---

## ✅ پیش‌بینی نتیجه

پس از اعمال v2.3:

1. ✅ اگر ba3iraa pk در DB داشته باشد، پست‌هایش fetch می‌شوند
2. ✅ حتی اگر `web_profile_info` ۴۲۹ بگیرد، `/feed/user/` کار می‌کند
3. ✅ پست جدید ba3iraa به تلگرام ارسال می‌شود
4. ✅ cooldown به‌خاطر ۴۲۹ web_profile_info فعال نمی‌شود (چون اصلاً صدا زده نمی‌شود)

---

## 🆘 اگر هنوز مشکل دارید

1. اسکریپت تشخیصی را اجرا کنید و خروجی را ذخیره کنید:
   ```cmd
   node scripts/diagnose-instagram.js > diagnosis.txt 2>&1
   ```

2. اسکریپت تست feed را اجرا کنید:
   ```cmd
   node scripts/test-feed-fetch.js > feed-test.txt 2>&1
   ```

3. محتویات `diagnosis.txt` و `feed-test.txt` را برای من بفرستید.
