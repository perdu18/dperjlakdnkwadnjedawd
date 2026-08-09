FROM node:22-slim

# نصب ca-certificates و curl برای health check
# (دیگر نیازی به کتابخانه‌های Playwright Chromium نداریم)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# کپی package files و نصب dependencies
COPY package*.json ./
RUN npm install --omit=dev

# کپی فایل‌های پروژه
COPY . .

# ساخت دایرکتوری‌های لازم
RUN mkdir -p data/ig-sessions data/tg-session data/proxies data/media

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

EXPOSE ${PORT:-3000}

# FIX(docker): --no-warnings همه هشدارها را خاموش می‌کند. به‌جای آن فقط
# ExperimentalWarning مربوط به node:sqlite را فیلتر می‌کنیم تا هشدارهای مفید
# (deprecation، security و غیره) همچنان نمایش داده شوند.
CMD ["node", "--disable-warning=ExperimentalWarning", "--enable-source-maps", "src/index.js"]
