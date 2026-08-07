/**
 * telegram/TgClient.js
 * کلاینت تلگرام با استفاده از teleproto (fork فعال GramJS)
 */

import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { PromisedWebSockets } from 'teleproto/network';
import { log } from '../utils/Logger.js';
import config from '../config/env.js';

class TgClient {
  constructor() {
    this.client = null;
    this.sessionString = process.env.TG_SESSION || '';
    this._autoFoundProxy = null;
  }

  /**
   * Initialize
   */
  async init() {
    const session = new StringSession(this.sessionString || '');

    let proxyConfig = null;
    if (this._autoFoundProxy?.teleprotoConfig) {
      proxyConfig = this._autoFoundProxy.teleprotoConfig;
      log.info({
        msg: 'Using auto-found proxy for Telegram client',
        host: proxyConfig.ip,
        port: proxyConfig.port,
      });
    } else {
      proxyConfig = this._buildProxyConfig();
    }

    this.client = new TelegramClient(
      session,
      parseInt(config.telegram.apiId, 10),
      config.telegram.apiHash,
      {
        networkSocket: PromisedWebSockets,
        connectionRetries: 10,
        retryDelay: 2000,
        autoReconnect: true,
        floodSleepThreshold: 60,
        deviceModel: 'IG Monitor Bot',
        systemVersion: '1.0.0',
        appVersion: '1.0.0',
        langCode: 'en',
        systemLangCode: 'en',
        ...(proxyConfig ? { proxy: proxyConfig } : {}),
      }
    );

    log.info({
      msg: 'Telegram client initialized (WSS transport)',
      hasSession: !!this.sessionString,
      layer: '228+ (teleproto)',
      transport: 'WSS (PromisedWebSockets)',
      hasProxy: !!proxyConfig,
      proxyType: proxyConfig ? (proxyConfig.socksType === 5 ? 'SOCKS5' : (proxyConfig.MTProxy ? 'MTProxy' : 'SOCKS4')) : 'none',
    });
  }

  isReady() {
    return this.client && this.client.connected;
  }

  async resolveChannel() {
    return await this.client.getEntity(config.telegram.channelId);
  }

  /**
   * Send a text message
   */
  async sendMessage(text, options = {}) {
    const entity = await this.resolveChannel();
    try {
      const result = await this.client.sendMessage(entity, {
        message: text,
        parseMode: 'html',
        linkPreview: options.linkPreview ?? false,
        ...options,
      });
      return {
        id: result.id,
        chatId: result.chatId?.toString?.() || result.peerId?.toString?.() || null,
      };
    } catch (e) {
      log.error({ msg: 'sendMessage failed', error: e.message, textPreview: text?.slice(0, 100) });
      throw e;
    }
  }

  /**
   * Send a message with raw entities (برای expandable blockquote)
   */
  async sendMessageWithEntities(text, entities = [], options = {}) {
    const entity = await this.resolveChannel();
    try {
      const result = await this.client.invoke(
        new Api.messages.SendMessage({
          peer: entity,
          message: text,
          entities: entities,
          noWebpage: !options.linkPreview,
          replyTo: options.replyTo || undefined,
        })
      );

      let msgId = null;
      if (result?.updates?.Updates) {
        const msgs = result.updates.Updates.filter(u => u.className === 'UpdateNewMessage' || u.className === 'UpdateNewChannelMessage');
        if (msgs.length > 0) msgId = msgs[0].message?.id;
      }
      return { id: msgId, chatId: entity.id?.toString?.() || null };
    } catch (e) {
      log.error({ msg: 'sendMessageWithEntities failed', error: e.message });
      throw e;
    }
  }

  /**
   * Send a file (photo/video/document)
   */
  async sendFile(filePath, options = {}) {
    const entity = await this.resolveChannel();
    const sendOptions = {};

    if (options.entities) {
      sendOptions.caption = options.caption || '';
      sendOptions.formattingEntities = options.entities;
      sendOptions.parseMode = undefined;
    } else {
      sendOptions.parseMode = 'html';
      sendOptions.caption = options.caption || '';
    }

    if (options.asPhoto) sendOptions.forceDocument = false;
    else if (options.asDocument) sendOptions.forceDocument = true;
    if (options.spoiler) sendOptions.spoiler = true;
    if (options.ttl) sendOptions.ttl = options.ttl;

    delete sendOptions.entities;
    delete sendOptions.asPhoto;
    delete sendOptions.asDocument;

    const result = await this.client.sendFile(entity, { file: filePath, ...sendOptions });
    return {
      id: result.id,
      chatId: result.chatId?.toString?.() || result.peerId?.toString?.() || null,
    };
  }

  /**
   * Send an album (multiple photos/videos in one message)
   * FIX: دور زدن باگ‌های teleproto با استفاده از EditMessage برای اعمال Entities
   */
  async sendAlbum(filePaths, options = {}) {
    const entity = await this.resolveChannel();
    if (!filePaths || filePaths.length === 0) throw new Error('No files to send');

    const results = [];
    const batches = [];
    for (let i = 0; i < filePaths.length; i += 10) {
      batches.push(filePaths.slice(i, i + 10));
    }

    for (const batch of batches) {
      const sendOpts = {};
      sendOpts.caption = options.caption || '';
      sendOpts.forceDocument = options.forceDocument ?? false;

      const cleanOpts = { ...sendOpts };
      // حذف پارامترهایی که باعث کرش شدن SendMultiMedia در teleproto میشن
      delete cleanOpts.entities;
      delete cleanOpts.formattingEntities;
      delete cleanOpts.parseMode;
      delete cleanOpts.asPhoto;
      delete cleanOpts.asDocument;

      // ارسال آلبوم به صورت خام
      const result = await this.client.sendFile(entity, {
        file: batch,
        ...cleanOpts,
      });

      let firstMsgId = null;
      if (Array.isArray(result)) {
        for (const r of result) {
          results.push({ id: r.id, chatId: r.chatId?.toString?.() || r.peerId?.toString?.() || null });
        }
        firstMsgId = result[0]?.id;
      } else {
        results.push({ id: result.id, chatId: result.chatId?.toString?.() || result.peerId?.toString?.() || null });
        firstMsgId = result?.id;
      }

      // ── FIX: اعمال Entities با EditMessage روی اولین پیام آلبوم ──
      if (firstMsgId && options.entities && options.entities.length > 0) {
        try {
          await this.client.invoke(
            new Api.messages.EditMessage({
              peer: entity,
              id: firstMsgId,
              message: options.caption || '',
              entities: options.entities,
            })
          );
        } catch (editErr) {
          log.warn({ msg: 'Could not edit album caption with entities', error: editErr.message });
        }
      }
    }

    return results;
  }
  
  // ... (تابع _buildProxyConfig و سایر توابع اتصال خودت را اینجا بدون تغییر حفظ کن) ...
  _buildProxyConfig() {
    // ... کد اصلی شما ...
  }
}

export default new TgClient();