/**
 * instagram/MediaDownloader.js
 * دانلود مدیا از اینستاگرام با axios + cookies (بدون Playwright)
 *
 * URLهای مدیای اینستاگرام نیاز به session cookies دارن.
 * این کلاس از همون session استفاده می‌کنه که IgClient داره.
 */

import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';

import config from '../config/env.js';
import { igLogger as log } from '../utils/Logger.js';
import { downloadFile, safeDelete, getFileSize, generateUniqueFilename, detectFileType } from '../utils/FileUtils.js';
import { formatBytes } from '../utils/Helpers.js';
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
   * دانلود یک فایل از URL با session cookies
   */
  async download(url, options = {}) {
    const { filename = null, retries = 3 } = options;

    if (!url) {
      throw new Error('No URL provided');
    }

    this.activeDownloads++;
    try {
      let lastError = null;

      for (let attempt = 1; attempt <= retries; attempt++) {
        const safeFilename = filename || generateUniqueFilename('ig', 'bin');
        const destDir = this.mediaDir;

        try {
          // Build headers with session cookies
          const headers = {};

          if (igClient.session?.cookies) {
            const cookieStr = Object.entries(igClient.session.cookies)
              .map(([k, v]) => `${k}=${v}`)
              .join('; ');
            headers['Cookie'] = cookieStr;
            headers['X-CSRFToken'] = igClient.session.cookies.csrftoken;
          }

          headers['User-Agent'] = igClient.session?.userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
          headers['Referer'] = 'https://www.instagram.com/';
          headers['Accept'] = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
          headers['Accept-Language'] = 'en-US,en;q=0.9';

          const result = await downloadFile(url, {
            timeout: this.timeout,
            destDir,
            filename: safeFilename,
            headers,
          });

          const detected = await detectFileType(result.path);
          const finalExt = detected?.ext || 'bin';
          const finalMime = detected?.mime || result.contentType;

          // Rename if extension is wrong
          let finalPath = result.path;
          if (!safeFilename.endsWith(`.${finalExt}`)) {
            const newPath = result.path.replace(/\.[^.]+$/, `.${finalExt}`);
            const { renameSync } = await import('fs');
            try {
              renameSync(result.path, newPath);
              finalPath = newPath;
            } catch {}
          }

          const size = getFileSize(finalPath);

          // Sanity check
          if (size < 1024) {
            const { readFileSync } = await import('fs');
            const content = readFileSync(finalPath, 'utf8').slice(0, 200);
            safeDelete(finalPath);
            throw new Error(`File too small (${size} bytes). Content: ${content}`);
          }

          log.debug({
            msg: 'Downloaded media',
            url: url.slice(0, 80),
            path: finalPath,
            size: formatBytes(size),
            attempt,
          });

          return {
            path: finalPath,
            size,
            mime: finalMime,
            ext: finalExt,
          };
        } catch (e) {
          lastError = e;
          log.warn({
            msg: 'Download attempt failed',
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

      throw new Error(`Download failed after ${retries} attempts: ${lastError?.message || 'Unknown error'}`);
    } finally {
      this.activeDownloads--;
    }
  }

  /**
   * دانلود چند فایل همزمان
   */
  async downloadMany(urls, options = {}) {
    const results = [];
    const errors = [];

    for (let i = 0; i < urls.length; i++) {
      try {
        const result = await this.download(urls[i], options);
        results[i] = result;
      } catch (e) {
        errors.push({ index: i, url: urls[i], error: e.message });
      }
    }

    return { results: results.filter(Boolean), errors };
  }

  /**
   * دانلود پست
   */
  async downloadPost(post) {
    const { mediaUrls, carouselItems, type, pk } = post;

    log.info({
      msg: 'Downloading post media',
      postPk: pk,
      type,
      urlCount: mediaUrls?.length || 0,
    });

    if (type === 'carousel' && carouselItems?.length > 0) {
      const urls = carouselItems.map(item => item.url).filter(Boolean);
      const { results, errors } = await this.downloadMany(urls);

      if (errors.length > 0) {
        log.warn({ msg: 'Some carousel items failed', errors: errors.length });
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

  getActiveCount() {
    return this.activeDownloads;
  }
}

const mediaDownloader = new MediaDownloader();
export default mediaDownloader;
