/**
 * instagram/MediaDownloader.js
 * دانلود مدیا از اینستاگرام
 *
 * مشکل:
 *   URLهای مدیای اینستاگرام (display_url، video_url) نیاز به session معتبر دارن
 *   و با axios ساده 401/403 میدن.
 *
 * راه‌حل:
 *   ۱. اول تلاش می‌کنیم با axios + cookies (سریع)
 *   ۲. اگه شکست خورد، از Playwright استفاده می‌کنیم (مطمئن ولی کندتر)
 *
 * این کلاس با IgClient هماهنگ شده و از session همون استفاده می‌کنه.
 */

import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import axios from 'axios';

import config from '../config/env.js';
import { igLogger as log } from '../utils/Logger.js';
import { downloadFile, safeDelete, getFileSize, generateUniqueFilename, detectFileType } from '../utils/FileUtils.js';
import { formatBytes } from '../utils/Helpers.js';
import proxyManager from '../proxy/ProxyManager.js';
import igClient from './IgClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

class MediaDownloader {
  constructor() {
    this.mediaDir = resolve(projectRoot, config.storage.mediaDir);
    if (!existsSync(this.mediaDir)) {
      mkdirSync(this.mediaDir, { recursive: true });
    }
    this.maxConcurrent = config.workers.maxConcurrentDownloads;
    this.timeout = config.workers.downloadTimeout;
    this.activeDownloads = 0;
  }

  /**
   * دانلود یک فایل از URL
   *
   * روش‌ها به ترتیب:
   *   1. axios با cookies از session
   *   2. Playwright (fetch از صفحه ای که session داره)
   */
  async download(url, options = {}) {
    const { filename = null, retries = 3 } = options;

    if (!url) {
      throw new Error('No URL provided');
    }

    this.activeDownloads++;
    try {
      // Method 1: axios with cookies (fast)
      try {
        const result = await this._downloadWithAxios(url, filename);
        log.debug({ msg: 'Downloaded via axios', url: url.slice(0, 80), size: formatBytes(result.size) });
        return result;
      } catch (axiosError) {
        log.debug({
          msg: 'axios download failed, will try Playwright',
          url: url.slice(0, 80),
          error: axiosError.message,
        });
      }

      // Method 2: Playwright (reliable, but slower)
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const result = await this._downloadWithPlaywright(url, filename);
          log.debug({
            msg: 'Downloaded via Playwright',
            url: url.slice(0, 80),
            size: formatBytes(result.size),
            attempt,
          });
          return result;
        } catch (e) {
          log.warn({
            msg: 'Playwright download attempt failed',
            attempt,
            of: retries,
            error: e.message,
            url: url.slice(0, 80),
          });
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 2000 * attempt));
          }
        }
      }

      throw new Error(`Download failed after ${retries} attempts via Playwright`);
    } finally {
      this.activeDownloads--;
    }
  }

  /**
   * Download with axios + session cookies
   */
  async _downloadWithAxios(url, filename) {
    if (!igClient.session?.cookies) {
      throw new Error('No IG session available');
    }

    const cookies = igClient.session.cookies;
    const cookieStr = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const safeFilename = filename || generateUniqueFilename('ig', 'bin');
    const destDir = this.mediaDir;

    // Build headers matching the session's browser
    const headers = {
      'User-Agent': igClient.session.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Cookie': cookieStr,
      'Referer': 'https://www.instagram.com/',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    };

    // Try with proxy if configured as static
    let agent = null;
    if (igClient.stickyProxy) {
      agent = igClient._createProxyAgent(igClient.stickyProxy);
    }

    const result = await downloadFile(url, {
      timeout: this.timeout,
      destDir,
      filename: safeFilename,
      proxyAgent: agent,
      headers,
    });

    const detected = await detectFileType(result.path);
    const finalExt = detected?.ext || 'bin';
    const finalMime = detected?.mime || result.contentType;

    // Rename if extension is wrong
    if (!safeFilename.endsWith(`.${finalExt}`)) {
      const newPath = result.path.replace(/\.[^.]+$/, `.${finalExt}`);
      const { renameSync } = await import('fs');
      try {
        renameSync(result.path, newPath);
        result.path = newPath;
      } catch {}
    }

    const size = getFileSize(result.path);

    // Sanity check - file should be > 1KB
    if (size < 1024) {
      // Probably an error page
      const { readFileSync } = await import('fs');
      const content = readFileSync(result.path, 'utf8').slice(0, 200);
      safeDelete(result.path);
      throw new Error(`Downloaded file is too small (${size} bytes). Content: ${content}`);
    }

    return {
      path: result.path,
      size,
      mime: finalMime,
      ext: finalExt,
    };
  }

  /**
   * Download with Playwright
   *
   * از مرورگر Playwright (که session داره) استفاده می‌کنه تا فایل رو fetch کنه.
   * این روش برای URLهایی که نیاز به authentication دارن کار می‌کنه.
   */
  async _downloadWithPlaywright(url, filename) {
    if (!igClient.session?.cookies) {
      throw new Error('No IG session available for Playwright download');
    }

    const { context } = await igClient._getBrowser();
    const page = await context.newPage();

    try {
      const safeFilename = filename || generateUniqueFilename('ig', 'bin');
      const destPath = join(this.mediaDir, safeFilename);

      // Use Playwright's request API which respects context cookies
      const response = await page.request.get(url, {
        timeout: this.timeout,
        headers: {
          'Referer': 'https://www.instagram.com/',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
        failOnStatusCode: false,
      });

      if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
      }

      const buffer = await response.body();

      if (!buffer || buffer.length < 1024) {
        throw new Error(`Response too small: ${buffer?.length || 0} bytes`);
      }

      // Write to file
      const { writeFileSync } = await import('fs');
      writeFileSync(destPath, buffer);

      // Detect file type
      const detected = await detectFileType(destPath);
      const finalExt = detected?.ext || 'bin';
      const finalMime = detected?.mime || response.headers()['content-type'];

      // Rename if extension is wrong
      if (!safeFilename.endsWith(`.${finalExt}`)) {
        const newPath = destPath.replace(/\.[^.]+$/, `.${finalExt}`);
        const { renameSync } = await import('fs');
        try {
          renameSync(destPath, newPath);
          destPath.replace(destPath, newPath);
        } catch {}
        // Note: variable rename for clarity
        var finalPath = destPath.replace(/\.[^.]+$/, `.${finalExt}`);
        try {
          renameSync(destPath, finalPath);
        } catch {
          finalPath = destPath;
        }
      } else {
        var finalPath = destPath;
      }

      const size = getFileSize(finalPath);

      return {
        path: finalPath,
        size,
        mime: finalMime,
        ext: finalExt,
      };
    } finally {
      try { await page.close(); } catch {}
      igClient.browserLastActivity = Date.now();
    }
  }

  /**
   * دانلود چند فایل همزمان
   */
  async downloadMany(urls, options = {}) {
    const results = [];
    const errors = [];

    const queue = [...urls.map((url, i) => ({ url, index: i }))];
    const running = [];

    const startDownload = async (item) => {
      try {
        const result = await this.download(item.url, options);
        results[item.index] = result;
      } catch (e) {
        errors.push({ index: item.index, url: item.url, error: e.message });
      }
    };

    while (queue.length > 0 || running.length > 0) {
      while (queue.length > 0 && running.length < this.maxConcurrent) {
        const item = queue.shift();
        const p = startDownload(item);
        running.push(p);
        p.finally(() => {
          const idx = running.indexOf(p);
          if (idx >= 0) running.splice(idx, 1);
        });
      }
      if (running.length > 0) {
        await Promise.race(running);
      }
    }

    return { results: results.filter(Boolean), errors };
  }

  /**
   * دانلود پست (ممکنه چند فایل باشه برای carousel)
   */
  async downloadPost(post) {
    const { mediaUrls, carouselItems, type, pk } = post;

    log.info({
      msg: 'Downloading post media',
      postPk: pk,
      type,
      urlCount: mediaUrls?.length || 0,
      carouselCount: carouselItems?.length || 0,
    });

    if (type === 'carousel' && carouselItems?.length > 0) {
      const urls = carouselItems.map(item => item.url).filter(Boolean);
      log.debug({ msg: 'Downloading carousel', items: urls.length, postPk: pk });

      const { results, errors } = await this.downloadMany(urls);

      if (errors.length > 0) {
        log.warn({
          msg: 'Some carousel items failed to download',
          errors: errors.length,
          details: errors,
        });
      }

      if (results.length === 0) {
        throw new Error(`All carousel downloads failed: ${errors[0]?.error || 'unknown'}`);
      }

      return {
        type: 'carousel',
        items: results,
        allSucceeded: errors.length === 0,
      };
    }

    if (!mediaUrls || mediaUrls.length === 0) {
      throw new Error('No media URLs to download');
    }

    const result = await this.download(mediaUrls[0]);
    return {
      type: type,
      items: [result],
      allSucceeded: true,
    };
  }

  /**
   * دانلود استوری
   */
  async downloadStory(story) {
    if (!story.mediaUrl) {
      throw new Error('Story has no media URL');
    }

    log.info({
      msg: 'Downloading story media',
      storyPk: story.pk,
      type: story.subtype,
    });

    const result = await this.download(story.mediaUrl);
    return {
      type: 'story',
      subtype: story.subtype,
      items: [result],
      allSucceeded: true,
    };
  }

  /**
   * حذف فایل‌های دانلود شده
   */
  cleanup(downloadResult) {
    if (!downloadResult?.items) return;
    for (const item of downloadResult.items) {
      if (item?.path) {
        safeDelete(item.path);
      }
    }
  }

  /**
   * Get active download count
   */
  getActiveCount() {
    return this.activeDownloads;
  }
}

const mediaDownloader = new MediaDownloader();
export default mediaDownloader;
