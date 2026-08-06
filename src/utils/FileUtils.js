/**
 * utils/FileUtils.js
 * توابع کمکی برای کار با فایل‌ها
 */

import { createWriteStream, createReadStream, statSync, unlinkSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, extname, basename, dirname } from 'path';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { fileTypeFromBuffer } from 'file-type';
import { appLogger as log } from './Logger.js';

/**
 * دانلود فایل از URL با پشتیبانی از proxy و progress
 */
export const downloadFile = async (url, options = {}) => {
  const {
    timeout = 60000,
    destDir = tmpdir(),
    filename = null,
    headers = {},
    proxyAgent = null,
    onProgress = null,
  } = options;

  // Ensure destDir exists
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  // Generate filename if not provided
  const safeFilename = filename || `download-${randomUUID()}.bin`;
  const filePath = join(destDir, safeFilename);

  log.debug({ msg: 'Starting download', url, filePath });

  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      ...headers,
    },
    httpsAgent: proxyAgent,
    httpAgent: proxyAgent,
    maxRedirects: 5,
  });

  const totalSize = parseInt(response.headers['content-length'] || '0', 10);
  let downloadedSize = 0;
  let lastProgress = 0;

  const writer = createWriteStream(filePath);

  response.data.on('data', (chunk) => {
    downloadedSize += chunk.length;
    if (onProgress && totalSize > 0) {
      const now = Date.now();
      if (now - lastProgress > 500) {  // Update progress every 500ms
        lastProgress = now;
        onProgress({
          downloaded: downloadedSize,
          total: totalSize,
          percent: (downloadedSize / totalSize) * 100,
        });
      }
    }
  });

  await pipeline(response.data, writer);

  const stats = statSync(filePath);
  log.debug({
    msg: 'Download complete',
    url,
    filePath,
    size: stats.size,
  });

  return {
    path: filePath,
    size: stats.size,
    contentType: response.headers['content-type'],
  };
};

/**
 * تشخیص نوع فایل از بافر
 */
export const detectFileType = async (filePath) => {
  try {
    const buffer = Buffer.alloc(4100);
    const stream = createReadStream(filePath, { start: 0, end: 4100 });
    const { once } = await import('events');
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    await once(stream, 'end');
    Buffer.concat(chunks).copy(buffer);
    const type = await fileTypeFromBuffer(buffer);
    return type;
  } catch (e) {
    log.warn({ msg: 'Could not detect file type', filePath, error: e.message });
    return null;
  }
};

/**
 * حذف امن فایل
 */
export const safeDelete = (filePath) => {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      log.debug({ msg: 'File deleted', filePath });
    }
  } catch (e) {
    log.warn({ msg: 'Could not delete file', filePath, error: e.message });
  }
};

/**
 * دریافت اندازه فایل
 */
export const getFileSize = (filePath) => {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
};

/**
 * بررسی وجود فایل
 */
export const fileExists = (filePath) => {
  return existsSync(filePath);
};

/**
 * ساختن نام فایل امن
 */
export const sanitizeFilename = (name) => {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
};

/**
 * ساخت نام فایل یکتا
 */
export const generateUniqueFilename = (prefix = 'media', ext = 'bin') => {
  const uuid = randomUUID();
  const ts = Date.now();
  return `${prefix}_${ts}_${uuid.slice(0, 8)}.${ext.replace(/^\./, '')}`;
};

/**
 * پاکسازی دایرکتوری از فایل‌های قدیمی
 */
export const cleanupOldFiles = (dir, maxAgeMs) => {
  try {
    if (!existsSync(dir)) return;
    const { readdirSync } = await_readdirSync_import();
    const files = readdirSync(dir);
    const now = Date.now();
    let cleaned = 0;

    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const stats = statSync(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
          cleaned++;
        }
      } catch {}
    }

    if (cleaned > 0) {
      log.debug({ msg: 'Cleaned up old files', dir, count: cleaned });
    }
  } catch (e) {
    log.warn({ msg: 'Cleanup failed', dir, error: e.message });
  }
};

// helper for dynamic import (since we can't use top-level await in some setups)
const await_readdirSync_import = async () => {
  return await import('fs');
};

export default {
  downloadFile,
  detectFileType,
  safeDelete,
  getFileSize,
  fileExists,
  sanitizeFilename,
  generateUniqueFilename,
  cleanupOldFiles,
};
