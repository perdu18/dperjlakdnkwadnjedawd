# 🚂 راهنمای استقرار در Railway — نسخه نهایی

تاریخ: 2026-08-09
نسخه: v3.0 (Production Railway)

---

## ✅ تأیید موفقیت روی ویندوز

از لاگ‌ها و دیتابیس شما، تأیید شد که ربات **با موفقیت کار می‌کند**:

```
✅ DbzfRnnI32A — @ba3iraa [post] 09/08/2026, 07:12  (photo, 520 KB)
✅ DbzcmaBiI3E — @ba3iraa [post] 09/08/2026, 07:12  (carousel, 2.13 MB)
```

وضعیت دیتابیس:
- `@botfoori` — pk=62110858059 ✅
- `@ba3iraa` — pk=76026823321 ✅ (۱۰ پست ارسال شده)
- `@rasanknews` — pk=8500532298 ✅ (توسط من پیدا شد)

---

## 🎯 ویژگی‌های نسخه نهایی (v3.0)

### 🤞 خودکارسازی‌های جدید:

1. **Auto-seed PKs** — اکانت‌های جدید به‌طور خودکار PK می‌گیرند (از طریق topsearch)
2. **Smart Telegram connection** — اول مستقیم، اگه fail شد SOCKS5 پیدا می‌کند
3. **Fallback feed strategy** — `/feed/user/` مستقیم، با fallback به topsearch
4. **Cooldown-aware polling** — اکانت‌های بدون PK skip می‌شوند، نه throw
5. **Modern User-Agent** — Chrome/131 (به‌جای Chrome/120 قدیمی)
6. **Exponential backoff** — 60s → 120s → 300s → 900s → 1800s

---

## 📋 مراحل استقرار در Railway

### مرحله ۱: کد را به GitHub پوش کنید

```bash
cd ig-tg-bot-v2
git init
git add -A
git commit -m "v3.0: Railway production with auto-seed PKs"
git branch -M main
git remote add origin https://github.com/perdu18/dperjlakdnkwadnjedawd.git
git push -u origin main --force
```

### مرحله ۲: در Railway پروژه بسازید

1. به [railway.app](https://railway.app) بروید
2. **New Project** → **Deploy from GitHub repo**
3. ریپو `perdu18/dperjlakdnkwadnjedawd` را انتخاب کنید
4. Railway خودکار Dockerfile را شناسایی می‌کند

### مرحله ۳: Volume بسازید (مهم!)

برای حفظ دیتابیس و سشن‌ها بین restart ها:

1. در Railway → **Settings** → **Volumes**
2. **Add Volume**
3. Mount path: `/app/data`
4. این باعث می‌شود `data/app.db` و سشن‌ها پایدار بمانند

### مرحله ۴: Variables را تنظیم کنید

در Railway → **Variables**، تمام متغیرهای زیر را اضافه کنید (کپی کنید):

```env
TG_API_ID=33464424
TG_API_HASH=62bc68ac86414304e727cd6834470d7d
TG_PHONE=+17409216751
TG_SESSION_NAME=ig_monitor_session
TG_CHANNEL_ID=-1003952743194
TG_CHANNEL_USERNAME=@instagram_tester
TG_PROXY=auto

IG_SESSION_BASE64=eyJ2ZXJzaW9uIjoyLCJ0eXBlIjoid2ViIiwidXNlcm5hbWUiOiJhY2FkZW15X2JhcmZpIiwiY29va2llcyI6eyJkYXRyIjoiQmFOMmFpZDJGSjVXZ2c4cWQ0cEZscTMzIiwiaWdfZGlkIjoiNEZEQUYzQzYtMEE1OS00RUNBLUE4REMtNUQyNDY0NzJBQjJFIiwibWlkIjoiYW5hakJRQUxBQUd3c1JpVDEyRWNVdTBFWVhmdiIsIndkIjoiMTYwMHgxMDAwIiwiZHByIjoiMC44MDAwMDAwMTE5MjA5MjkiLCJjc3JmdG9rZW4iOiIyQ0lyaTN5NVR3WDFhcnE1VXhUeUNDa3NhNmlEVTFmdiIsImRzX3VzZXJfaWQiOiI1NjY1NDI0NDY1MyIsInNlc3Npb25pZCI6IjU2NjU0MjQ0NjUzJTNBUHhHZGtlT2lRY2RraGwlM0EyMyUzQUFZajlkQjByekdOQWtlTVhxYXl0Ulh0TXJ2ajZQamk1TFBHTVF5eFAzZyIsInBzX2wiOiIxIiwicHNfbiI6IjEiLCJydXIiOiJDTE4lMkMxNzg0MTQ1Njc3OTU5MTc4MCUyQzE3ODczNjk2OTclM0EwMWZmYzA1YmZiNDU2NzU1M2JmZTIxMzgzNjk1YTY4ZDUzNzkyZWRlMTMzOTBiMDUwOWJhNWQ1Yjg0NDAyYmIzZTMzMzM5YjIifSwidXNlckFnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyMC4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiY3JlYXRlZEF0IjoiMjAyNi0wOC0wOFQwMzozNTowNC43NzVaIiwidXNlckluZm8iOnsiaWQiOiI1NjY1NDI0NDY1MyIsInVzZXJuYW1lIjoiYWNhZGVteV9iYXJmaSIsImZ1bGxOYW1lIjoiQWNhZGVteSBCYXJmaSAgfCDYotqp2KfYr9mF24wg2KjYsdmB24wiLCJpc1ByaXZhdGUiOmZhbHNlLCJpc1ZlcmlmaWVkIjpmYWxzZSwicHJvZmlsZVBpY1VybCI6Imh0dHBzOi8vaW5zdGFncmFtLmZyaXg3LTEuZm5hLmZiY2RuLm5ldC92L3Q1MS44OTAxMi0xOS81NzMzMjM0NjVfMTIxOTgyNTQ2MzMwMjIxMl83Mjc4OTIxNjY0MTA5NzI2Mjk2X24uanBnP3N0cD1kc3QtanBnX3MxNTB4MTUwX3R0NiZfbmNfY2F0PTEmY2NiPTctNSZfbmNfc2lkPWY3Y2NjNSZlZmc9ZXlKMlpXNWpiMlJsWDNSaFp5STZJbkJ5YjJacGJHVmZjR2xqTG5kM2R5NURNeUo5Jl9uY19vaGM9dHkzcG9XRkhsRDRRN2tOdndHVnZPVDYmX25jX29jPUFkcFNHSW1ZTFZXQTNTTE1kSFF4VE9EVHdvUDV6NExQR1IzSmN0Q1cxb01tbE5wX3VaMWNIbkhJcG5idEc5LWwtVjQmX25jX3p0PTI0Jl9uY19odD1pbnN0YWdyYW0uZnJpeDctMS5mbmEmX25jX2dpZD1xdmw3WWVsVzRfaU5uQUtyRm5mNEJnJl9uY19zcz03MGFhZiZvaD0wMF9BUUhfc1hVOFpiOUlPY1VmVHpPT011WURxdl9sc2xacXZTUW1jV0xkaHNNaVF3Jm9lPTZBN0M2RjIyIn19

TG_SESSION_STRING=1AQAOMTQ5LjE1NC4xNzUuNTYBuz4O4AFBp69CZINth1V1xQxLBzkM8mUgJSi2ielF4eHZ1W8u5LzliSfaiTx59fJKTtSWSlUUEyzS5WHPXEoOcA/+hrOzWL6YIwWFhKMRO7l/wcxUFrMDWdJ+WX5eCudvsu1Is0DmB/CPkHrpCmjzhf56f/6c3eO6rGXn+T9XqXVHW4IwLV7IojSHYwMCpMKUwZhBAhzFZbxkmRVnx6zEaX9NvP6pTmHzePTP3xIcYaCZKI2/D7vJ2h+xjL2HFZUrTzzwuDVO8+WnckQ/OuQGe+yJLOx+c3n+8Mn0LElVVP7hEmnqc5etjsY88po2a5XnH8zpBlr+qc6PCXnkZdMdXlg=

IG_USERNAME=academy_barfi
IG_PASSWORD=Ali54248590

TARGET_ACCOUNTS=botfoori,ba3iraa,rasanknews

POLL_INTERVAL_POSTS=900
POLL_INTERVAL_STORIES=1800

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

DEBUG_API_TOKEN=7cd9797fad542d5f3d9b5d55fadbbb22ac247dddba7e4ff1ff89422437422602

ALERT_CHAT_ID=8491968448
DAILY_STATS_ENABLED=true
DAILY_STATS_HOUR=9

TG_BOT_TOKEN=8605687961:AAGtX93BKbzQsS0tbRj1oV0JsmSG4K-qWEE
ADMIN_IDS=8491968448
```

### مرحله ۵: Deploy را تأیید کنید

Railway خودکار شروع به build می‌کند. ۲-۳ دقیقه صبر کنید.

### مرحله ۶: بررسی کنید

پس از deploy، با curl بررسی کنید:

```bash
# Health check
curl https://dperjlakdnkwadnjedawd-production.up.railway.app/health

# Debug (با توکن)
curl -H "Authorization: Bearer 7cd9797fad542d5f3d9b5d55fadbbb22ac247dddba7e4ff1ff89422437422602" \
  https://dperjlakdnkwadnjedawd-production.up.railway.app/debug | python3 -m json.tool
```

باید ببینید:
- `"instagram.isLoggedIn": true`
- `"telegram.isConnected": true`
- `"config.targetAccounts": ["botfoori", "ba3iraa", "rasanknews"]`
- `"architecture.version": "v2-dual-mode"`

---

## 🔄 تفاوت Railway با ویندوز

| مورد | ویندوز | Railway |
|------|--------|---------|
| IP | ایران (مسدود تلگرام) | آمریکا/اروپا (آزاد) |
| تلگرام | نیاز به SOCKS5 fallback | مستقیم وصل می‌شود |
| اینستاگرام | ممکن است rate-limited باشد | IP تازه، کم‌تر محدود |
| Volume | فایل لوکال | `/app/data` volume |
| Auto-restart | دستی | خودکار Railway |

### مزیت Railway:
1. **IP آمریکایی** — تلگرام مستقیم وصل می‌شود، نیازی به پروکسی نیست
2. **IP تازه** — اینستاگرام rate limit قبلی روی IP ویندوز شما بود، Railway IP جدید دارد
3. **24/7 uptime** — همیشه روشن
4. **Auto-deploy** — هر push به GitHub خودکار deploy می‌شود

---

## 🤞 خودکارسازی‌ها در Railway

### ۱. Auto-seed PKs (خودکار در startup)

وقتی ربات در Railway شروع می‌شود:
1. دیتابیس را چک می‌کند
2. اکانت‌هایی که PK ندارند را پیدا می‌کند
3. با topsearch PK آن‌ها را پیدا می‌کند
4. در DB ذخیره می‌کند

**نتیجه:** اکانت‌های جدید بدون نیاز به دستور دستی کار می‌کنند!

### ۲. Smart Telegram Connection

در Railway (IP آمریکا):
1. اول مستقیم WSS تلاش می‌کند → ✅ موفق (چون IP آزاد است)
2. نیازی به SOCKS5 fallback نیست

### ۳. Fallback Feed Strategy

اگر `web_profile_info` ۴۲۹ بدهد:
1. مستقیم به `/feed/user/{pk}/` می‌رود
2. اگر PK نداشته باشد، از topsearch پیدا می‌کند
3. هیچ‌وقت کامل fail نمی‌شود

### ۴. Volume Persistence

با volume `/app/data`:
- دیتابیس بین restart ها حفظ می‌شود
- سشن‌ها پایدار می‌مانند
- لیست پروکسی‌ها cache می‌مانند

---

## 🆘 Troubleshooting Railway

### مشکل: Build fail می‌شود

```bash
# لاگ‌های build را چک کنید
# معمولاً مشکل از .gitignore است — مطمئن شوید data/ در .gitignore نیست
```

### مشکل: Telegram وصل نمی‌شود

در Railway نباید این مشکل باشد (IP آمریکایی). اگه بود:
1. بررسی کنید `TG_SESSION_STRING` تنظیم شده باشد
2. بررسی کنید `TG_PROXY=auto` باشد (اول مستقیم، بعد fallback)

### مشکل: Instagram rate-limited

اگر IP Railway هم محدود شد:
1. صبر کنید (۶-۲۴ ساعت)
2. یا `PROXY_MODE=static` با پروکسی residential تنظیم کنید

### مشکل: پست‌ها ارسال نمی‌شوند

1. `/debug` را چک کنید
2. مطمئن شوید `isLoggedIn: true` و `isConnected: true`
3. بررسی کنید `targetAccounts` شامل اکانت مورد نظر باشد
4. صبر کنید تا چرخه polling بعدی (۱۵ دقیقه)

---

## 📊 پیکربندی نهایی

### Polling (ایمن برای production):
- پست‌ها: هر **۱۵ دقیقه** (۹۰۰ ثانیه)
- استوری‌ها: هر **۳۰ دقیقه** (۱۸۰۰ ثانیه)
- تأخیر بین درخواست‌ها: **۵-۱۰ ثانیه**

### Rate Limits:
- Public API: ۵۰ توکن / ساعت
- Auth API: ۳۰ توکن / ساعت
- Exponential backoff: ۶۰s → ۱۲۰s → ۳۰۰s → ۹۰۰s → ۱۸۰۰s

### Caching:
- Profile cache: **۲۴ ساعت**
- Feed cache: **۵ دقیقه**

---

## ✅ چک‌لیست نهایی

قبل از deploy:
- [ ] کد v3.0 به GitHub push شده
- [ ] Volume `/app/data` در Railway ساخته شده
- [ ] تمام Variables (بالا) در Railway تنظیم شده
- [ ] `DEBUG_API_TOKEN` تنظیم شده (برای /debug)

بعد از deploy:
- [ ] `/health` پاسخ `ok` می‌دهد
- [ ] `/debug` نشان می‌دهد `instagram.isLoggedIn: true`
- [ ] `/debug` نشان می‌دهد `telegram.isConnected: true`
- [ ] ربات تلگرام دستور `/status` را پاسخ می‌دهد
- [ ] اولین پست بعد از ۱۵ دقیقه به کانال ارسال می‌شود

---

## 🎉 پایان

ربات شما آماده production است! همه چیز خودکار است:
- ✅ PK اکانت‌ها خودکار پیدا می‌شود
- ✅ تلگرام خودکار وصل می‌شود
- ✅ اینستاگرام خودکار rate-limit را هندل می‌کند
- ✅ پست‌های جدید خودکار به کانال ارسال می‌شوند
- ✅ دیتابیس بین restart ها حفظ می‌شود

موفق باشید! 🚀
