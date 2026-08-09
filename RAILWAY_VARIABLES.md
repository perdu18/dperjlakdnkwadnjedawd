# 🚂 راهنمای کامل Railway Variables

این فایل حاوی **تمام متغیرهای مورد نیاز** برای راه‌اندازی ربات در Railway است.
کافی است این مقادیر را در Railway → Settings → Variables کپی کنید.

---

## 📋 لیست کامل متغیرها (کپی کنید)

```
TG_API_ID=33464424
TG_API_HASH=62bc68ac86414304e727cd6834470d7d
TG_PHONE=+17409216751
TG_SESSION_NAME=ig_monitor_session
TG_SESSION_STRING=PASTE_HERE_THE_SESSION_STRING_FROM_BELOW
TG_CHANNEL_ID=-1003952743194
TG_CHANNEL_USERNAME=@instagram_tester
TG_PROXY=auto

IG_USERNAME=academy_barfi
IG_PASSWORD=Ali54248590
IG_SESSION_BASE64=PASTE_HERE_THE_BASE64_FROM_BELOW

TARGET_ACCOUNTS=botfoori,ba3iraa,rasanknews
POLL_INTERVAL_POSTS=900
POLL_INTERVAL_STORIES=1800
KEYWORD_FILTER=
HASHTAG_FILTER=

PROXY_MODE=list
PROXY_LIST_URL_HTTP=https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt
PROXY_LIST_URL_SOCKS=https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt
PROXY_LIST_UPDATE_HOURS=3
PROXY_STATIC_URL=
PROXY_TIMEOUT=10000

DATA_DIR=./data
DB_PATH=./data/app.db
IG_SESSION_DIR=./data/ig-sessions
TG_SESSION_DIR=./data/tg-session
MEDIA_DIR=./data/media
PROXY_DIR=./data/proxies

MAX_CONCURRENT_DOWNLOADS=3
MAX_CONCURRENT_SENDS=2
DOWNLOAD_TIMEOUT=60000
SEND_TIMEOUT=120000

REQUEST_DELAY_MIN=5000
REQUEST_DELAY_MAX=10000
ROTATE_USER_AGENT=false
LOGOUT_AFTER_REQUEST=false
IG_RATE_LIMIT_COOLDOWN=900
IG_CHALLENGE_COOLDOWN=3600
IG_RECONNECT_INTERVAL=600
SCHEDULE_JITTER_PERCENT=20
IG_PROFILE_CACHE_TTL=86400
FEED_FETCH_LIMIT=12

LOG_LEVEL=info
LOG_TO_FILE=true
LOG_FILE=./data/app.log

NODE_ENV=production
PORT=3000
DEBUG_API_TOKEN=GENERATE_NEW_TOKEN_WITH_openssl_rand_hex_32

ALERT_CHAT_ID=8491968448
DAILY_STATS_ENABLED=true
DAILY_STATS_HOUR=9

TG_BOT_TOKEN=8605687961:AAGtX93BKbzQsS0tbRj1oV0JsmSG4K-qWEE
ADMIN_IDS=8491968448
```

---

## 🔑 متغیرهای حساس (باید جایگزین کنید)

### ۱. `TG_SESSION_STRING` — سشن تلگرام

این **مهم‌ترین متغیر** است. بدون آن، تلگرام متصل نمی‌شود.

مقدار دقیق (از فایل `data/tg-session/ig_monitor_session.session` شما استخراج شد):

```
TG_SESSION_STRING=1AQAOMTQ5LjE1NC4xNzUuNTYBuz4O4AFBp69CZINth1V1xQxLBzkM8mUgJSi2ielF4eHZ1W8u5LzliSfaiTx59fJKTtSWSlUUEyzS5WHPXEoOcA/+hrOzWL6YIwWFhKMRO7l/wcxUFrMDWdJ+WX5eCudvsu1Is0DmB/CPkHrpCmjzhf56f/6c3eO6rGXn+T9XqXVHW4IwLV7IojSHYwMCpMKUwZhBAhzFZbxkmRVnx6zEaX9NvP6pTmHzePTP3xIcYaCZKI2/D7vJ2h+xjL2HFZUrTzzwuDVO8+WnckQ/OuQGe+yJLOx+c3n+8Mn0LElVVP7hEmnqc5etjsY88po2a5XnH8zpBlr+qc6PCXnkZdMdXlg=
```

**کپی کنید و در Railway قرار دهید.**

### ۲. `IG_SESSION_BASE64` — سشن اینستاگرام

این متغیر در حال حاضر در Railway شما تنظیم شده (چون `sessionSource: "environment"` در خروجی debug بود).
اگر می‌خواهید سشن جدید بسازید:

```bash
# در کامپیوتر خودتان:
npm run setup:instagram
npm run export-session
# خروجی را در IG_SESSION_BASE64 در Railway قرار دهید
```

### ۳. `DEBUG_API_TOKEN` — توکن محافظت /debug

توکن فعلی شما (`a9f82k29s7d92ksl2m`) بسیار ضعیف است. یک توکن قوی بسازید:

```bash
openssl rand -hex 32
```

خروجی چیزی شبیه:
```
a3f7b2c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
```

این را در `DEBUG_API_TOKEN` قرار دهید. سپس برای دسترسی به `/debug`:

```bash
curl -H "Authorization: Bearer a3f7b2c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1" \
  https://dperjlakdnkwadnjedawd-production.up.railway.app/debug
```

---

## ⚠️ مشکلات فعلی سرور شما

از خروجی `/debug` شما (زمان: 01:26):

### مشکل ۱: تلگرام متصل نیست ❌

```
"isConnected": false,
"hasSession": false,
"lastError": "No Telegram session found. Run: npm run setup:telegram"
```

**علت:** متغیر `TG_SESSION_STRING` در Railway تنظیم نشده است.

**راه‌حل:** مقدار `TG_SESSION_STRING` که در بالا داده شد را در Railway Variables اضافه کنید.

### مشکل ۲: اینستاگرام rate-limited است ⚠️

```
"cooldownReason": "auth:HTTP 429",
"backoffIndex": 2
```

**علت:** IP سرور Railway شما به‌خاطر polling تهاجمی قبلی (v1 با 50s/90s) موقتاً محدود شده است.

**راه‌حل:** صبر کنید (۱-۲ ساعت). با معماری v2 و فواصل ۱۵/۳۰ دقیقه، این مشکل برطرف می‌شود.

### مشکل ۳: `TARGET_ACCOUNTS` فقط ۱ اکانت است

```
"targetAccounts": ["botfoori"]
```

ولی شما ۳ اکانت در دیتابیس دارید (`accounts: 3`). دو اکانت دیگر (`ba3iraa`, `rasanknews`) با دستور `/add` اضافه شده‌اند.

**راه‌حل:** در Railway Variables:
```
TARGET_ACCOUNTS=botfoori,ba3iraa,rasanknews
```

---

## 🚀 مراحل راه‌اندازی نهایی

### مرحله ۱: کد جدید را push کنید

```bash
cd ig-tg-bot-v2
git add -A
git commit -m "v2.2: fix Telegram session loading, rate-limit message handling"
git push
```

### مرحله ۲: متغیرها را در Railway تنظیم کنید

به Railway → Your Project → Settings → Variables بروید و:

1. **اضافه کنید:**
   - `TG_SESSION_STRING` = (مقدار داده‌شده در بالا)

2. **به‌روزرسانی کنید:**
   - `TARGET_ACCOUNTS` = `botfoori,ba3iraa,rasanknews`
   - `POLL_INTERVAL_POSTS` = `900`
   - `POLL_INTERVAL_STORIES` = `1800`
   - `REQUEST_DELAY_MIN` = `5000`
   - `REQUEST_DELAY_MAX` = `10000`
   - `DEBUG_API_TOKEN` = (توکن جدید از `openssl rand -hex 32`)

3. **حذف کنید (اگر وجود دارد):**
   - `ROTATE_USER_AGENT` (یا `false` قرار دهید)

### مرحله ۳: صبر کنید تا redeploy کامل شود

Railway خودکار redeploy می‌کند (~۲-۳ دقیقه).

### مرحله ۴: بررسی کنید

```bash
# با توکن جدید:
curl -H "Authorization: Bearer YOUR_NEW_TOKEN" \
  https://dperjlakdnkwadnjedawd-production.up.railway.app/debug | python3 -m json.tool
```

باید ببینید:
- `"telegram.isConnected": true`
- `"telegram.me.username": "AdamBarfi_V4"`
- `"instagram.isLoggedIn": true`
- `"requestSafety.cooldownUntil": null` (پس از رفع rate-limit)
- `"config.targetAccounts": ["botfoori", "ba3iraa", "rasanknews"]`

---

## 🔒 هشدار امنیتی مهم

فایل `.env` شما حاوی اطلاعات حساس است:
- رمز اینستاگرام: `Ali54248590`
- Telegram API Hash: `62bc68ac...`
- Bot Token: `8605687961:AAG...`
- شماره تلفن: `+17409216751`

**اگر این فایل را با کسی به اشتراک گذاشتید، فوراً:**

1. **رمز اینستاگرام** را عوض کنید:
   - instagram.com → Settings → Security → Password

2. **Telegram API Hash** را revoke کنید:
   - my.telegram.org → API development tools → Revoke

3. **Bot Token** را revoke کنید:
   - @BotFather → /revoke

4. **سشن اینستاگرام** را دوباره بسازید:
   ```bash
   npm run setup:instagram
   npm run export-session
   # خروجی جدید را در IG_SESSION_BASE64 قرار دهید
   ```

---

## 📊 خلاصه متغیرهای ضروری

| متغیر | ضروری؟ | مقدار | توضیح |
|-------|--------|-------|-------|
| `TG_API_ID` | ✅ | `33464424` | از my.telegram.org |
| `TG_API_HASH` | ✅ | `62bc68ac...` | از my.telegram.org |
| `TG_PHONE` | ✅ | `+17409216751` | شماره تلگرام |
| `TG_SESSION_STRING` | ✅ | (داده‌شده در بالا) | **جدید! بدون آن تلگرام کار نمی‌کند** |
| `TG_CHANNEL_ID` | ✅ | `-1003952743194` | آیدی کانال |
| `TG_BOT_TOKEN` | ✅ | `8605687961:AAG...` | از @BotFather |
| `IG_USERNAME` | ✅ | `academy_barfi` | یوزرنیم اینستاگرام |
| `IG_PASSWORD` | ✅ | `Ali54248590` | رمز اینستاگرام |
| `IG_SESSION_BASE64` | ✅ | (از export-session) | سشن اینستاگرام |
| `TARGET_ACCOUNTS` | ✅ | `botfoori,ba3iraa,rasanknews` | اکانت‌های مانیتور |
| `DEBUG_API_TOKEN` | ✅ | (توکن جدید) | محافظت /debug |
| `ADMIN_IDS` | ✅ | `8491968448` | آیدی ادمین |
| `ALERT_CHAT_ID` | اختیاری | `8491968448` | دریافت alertها |

---

## 🆘 Troubleshooting

### تلگرام وصل نمی‌شود

1. بررسی کنید `TG_SESSION_STRING` در Railway تنظیم شده باشد
2. بررسی کنید مقدار با `1` شروع شود و طول آن >50 باشد
3. در لاگ‌ها بگردید دنبال: `"Loaded Telegram session from TG_SESSION_STRING env var"`

### اینستاگرام 429 می‌دهد

1. صبر کنید (۱-۲ ساعت) تا rate-limit موقتی برطرف شود
2. بررسی کنید `POLL_INTERVAL_POSTS=900` (نه 50!)
3. بررسی کنید `REQUEST_DELAY_MIN=5000` (نه 2000!)

### پست‌های ba3iraa تشخیص داده نمی‌شود

1. بررسی کنید `TARGET_ACCOUNTS` شامل `ba3iraa` باشد
2. بررسی کنید rate-limit فعال نباشد (`cooldownUntil: null` در /debug)
3. صبر کنید تا چرخه polling بعدی (هر ۱۵ دقیقه)

### /debug دسترسی غیرمجاز می‌دهد

1. بررسی کنید `DEBUG_API_TOKEN` در Railway تنظیم شده باشد
2. از هدر درست استفاده کنید: `Authorization: Bearer YOUR_TOKEN`
3. در production، این مسیر محافظت‌شده است
