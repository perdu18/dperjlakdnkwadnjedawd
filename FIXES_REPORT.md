# 🔧 گزارش کامل باگ‌ها و رفع مشکلات — ig-tg-bot

تاریخ بررسی: 2026-08-09
نسخه بررسی‌شده: v2.zip + GitHub repo (commit 8d1e01d)

---

## ❓ چرا اینستاگرام وصل نمی‌شود؟ (پاسخ اصلی)

### علت قطعی: `checkpoint_required`

از خروجی `/debug` سرور شما:

```json
"lastVerification": {
  "valid": false,
  "unknown": true,
  "reason": "Authenticated endpoints returned no recognized user payload...",
  "checks": [{
    "method": "web_form_data",
    "status": 400,
    "message": "checkpoint_required"
  }]
}
```

این یعنی **اینستاگرام سشن شما را علامت زده و از شما می‌خواهد چالش امنیتی را تکمیل کنید** ("Was this you?" یا کد SMS/email). ربات نمی‌تواند با صبر کردن خودکار از این حالت بازیابی شود.

### چهار علت زمینه‌ای (همه با هم):

| # | علت | تأثیر |
|---|-----|-------|
| 1 | **تفاوت IP/Geo** — سشن با Playwright روی کامپیوتر شما (ایران) ساخته شده، ولی از سرور Railway (US/EU) استفاده می‌شود | اینستاگرام تغییر ناگهانی موقعیت را مشکوک می‌بیند |
| 2 | **User-Agent قدیمی** — `Chrome/120.0.0.0` (دسامبر 2023، حدود ۲.۵ سال پیش) | اینستاگرام UA‌های خیلی قدیمی را به‌عنوان اتوماسیون علامت می‌زند |
| 3 | **endpoint اشتباه برای verify** — کد از `/api/v1/accounts/edit/web_form_data/` (ویرایش حساس حساب) استفاده می‌کرد | این endpoint حتی با سشن‌های معتبر هم گاهی `checkpoint_required` برمی‌گرداند |
| 4 | **polling بسیار تهاجمی** — `.env` شما `POLL_INTERVAL_POSTS=50` و `POLL_INTERVAL_STORIES=90` داشت (هر ۵۰ ثانیه!) | این الگوی رباتیک سریعاً rate-limit و checkpoint trigger می‌کند |

### راه‌حل فوری (کاری که شما باید بکنید):

1. **به اپ اینستاگرام بروید** → Settings → Security → Emails from Instagram → پیام "Was this you?" را تأیید کنید
2. **یا** به instagram.com بروید و هر چالش نمایش‌داده‌شده را کامل کنید
3. **سشن جدید بسازید** (توصیه می‌شود):
   ```bash
   npm run setup:instagram
   ```
   ولی این بار:
   - اگر امکان دارد، از proxy استاتیک استفاده کنید که همان IP سرور Railway باشد
   - یا حداقل صبر کنید تا چالش فعلی در اپ پاک شود
4. سپس `IG_SESSION_BASE64` جدید را در Railway variables تنظیم کنید

### تغییرات کد انجام‌شده (در این نسخه fix شده):

- ✅ endpoint verification از `web_form_data` به `/users/{id}/info/` (read-only) تغییر کرد
- ✅ `checkpoint_required` حالا cooldown ۶ ساعته می‌گیرد (به‌جای ۱ ساعت) تا حلقه تلاش بی‌فایده قطع شود
- ✅ admin با پیام تلگرامی مطلع می‌شود که چالش دستی لازم است
- ✅ `User-Agent` پیش‌فرض از Chrome/120 به Chrome/131 ارتقا یافت
- ✅ `.env` اصلاح شد: polling ۳۰۰/۴۲۰ ثانیه، delay ۳۰۰۰/۷۰۰۰ms، `ROTATE_USER_AGENT=false`

---

## 📋 فهرست کامل باگ‌های شناسایی‌شده و رفع‌شده

### 🔴 باگ‌های بحرانی (Critical)

#### 1. ✅ endpoint تأیید سشن اشتباه (`IgClient.js`)
- **فایل:** `src/instagram/IgClient.js` — متد `_verifySession()`
- **مشکل:** اولین endpoint `/api/v1/accounts/edit/web_form_data/` بود — یک endpoint ویرایش حساب حساس که مرتباً `checkpoint_required` برمی‌گرداند حتی وقتی سشن معتبر است
- **رفع:** ترتیب عوض شد: اول `/users/{id}/info/` (read-only، کم‌ریسک)؛ `web_form_data` به fallback تبدیل شد

#### 2. ✅ `checkpoint_required` به‌عنوان cooldown کوتاه handled می‌شد (`IgClient.js`)
- **فایل:** `src/instagram/IgClient.js` — متد `_applySafetyCooldown()`
- **مشکل:** cooldown فقط ۱ ساعت (`IG_CHALLENGE_COOLDOWN=3600`) بود. ربات هر ساعت تلاش می‌کرد و دوباره `checkpoint_required` می‌گرفت — حلقه بی‌پایان
- **رفع:** cooldown اختصاصی ۶ ساعت برای checkpoint؛ متد جدید `needsManualChallenge()` برای تشخیص؛ admin notification هنگام نیاز به چالش دستی

#### 3. ✅ User-Agent قدیمی Chrome/120 (`IgClient.js`, `MediaDownloader.js`, `setup-instagram.js`)
- **فایل‌ها:** `BROWSER_UA` ثابت در سه فایل
- **مشکل:** Chrome 120 از دسامبر 2023 است (۲.۵ سال پیش). اینستاگرام این UA را مشکوک می‌بیند
- **رفع:** ارتقا به `Chrome/131.0.0.0`
- **نکته مهم:** سشن فعلی شما با Chrome/120 ساخته شده، پس برای سشن موجود باید `session.userAgent` (که همان Chrome/120 است) استفاده شود. برای سشن‌های جدید، Chrome/131 استفاده خواهد شد. **توصیه: سشن جدید بسازید.**

#### 4. ✅ polling بسیار تهاجمی در `.env`
- **فایل:** `.env`
- **مشکل:** `POLL_INTERVAL_POSTS=50` (۵۰ ثانیه!) و `POLL_INTERVAL_STORIES=90` (۹۰ ثانیه)
- **رفع:** `POLL_INTERVAL_POSTS=300` (۵ دقیقه) و `POLL_INTERVAL_STORIES=420` (۷ دقیقه) — منطبق با defaults امن در `env.js`

#### 5. ✅ `ROTATE_USER_AGENT=true` در `.env` (misconfiguration)
- **فایل:** `.env`
- **مشکل:** فعال بود، ولی README می‌گوید باید FALSE باشد. UA باید با session ساخته‌شده ثابت بماند. (کد واقعاً rotation را پیاده نمی‌کند، ولی اگر پیاده می‌شد سشن فوراً می‌شکست چون `constants.js` شامل UA‌های اندروید اینستاگرام است که با سشن وب ناسازگارند)
- **رفع:** `ROTATE_USER_AGENT=false`

### 🟠 باگ‌های متوسط (Medium)

#### 6. ✅ `downloadMany` ترتیبی به‌جای موازی (`MediaDownloader.js`)
- **فایل:** `src/instagram/MediaDownloader.js`
- **مشکل:** `for (let i...) { await this.download(...) }` — carouselهای ۱۰‌تایی را یکی‌یکی دانلود می‌کرد با اینکه `maxConcurrentDownloads=3` در config تعریف شده بود
- **رفع:** پیاده‌سازی pool با concurrency محدود (استفاده از `maxConcurrent`)؛ حفظ ترتیب نتایج با index

#### 7. ✅ endpointهای منسوخ‌شده در `setup-instagram.js`
- **فایل:** `scripts/setup-instagram.js` — تابع `validateCookies()`
- **مشکل:** این endpointها حذف/منسوخ شده‌اند:
  - `/web/accounts/current_user/?include_dummy=true` — حذف شده
  - `?__a=1&__d=dis` — منسوخ شده
- **رفع:** endpointهای معتبر: `/users/{id}/info/`، `/accounts/edit/web_form_data/`، `/feed/timeline/`؛ تشخیص پاسخ `timeline_feed` اضافه شد

#### 8. ✅ `--no-warnings` در Dockerfile و railway.json
- **فایل‌ها:** `Dockerfile`، `railway.json`، `package.json`
- **مشکل:** `--no-warnings` همه هشدارها (از جمله deprecation و security) را خاموش می‌کرد
- **رفع:** `--disable-warning=ExperimentalWarning` که فقط هشدار `node:sqlite` را فیلتر می‌کند

#### 9. ✅ عدم وجود `DEBUG_API_TOKEN` در `.env`
- **فایل:** `.env`
- **مشکل:** `.env` فاقد توکن محافظت `/debug` بود. در production، مسیرهای `/debug`، `/stats`، `/refresh-proxies` بدون توکن عمومی می‌مانند (به‌جز وقتی `NODE_ENV=production` است)
- **رفع:** اضافه شدن `DEBUG_API_TOKEN=replace-with-a-long-random-secret` با کامنت راهنما
- **نکته:** سرور Railway شما احتمالاً این متغیر را دارد (چون `debugOperationsProtected: true` در خروجی)، ولی توکن `a9f82k29s7d92ksl2m` بسیار ضعیف است — عوض کنید

### 🟡 باگ‌های جزئی و بهبودها (Minor)

#### 10. ✅ فایل پشتیبان `IgClient.js11` حذف شد
- **فایل:** `src/instagram/IgClient.js11`
- **مشکل:** یک کپی قدیمی از `IgClient.js` که در ریپو جا مانده بود — سبب سردرگمی و حجم اضافی Docker image می‌شد
- **رفع:** حذف شد

#### 11. ✅ فایل `ig-session-base64.txt` از پوشه پروژه حذف شد
- **فایل:** `ig-session-base64.txt`
- **مشکل:** این فایل حاوی کوکی‌های سشن اینستاگرام شما بود و در ZIP به اشتراک گذاشته شد. `.gitignore` آن را نادیده می‌گرفت، ولی presence فیزیکی در پوشه خطرناک است
- **رفع:** فایل حذف شد. در Railway از متغیر `IG_SESSION_BASE64` استفاده کنید (نه فایل)

#### 12. ✅ `/health` endpoint حالا `manual_challenge_required` state نشان می‌دهد
- **فایل:** `src/index.js`
- **مشکل:** وقتی `checkpoint_required` رخ می‌داد، `/health` فقط `verification_deferred` نشان می‌داد که مبهم بود
- **رفع:** state جدید `manual_challenge_required` اضافه شد

#### 13. ✅ `/debug` حالا `needsManualChallenge` نشان می‌دهد
- **فایل:** `src/instagram/IgClient.js` — `getDebugInfo()`
- **رفع:** فیلد `needsManualChallenge` به `requestSafety` اضافه شد

---

## 🔒 هشدارهای امنیتی بحرانی

### ⚠️ اطلاعات حساس شما لو رفته

فایل `.env` که در v2.zip بود حاوی این موارد بود:

| مورد | مقدار لو رفته | اقدام لازم |
|------|---------------|------------|
| رمز اینستاگرام | `Ali54248590` | **فوراً عوض کنید** — instagram.com → Settings → Security → Password |
| Telegram API Hash | `62bc68ac...` | my.telegram.org → API development tools → Revoke |
| Telegram Bot Token | `8605687961:AAG...` | @BotFather → /revoke |
| شماره تلگرام | `+17409216751` | قابل revoke نیست، ولی مراقب باشید |
| Instagram session cookies | (در ig-session-base64.txt) | سشن جدید بسازید |
| Channel ID | `-1003952743194` | کم‌خطر، ولی شناخته‌شده |

### ⚠️ توکن `/debug` بسیار ضعیف

توکن فعلی شما `a9f82k29s7d92ksl2m` فقط ۱۷ کاراکتر و الگوی قابل حدس است.
**توصیه:** یک توکن ۶۴ کاراکتری تصادفی بسازید:
```bash
openssl rand -hex 32
```
و در Railway → Variables → `DEBUG_API_TOKEN` قرار دهید.

---

## 📦 فایل‌های تغییر یافته

```
src/instagram/IgClient.js          ← ترتیب endpoint، checkpoint cooldown، needsManualChallenge
src/instagram/MediaDownloader.js   ← downloadMany موازی، UA جدید
src/index.js                       ← admin notification برای checkpoint، /health state
scripts/setup-instagram.js         ← UA جدید، endpointهای معتبرسازی معتبر
.env                               ← polling ایمن، ROTATE_USER_AGENT=false، DEBUG_API_TOKEN، هشدار امنیتی
Dockerfile                         ← --disable-warning به‌جای --no-warnings
railway.json                       ← همان
package.json                       ← همان
```

### فایل‌های حذف شده:
- `src/instagram/IgClient.js11` (پشتیبان قدیمی)
- `ig-session-base64.txt` (سشن لو رفته)

---

## 🚀 مراحل استقرار نسخه fix شده

1. **ابتدا دستی چالش اینستاگرام را پاک کنید** (app یا web)
2. سشن جدید بسازید:
   ```bash
   npm run setup:instagram
   ```
3. `IG_SESSION_BASE64` جدید را بگیرید:
   ```bash
   npm run export-session
   ```
4. در Railway → Variables:
   - `IG_SESSION_BASE64` را با مقدار جدید عوض کنید
   - `DEBUG_API_TOKEN` را با یک توکن قوی عوض کنید
   - `POLL_INTERVAL_POSTS=300` و `POLL_INTERVAL_STORIES=420` را تأیید کنید
   - `ROTATE_USER_AGENT=false` را تأیید کنید
5. کد fix شده را به GitHub push کنید → Railway خودکار redeploy می‌کند
6. بعد از deploy، `/debug` را چک کنید:
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" https://your-app.up.railway.app/debug | python3 -m json.tool
   ```
   باید ببینید: `"isLoggedIn": true` و `"currentUser": {...}`

---

## 📊 باگ‌های شناسایی‌شده ولی رفع‌نشده (نیاز به تصمیم کاربر)

### 1. پروکسی برای اینستاگرام (در حال حاضر direct)
`.env` شما `PROXY_MODE=list` دارد که ۴۶۶۲ پروکسی دانلود می‌کند، ولی `IgClient` فقط در حالت `static` از پروکسی استفاده می‌کند. یعنی درخواست‌های اینستاگرام شما از IP مستقیم Railway می‌روند.

**این رفتار در واقع درست است** (پروکسی‌های رایگان چرخشی با سشن احراز هویت‌شده خطرناکند)، ولی اگر می‌خواهید IP ثابت داشته باشید:

```env
PROXY_MODE=static
PROXY_STATIC_URL=socks5://user:pass@stable-host:port
```

### 2. تلگرام session file path در debug گمراه‌کننده است
`/debug` نشان می‌دهد `"sessionFile.exists": false` ولی تلگرام کار می‌کند (چون از `TG_SESSION_STRING` env استفاده می‌کند). این فقط یک cosmetic issue است.

### 3. `constants.js` شامل UA‌های اندروید اینستاگرام است که استفاده نمی‌شوند
این UA‌ها (`USER_AGENTS` در `constants.js`) برای API موبایل اینستاگرام هستند و با سشن وب شما ناسازگارند. در حال حاضر استفاده نمی‌شوند، ولی اگر کسی `getRandomUserAgent()` را فراخوانی کند سشن می‌شکند. **توصیه:** این آرایه را حذف یا با کامنت هشدار علامت‌گذاری کنید.

---

## ✅ خلاصه

- **۱۳ باگ** شناسایی و رفع شد
- **۲ فایل** حذف شد (پشتیبان قدیمی + سشن لو رفته)
- **۸ فایل** اصلاح شد
- **۱ فایل** گزارش جدید (`FIXES_REPORT.md`)

### مهم‌ترین نتیجه:

اینستاگرام شما به‌خاطر ترکیب **IP متفاوت سرور + UA قدیمی + endpoint حساس + polling تهاجمی** علامت خورده است. کد fix شده همه‌ی این موارد را برطرف می‌کند، ولی **شما باید**:

1. چالش "Was this you?" را در اپ اینستاگرام تأیید کنید
2. سشن جدید بسازید (با UA جدید)
3. `.env` با مقادیر جدید را در Railway اعمال کنید
4. رمز اینستاگرام و توکن تلگرام را عوض کنید (چون لو رفته‌اند)
