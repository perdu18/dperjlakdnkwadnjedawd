FROM node:22-slim

# نصب وابستگی‌های سیستم برای Playwright Chromium
# (Playwright به این کتابخانه‌ها نیاز داره تا Chromium رو اجرا کنه)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    # Playwright Chromium dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# کپی package files و نصب dependencies
COPY package*.json ./
RUN npm install --omit=dev

# کپی فایل‌های پروژه
COPY . .

# ساخت دایرکتوری‌های لازم
RUN mkdir -p data/ig-sessions data/tg-session data/proxies data/media

# Note: Railway Volume در railway.json تعریف شده (نه در Dockerfile)

# Health check (با start-period طولانی برای زمان init سرویس‌ها)
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

EXPOSE ${PORT:-3000}

# --no-warnings برای حذف SQLite experimental warning
# --enable-source-maps برای stack traces بهتر
CMD ["node", "--no-warnings", "--enable-source-maps", "src/index.js"]
