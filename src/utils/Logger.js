/**
 * utils/Logger.js
 * سیستم لاگینگ ساختاریافته با pino
 */

import pino from 'pino';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import config from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

/**
 * تعیین transport بر اساس محیط
 */
const buildLogger = () => {
  const level = config.logging.level || 'info';
  const isDev = !config.app.isProduction;

  // In production: only file (avoids stdout JSON noise)
  // In dev: pretty console + file
  if (config.logging.toFile) {
    const logFilePath = resolve(projectRoot, config.logging.file || './data/app.log');
    const logDir = dirname(logFilePath);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const fileStream = createWriteStream(logFilePath, { flags: 'a' });

    if (isDev) {
      // Multi-stream: pretty console + JSON file
      return pino(
        { level },
        pino.multistream([
          { stream: pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }) },
          { stream: fileStream },
        ])
      );
    }

    return pino({ level }, fileStream);
  }

  // No file logging
  if (isDev) {
    return pino(
      { level },
      pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } })
    );
  }

  return pino({ level });
};

const logger = buildLogger();

/**
 * Loggerهای تخصصی برای ماژول‌های مختلف
 */
export const igLogger = logger.child({ module: 'Instagram' });
export const tgLogger = logger.child({ module: 'Telegram' });
export const proxyLogger = logger.child({ module: 'Proxy' });
export const workerLogger = logger.child({ module: 'Worker' });
export const dbLogger = logger.child({ module: 'Database' });
export const appLogger = logger.child({ module: 'App' });

export default logger;
