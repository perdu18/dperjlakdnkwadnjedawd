# 🤖 Instagram → Telegram Monitor Bot

ربات حرفه‌ای و پیشرفته Node.js (ESM) که اکانت‌های اینستاگرام رو مانیتور می‌کنه و هر پست یا استوری جدید رو با تمام جزئیات به کانال تلگرام شما ارسال می‌کنه.

## ✨ ویژگی‌ها

- ✅ **پست‌ها** (عکس، ویدیو، carousel، reel) با کپشن کامل، location، تگ شده‌ها، موزیک
- ✅ **استوری‌ها** (عکس و ویدیو) با mentions، hashtags، locations
- ✅ **Live** (ضبط شده) — پشتیبانی کامل
- ✅ **ارسال با MTProto** (User Session) — بدون محدودیت ۵۰ مگابایت، تا ۲GB
- ✅ **مدیریت Proxy خودکار** از [TheSpeedX/PROXY-List](https://github.com/TheSpeedX/PROXY-List) با آپدیت هر N ساعت
- ✅ **Session Persistence** برای Instagram و Telegram (یک‌بار لاگین، همیشه استفاده)
- ✅ **Anti-Detection** — تاخیر تصادفی، چرخش User-Agent، چرخش Proxy
- ✅ **فیلتر محتوا** — بر اساس کلمات کلیدی یا هشتگ
- ✅ **Worker Pool** با محدودیت concurrency
- ✅ **دیتابیس SQLite** برای ردیابی محتوای ارسال شده (جلوگیری از duplicate)
- ✅ **آمار روزانه** خودکار
- ✅ **Health Check** HTTP endpoint (برای Railway)
- ✅ **Graceful Shutdown** و مدیریت خطا
- ✅ **Alert تلگرامی** در صورت بروز خطا
- ✅ **Logging ساختاریافته** با pino

---

## 🏗️ معماری

```
┌─────────────────────────────────────────────────────────┐
│                      Main App                           │
│                                                         │
│  ┌──────────────┐   ┌──────────────────┐               │
│  │ PollingWorker│──>│   IgClient       │               │
│  │  (cron)      │   │ (Private API)    │               │
│  └──────┬───────┘   └──────────────────┘               │
│         │                      │                        │
│         │                ┌─────▼─────┐                  │
│         │                │ MediaDL   │                  │
│         │                │ (proxy)   │                  │
│         │                └─────┬─────┘                  │
│         ▼                      │                        │
│  ┌──────────────┐              │                        │
│  │  SendWorker  │<─────────────┘                        │
│  │  (Queue)     │                                       │
│  └──────┬───────┘                                       │
│         │                                               │
│         ▼                                               │
│  ┌──────────────────┐    ┌─────────────────┐           │
│  │ ChannelSender    │───>│  TgClient       │           │
│  │  (Formatter)     │    │  (MTProto/teleproto)│         │
│  └──────────────────┘    └─────────────────┘           │
│                                                         │
│  ┌──────────────────────────────────────────┐           │
│  │       SQLite Database                    │           │
│  │  - tracked_accounts                      │           │
│  │  - sent_items (dedup)                    │           │
│  │  - proxies, daily_stats, event_log       │           │
│  └──────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────┘
```

---

## 📦 نصب

### پیش‌نیازها

- **Node.js ≥ 22.5** (پیشنهادی: Node 22 LTS یا Node 24)
  - دلیل: پروژه از ماژول داخلی `node:sqlite` استفاده می‌کنه که در Node 22.5+ اضافه شده
  - این کار باعث شده **نیازی به Visual Studio Build Tools یا کامپایل native module نباشه** ✅
- npm یا yarn یا pnpm
- اکانت Instagram (پیشنهاد: اکانت فیک/burner)
- اکانت تلگرام با شماره موبایل
- کانال تلگرام (شما باید ادمین باشید)

### ۱. کلون یا اکسترکت پروژه

```bash
unzip ig-tg-bot.zip
cd ig-tg-bot
```

### ۲. نصب پکیج‌ها

```bash
npm install
```

> **نکته برای کاربران ویندوز:** اگه قبلاً با `better-sqlite3` مشکل داشتید، خبر خوب اینه که در نسخه جدید از `node:sqlite` (ماژول داخلی Node) استفاده شده و **هیچ نیازی به نصب Visual Studio Build Tools نیست**. فقط مطمئن بشید Node.js نسخه 22.5 یا بالاتر دارید.
>
> ```bash
> # چک نسخه Node
> node --version
> # باید >= v22.5.0 باشه
> ```

> **نکته:** هشدارهای `deprecated` برای پکیج‌های `telegram`، `core-js` و... طبیعی هستن و **مشکلی در اجرا ایجاد نمی‌کنن**. این هشدارها فقط اطلاعات نگهدارندگان پکیج هستن.

### ۳. ساخت فایل `.env`

```bash
cp .env.example .env
```

فایل `.env` رو با ویرایشگر متن باز کنید و مقادیر رو پر کنید.

---

## 🔧 تنظیمات

### ۱. دریافت API credentials تلگرام

1. به [my.telegram.org](https://my.telegram.org) برید
2. لاگین کنید با شماره موبایل
3. به بخش **API development tools** برید
4. یک app جدید بسازید (هر نام و توضیح)
5. مقادیر `api_id` و `api_hash` رو کپی کنید
6. در `.env` وارد کنید:
   ```
   TG_API_ID=1234567
   TG_API_HASH=your_hash_here
   TG_PHONE=+989123456789
   ```

### ۲. تنظیمات کانال تلگرام

- یک کانال بسازید یا از کانال موجود استفاده کنید
- اکانت تلگرام شما باید ادمین کانال باشه با دسترسی **Post Messages**
- یکی از این دو رو در `.env` وارد کنید:
  ```
  TG_CHANNEL_ID=-1001234567890    # ID عددی کانال
  TG_CHANNEL_USERNAME=@mychannel   # یا یوزرنیم
  ```

برای دریافت channel ID:
1. به [t.me/userinfobot](https://t.me/userinfobot) پیام بدید
2. کانال رو فوروارد کنید بهش
3. ID رو می‌گیرید (با `-100` شروع میشه)

### ۳. تنظیمات اینستاگرام

```
IG_USERNAME=your_ig_username
IG_PASSWORD=your_ig_password
```

⚠️ **هشدار:** از اکانت شخصی اصلی استفاده نکنید. یک اکانت فیک بسازید تا در صورت بن شدن، اکانت اصلی شما آسیب نبینه.

### ۴. اکانت‌های هدف

```
TARGET_ACCOUNTS=user1,user2,user3,user4,user5
```

با کاما جدا کنید. حداکثر ۱۰-۱۵ اکانت پیشنهاد میشه (با یک اکانت IG).

### ۵. تنظیمات Proxy

برای جلوگیری از بن شدن، حتماً از پروکسی استفاده کنید:

```
PROXY_MODE=list   # یا none | static
```

**حالت list (پیشنهادی):** به‌صورت خودکار از GitHub پروکسی‌های رایگان دانلود می‌کنه:
```
PROXY_LIST_UPDATE_HOURS=3   # هر ۳ ساعت آپدیت کن
```

**حالت static:** برای پروکسی پولی شخصی:
```
PROXY_MODE=static
PROXY_STATIC_URL=http://user:pass@host:port
# یا socks5://user:pass@host:port
```

---

## 🚀 اجرا

### مرحله ۱: ساخت session تلگرام (یک‌بار)

```bash
npm run setup:telegram
```

این اسکریپت:
1. از شما API_ID, API_HASH, PHONE می‌خواد
2. به تلگرام وصل میشه
3. کد تایید رو می‌خواد
4. session string رو در فایل `data/tg-session/` ذخیره می‌کنه
5. (اختیاری) کانال رو بررسی می‌کنه و پیام تست می‌فرسته

### مرحله ۲: ساخت session اینستاگرام (یک‌بار)

```bash
npm run setup:instagram
```

> ✅ **روش جدید:** این اسکریپت از **Playwright** (مرورگر واقعی Chromium) استفاده می‌کنه تا لاگین کنه. مرورگر به‌صورت可视打开 میشه، شما لاگین می‌کنید (یا خودکار انجام میشه)، و session ذخیره میشه.

#### مراحل:

1. **اجرای اسکریپت:**
   ```bash
   npm run setup:instagram
   ```

2. **وارد کردن username و password** (از `.env` یا تعاملی)

3. **مرورگر Chromium خودکار باز میشه** و به instagram.com میره

4. **لاگین خودکار:**
   - اسکریپت سعی می‌کنه خودکار username/password رو وارد کنه و دکمه login رو بزنه
   - اگه موفق باشه، ادامه میره

5. **اگه Challenge یا 2FA لازم باشه:**
   - اسکریپت در مرورگر میمونه و منتظر میمونه
   - شما در پنجره‌ی مرورگر، دستورات رو دنبال می‌کنید (مثلاً کد SMS رو وارد می‌کنید)
   - وقتی کامل شد، اسکریپت خودکار ادامه میده

6. **ذخیره session:**
   - تمام cookies استخراج میشه
   - session در `data/ig-sessions/{username}.web-session.json` ذخیره میشه
   - اکانت‌های هدف تست میشن

#### مزایای روش Playwright:

- ✅ **بدون challenge اتوماسیون** — اینستاگرام می‌بینه مرورگر واقعیه
- ✅ **هندل خودکار 2FA** — فقط کد رو در مرورگر وارد کنید
- ✅ **هندل خودکار challenge** — اگر "Was this you?" بیاد، در مرورگر کلیک کنید
- ✅ **session پایدار** — هفته‌ها/ماه‌ها کار می‌کنه
- ✅ **بدون نیاز به افزونه مرورگر** — همه‌چیز خودکار

#### نصب اولیه:

وقتی `npm install` رو اجرا می‌کنید، اسکریپت `postinstall` به‌طور خودکار Chromium رو دانلود می‌کنه (~۱۸۰MB). این فقط یکبار انجام میشه.

اگه به‌صورت دستی می‌خواید نصب کنید:
```bash
npx playwright install chromium
```

#### مدت زمان session:

- session می‌تونه **هفته‌ها یا ماه‌ها** کار کنه
- اگه session منقضی شد، فقط دوباره `npm run setup:instagram` رو اجرا کنید
- **مهم:** از instagram.com در مرورگر **logout نکنید**

### مرحله ۳: اجرای ربات

```bash
npm start
```

یا:

```bash
node src/index.js
```

ربات شروع به کار می‌کنه و لاگ‌ها رو نشون می‌ده. می‌تونید با `Ctrl+C` متوقف کنید.

---

## 🌐 استقرار روی Railway

### روش ۱:_deploy از GitHub

1. پروژه رو به یک repo گیت‌هاب پوش کنید
2. به [railway.app](https://railway.app) برید و **New Project** بزنید
3. **Deploy from GitHub repo** رو انتخاب کنید
4. متغیرهای محیطی رو اضافه کنید (Settings → Variables):
   - تمام متغیرهای `.env` رو وارد کنید
   - **مهم:** `TG_SESSION_STRING` رو هم اضافه کنید (مقدار session string که از `setup:telegram` گرفتید)
   - `NODE_ENV=production`

5. Railway خودش فایل `railway.json` و `Dockerfile` رو شناسایی می‌کنه

### روش ۲:deploy با Docker

```bash
# Build locally
docker build -t ig-tg-bot .

# Run
docker run -d \
  --name ig-tg-bot \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  ig-tg-bot
```

### تنظیم Volume در Railway

برای حفظ session و دیتابیس بین restart ها:

1. در Railway → Settings → Volumes
2. Volume path: `/app/data`
3. این باعث میشه session و SQLite پایدار بمونن

---

## ⚙️ تنظیمات پیشرفته

### فیلتر محتوا

```
# فقط پست‌هایی که این کلمات رو دارن ارسال بشن
KEYWORD_FILTER=sale,discount,offer

# یا فقط با این هشتگ‌ها
HASHTAG_FILTER=sale,discount
```

اگه خالی باشه، همه پست‌ها ارسال میشه.

### تنظیمات Anti-Detection

```
# تاخیر تصادفی بین درخواست‌ها (میلی‌ثانیه)
REQUEST_DELAY_MIN=2000
REQUEST_DELAY_MAX=5000

# تغییر User-Agent
ROTATE_USER_AGENT=true

# فواصل چک کردن (ثانیه)
POLL_INTERVAL_POSTS=120
POLL_INTERVAL_STORIES=90
```

### مدیریت خطا

```
# آیدی چت برای دریافت alertها (می‌تونه آیدی خودتون باشه)
ALERT_CHAT_ID=123456789

# آمار روزانه
DAILY_STATS_ENABLED=true
DAILY_STATS_HOUR=9   # ساعت 9 صبح
```

---

## 📊 مانیتورینگ

### Health Check Endpoint

وقتی ربات اجرا میشه، روی پورت ۳۰۰۰ (یا PORT env) یک HTTP server سبک راه می‌افته:

```
GET /health         → وضعیت سرویس‌ها
GET /stats          → آمار امروز
POST /refresh-proxies → آپدیت دستی پروکسی‌ها
```

مثال:
```bash
curl http://localhost:3000/health
```

### لاگ‌ها

- **Console:** در حالت development با رنگ و فرمت زیبا
- **File:** در `data/app.log` با فرمت JSON

تغییر level:
```
LOG_LEVEL=debug   # trace | debug | info | warn | error | fatal
```

---

## 🛠️ ساختار پروژه

```
ig-tg-bot/
├── package.json
├── .env.example
├── .gitignore
├── Dockerfile
├── railway.json
├── README.md
├── data/                          # داده‌های runtime (gitignored)
│   ├── ig-sessions/              # session اینستاگرام
│   ├── tg-session/               # session تلگرام
│   ├── proxies/                  # cache لیست پروکسی
│   ├── media/                    # دانلود موقت فایل‌ها
│   └── app.db                    # SQLite database
├── scripts/
│   ├── setup-telegram.js         # ساخت session تلگرام
│   └── setup-instagram.js        # لاگین اولیه اینستاگرام
└── src/
    ├── index.js                  # نقطه ورود اصلی
    ├── config/
    │   ├── env.js                # مدیریت متغیرهای محیطی
    │   └── constants.js          # ثابت‌ها
    ├── database/
    │   ├── db.js                 # اتصال SQLite + migrations
    │   ├── TrackedAccountsRepository.js
    │   └── SentItemsRepository.js
    ├── instagram/
    │   ├── IgClient.js           # wrapper روی instagram-private-api
    │   └── MediaDownloader.js    # دانلود با پشتیبانی از proxy
    ├── telegram/
    │   ├── TgClient.js           # wrapper روی teleproto (MTProto)
    │   ├── ChannelSender.js      # ارسال به کانال
    │   └── MessageFormatter.js   # فرمت HTML برای تلگرام
    ├── proxy/
    │   └── ProxyManager.js       # دانلود و چرخش پروکسی
    ├── workers/
    │   ├── PollingWorker.js      # چک دوره‌ای اکانت‌ها
    │   └── SendWorker.js         # پردازش صف ارسال
    └── utils/
        ├── Logger.js             # pino logger
        ├── Helpers.js            # توابع کمکی
        ├── Retry.js              # retry با backoff
        └── FileUtils.js          # دانلود و مدیریت فایل
```

---

## ⚠️ هشدارهای مهم

### ۱. ریسک بن شدن اکانت اینستاگرام

اینستاگرام سخت‌گیرانه با اکانت‌هایی که از API خصوصی استفاده می‌کنن برخورد می‌کنه. برای کاهش ریسک:

- ✅ از اکانت فیک استفاده کنید (نه اکانت شخصی اصلی)
- ✅ حتماً از پروکسی استفاده کنید (`PROXY_MODE=list` یا `static`)
- ✅ فواصل polling رو زیاد پایین نیارید (حداقل ۶۰ ثانیه)
- ✅ تعداد اکانت‌های هدف رو زیاد بالا نبرید (با یک اکانت IG حداکثر ۱۰-۱۵ اکانت)
- ✅ تاخیرهای تصادفی رو فعال نگه دارید (`REQUEST_DELAY_MIN`/`MAX`)

### ۲. محدودیت‌های تلگرام

- اکانت تلگرام شما می‌تونه به ۵۰ کانال عضو باشه (مگر اینکه Premium بگیرید)
- ارسال پیام بیش از حد باعث flood wait میشه
- محدودیت MTProto: ۲GB per file

### ۳. توافق‌نامه‌ها

استفاده از این ربات مسئولیت شماست. مطمئن بشید که:
- قوانین Telegram رو رعایت می‌کنید
- قوانین Instagram رو می‌دونید (استفاده از API خصوصی خلاف ToS هست)
- محتوای کپی‌رایت شده رو بدون اجازه بازنشر نمی‌کنید

---

## 🆘 Troubleshooting

### مشکل: `gyp ERR! find VS` یا خطای `better-sqlite3` در ویندوز

**علت:** در نسخه‌های قدیمی پروژه از `better-sqlite3` استفاده می‌شد که نیازی به Visual Studio Build Tools داشت.

**راه‌حل:** پروژه رو به نسخه جدید آپدیت کنید که از `node:sqlite` (ماژول داخلی Node) استفاده می‌کنه. اگر از ZIP جدید استفاده می‌کنید این مشکل دیگه وجود نداره.

اگه همچنان روی نسخه قدیمی هستید:

**روش ۱ (پیشنهادی):** آپدیت به نسخه جدید پروژه (استفاده از `node:sqlite`)

**روش ۲:** نصب Visual Studio Build Tools با VC++:
1. دانلود [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. در installer، تیک **"Desktop development with C++"** رو بزنید
3. مطمئن بشید **"MSVC v143 - VS 2022 C++ x64/x86 build tools"** نصب میشه
4. سیستم رو restart کنید و دوباره `npm install` بزنید

**روش ۳:** استفاده از Node.js نسخه 20 LTS که prebuilt binary داره:
```bash
# با nvm
nvm install 20
nvm use 20
npm install
```

### مشکل: `ExperimentalWarning: node:sqlite is an experimental feature`

**علت:** در Node.js 22.5 تا 22.x ممکنه `node:sqlite` هنوز experimental باشه.

**راه‌حل:** این فقط یه warning هست و مشکلی در اجرا نداره. برای حذف warning:
```bash
node --no-warnings src/index.js
```
یا آپدیت به Node.js 24 که در اون `node:sqlite` stable شده.

### مشکل: `No Telegram session found`

**راه‌حل:** `npm run setup:telegram` رو اجرا کنید.

### مشکل: `Login failed: bad_password`

**راه‌حل:** رمز اینستاگرام رو در `.env` چک کنید.

### مشکل: `challenge_required` در اینستاگرام

**راه‌حل:**
1. به اکانت IG از مرورگر لاگین کنید
2. در بخش security alerts، "Was this you?" رو تأیید کنید
3. دوباره `npm run setup:instagram` رو اجرا کنید

### مشکل: `Could not resolve channel`

**راه‌حل:**
- مطمئن بشید اکانت تلگرام شما عضو کانال هست
- مطمئن بشید ادمین هستید با دسترسی post messages
- TG_CHANNEL_ID رو با `-100` شروع کنید

### مشکل: `FLOOD_WAIT_X`

**راه‌حل:** ربات رو متوقف کنید، X ثانیه صبر کنید، سپس restart کنید. اگه مدام اتفاق می‌افته:
- فواصل polling رو بیشتر کنید
- تعداد اکانت‌های هدف رو کم کنید

### مشکل: استوری‌ها ارسال نمیشن

**راه‌حل:**
- مطمئن بشید اکانت IG شما follower اکانت هدف هست (اگه private هست)
- مطمئن بشید اکانت IG شما خودش not private باشه
- استوری‌های Close Friends فقط اگه در لیست close friends باشید میاد

### مشکل: فایل ویدیویی بزرگ ارسال نمیشه

**راه‌حل:**
- مطمئن بشید از MTProto استفاده می‌کنید (نه Bot API)
- بررسی کنید `TG_SESSION_STRING` درست تنظیم شده
- در پروکسی محدودیت حجم نباشه

---

## 📝 License

MIT — استفاده آزاد. مسئولیت با کاربر است.

---

## 🤝 پشتیبانی و توسعه

اگه باگ پیدا کردید یا فیچر جدید خواستید:
1. در لاگ‌ها بگردید (`data/app.log`)
2. بخش Troubleshooting رو بخونید
3. در GitHub issue باز کنید

---

## 🎯 Roadmap

- [ ] پشتیبانی از Highlights
- [ ] پشتیبانی از Direct Messages (mention detections)
- [ ] Web UI dashboard
- [ ] پشتیبانی از چند اکانت IG (round-robin)
- [ ] پشتیبانی از comments
- [ ] Auto-retry با پروکسی متفاوت
- [ ] Thumbnail generation برای ویدیوها
- [ ] Watermark option

---

**ساخته شده با ❤️ برای جامعه فارسی‌زبانی**
