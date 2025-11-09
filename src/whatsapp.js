
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const QRCode = require('qrcode');
const mime = require('mime-types');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const DATA_DIR = process.env.WWEBJS_STORE || '/app/data/wwebjs';
const CLIENT_ID = process.env.WWEBJS_CLIENT_ID || 'whatsapp-bot';
const MEDIA_DIR = process.env.MEDIA_DIR || '/app/data/media';
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

for (const p of [DATA_DIR, MEDIA_DIR, path.dirname(MEDIA_DIR)]) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

const bus = new EventEmitter();

let lastQR = null;
let lastState = 'INITIALIZING';
let isReady = false;

let client = null;
let keepAliveTimer = null;

function ensureExtByMime(mimetype) {
  const ext = mime.extension(mimetype || '') || 'bin';
  return `.${ext}`;
}

function sanitizeJid(to) {
  if (!to) return null;
  let t = String(to).trim();
  if (/^\d+$/.test(t)) return `${t}@c.us`;
  if (!/@[cg]\.us$/.test(t)) {
    const onlyDigits = t.replace(/\D+/g, '');
    if (onlyDigits) return `${onlyDigits}@c.us`;
  }
  return t;
}

async function resolveJid(to) {
  const c = await getClient();
  if (!to) return null;
  let t = String(to).trim();

  if (/@g\.us$/.test(t)) return t; // group
  if (/@lid$/.test(t)) return t;   // already lid

  let num = t.replace(/@c\.us$/, '');
  const onlyDigits = num.replace(/\D+/g, '');
  if (!onlyDigits) return null;

  const info = await c.getNumberId(onlyDigits);
  if (!info) throw new Error('Número não está no WhatsApp');
  return info._serialized || `${info.user}@${info.server}`;
}

function buildClient() {
  const authStrategy = new LocalAuth({
    clientId: CLIENT_ID,
    dataPath: DATA_DIR,
  });

  const puppeteerConf = {
    executablePath: PUPPETEER_EXECUTABLE_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-features=site-per-process',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync'
    ],
  };

  const c = new Client({
    authStrategy,
    puppeteer: puppeteerConf,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 3 * 60 * 1000,
    qrMaxRetries: 0,
    restartOnAuthFail: true,
  });

  c.on('qr', async (qr) => {
    try {
      lastQR = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
      bus.emit('qr', lastQR);
      bus.emit('log', `[QR] Novo QR gerado. Escaneie com o WhatsApp (inclui WhatsApp Business).`);
    } catch (e) {
      bus.emit('log', `[QR] Falha ao gerar QR: ${e?.message || e}`);
    }
  });

  c.on('loading_screen', (percent, message) => {
    bus.emit('log', `[LOAD] ${percent}% - ${message}`);
  });

  c.on('change_state', (state) => {
    lastState = state || 'UNKNOWN';
    bus.emit('state', lastState);
    bus.emit('log', `[STATE] ${lastState}`);
  });

  c.on('authenticated', () => {
    bus.emit('log', '[AUTH] Autenticado.');
  });

  c.on('ready', () => {
    isReady = true;
    lastQR = null;
    bus.emit('ready');
    bus.emit('log', '[READY] Cliente pronto e conectado.');
  });

  function buildRecord(msg, savedMedia=null) {
    const base = {
      id: msg.id?._serialized || msg.id?.id || null,
      from: msg.from,
      to: msg.to,
      body: msg.body || null,
      type: msg.type,
      timestamp: msg.timestamp ? (msg.timestamp * 1000) : Date.now(),
      fromMe: !!msg.fromMe,
      author: msg.author || null,
      chatId: msg.chatId || (msg.fromMe ? msg.to : msg.from),
      hasMedia: !!savedMedia,
      media: savedMedia,
      ack: msg.ack,
      isStatus: msg.isStatus || false,
    };
    return base;
  }

  c.on('message', async (msg) => {
    try {
      let savedMedia = null;
      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const ext = ensureExtByMime(media.mimetype);
          const file = `${Date.now()}_${msg.id.id}${ext}`;
          const full = path.join(MEDIA_DIR, file);
          fs.writeFileSync(full, Buffer.from(media.data, 'base64'));
          savedMedia = { file, mimetype: media.mimetype, size: Buffer.from(media.data, 'base64').length, dataURL: `data:${media.mimetype};base64,${media.data}` };
        }
      }
      const record = buildRecord(msg, savedMedia);
      bus.emit('message', record);
    } catch(e) {
      bus.emit('log', `[MSG ERROR] ${e?.message || e}`);
    }
  });

  c.on('message_create', async (msg) => {
    try {
      let savedMedia = null;
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            savedMedia = { mimetype: media.mimetype, dataURL: `data:${media.mimetype};base64,${media.data}` }; // não guardar base64
          }
        } catch {}
      }
      const record = buildRecord(msg, savedMedia);
      bus.emit('message', record);
    } catch (e) {
      bus.emit('log', `[MSG_CREATE ERROR] ${e?.message || e}`);
    }
  });

  c.on('message_ack', (msg, ack) => {
    const id = msg?.id?._serialized || msg?.id?.id;
    bus.emit('message_ack', { id, ack });
  });

  c.on('disconnected', (reason) => {
    isReady = false;
    lastState = 'DISCONNECTED';
    bus.emit('state', lastState);
    bus.emit('log', `[DISCONNECTED] Motivo: ${reason}. Tentando reconectar em 5s...`);
    setTimeout(() => {
      try {
        c.initialize();
      } catch (e) {
        bus.emit('log', `[REINIT ERROR] ${e?.message || e}`);
      }
    }, 5000);
  });

  return c;
}

function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(async () => {
    try {
      if (!client) return;
      const state = await client.getState().catch(() => null);
      if (state) {
        lastState = state;
        bus.emit('state', state);
      }
    } catch (e) {
      bus.emit('log', `[KEEPALIVE ERROR] ${e?.message || e}`);
    }
  }, 45000);
}

async function getClient() {
  if (client) return client;
  client = buildClient();
  client.initialize().catch((e) => {
    bus.emit('log', `[INIT ERROR] ${e?.message || e}`);
  });
  startKeepAlive();
  return client;
}

function getLastQR() {
  return lastQR;
}

function getLastState() {
  return { state: lastState, ready: isReady };
}

function emitSent(res, to, body, mimetype=null) {
  try {
    const now = Date.now();
    const msg = {
      id: (res && (res.id?._serialized || res.id?.id)) || ('sent_' + now),
      from: res?.from || undefined,
      to: to,
      body: body || null,
      type: mimetype ? 'media' : 'chat',
      timestamp: now,
      fromMe: true,
      author: null,
      chatId: to,
      hasMedia: !!mimetype,
      media: mimetype ? { mimetype } : null,
      ack: 0,
      isStatus: false,
    };
    bus.emit('message', msg);
  } catch {}
}

// --------- High-level APIs ---------
async function listChatsSummary() {
  const c = await getClient();
  const chats = await c.getChats();
  const data = await Promise.all(chats.map(async (ch) => {
    let title = ch.name || ch.formattedTitle || '';
    if (!title && ch.id && ch.id.user) title = ch.id.user;

    let lastMsg = null;
    try {
      const msgs = await ch.fetchMessages({ limit: 1 });
      if (msgs && msgs.length) lastMsg = msgs[0];
    } catch {}
    const unread = ch.unreadCount || 0;
    return {
      id: ch.id?._serialized || ch.id,
      name: title,
      isGroup: ch.isGroup || false,
      unread,
      lastMessage: lastMsg ? {
        id: lastMsg.id?._serialized || lastMsg.id?.id,
        body: lastMsg.body || null,
        type: lastMsg.type,
        timestamp: lastMsg.timestamp ? (lastMsg.timestamp*1000) : Date.now(),
        fromMe: lastMsg.fromMe || false
      } : null
    };
  }));
  return data.sort((a,b)=> (b?.lastMessage?.timestamp||0) - (a?.lastMessage?.timestamp||0));
}

async function fetchChatMessages(chatId, limit = 50, beforeId = null) {
  const c = await getClient();
  const ch = await c.getChatById(chatId);
  const opts = { limit: Math.max(1, Math.min(200, Number(limit)||50)) };
  if (beforeId) opts.before = beforeId;
  const msgs = await ch.fetchMessages(opts);
  return Promise.all(msgs.map(async (m) => {
    let mediaMeta = null;
    if (m.hasMedia) {
      try {
        const media = await m.downloadMedia();
        if (media && media.data) {
          mediaMeta = {
            mimetype: media.mimetype,
            dataURL: `data:${media.mimetype};base64,${media.data}`,
          };
        }
      } catch {}
    }
    return {
      id: m.id?._serialized || m.id?.id,
      from: m.from,
      to: m.to,
      body: m.body || null,
      type: m.type,
      timestamp: m.timestamp ? (m.timestamp*1000) : Date.now(),
      fromMe: m.fromMe || false,
      author: m.author || null,
      chatId: m.chatId || chatId,
      hasMedia: !!mediaMeta,
      media: mediaMeta,
      ack: m.ack,
    };
  }));
}

async function sendText(to, body) {
  const c = await getClient();
  const jid = await resolveJid(to);
  if (!jid) throw new Error('destinatário inválido');
  const res = await c.sendMessage(jid, String(body || ''));
  emitSent(res, jid, String(body || ''));
  return { id: res.id?._serialized || res.id?.id, to: jid };
}

async function sendBase64Media(to, base64, mimetype, caption='') {
  const c = await getClient();
  const jid = await resolveJid(to);
  if (!jid) throw new Error('destinatário inválido');
  const media = new MessageMedia(mimetype, base64, `upload${ensureExtByMime(mimetype)}`);
  const res = await c.sendMessage(jid, media, { caption });
  emitSent(res, jid, caption || '', mimetype);
  return { id: res.id?._serialized || res.id?.id, to: jid };
}

async function waitReady(timeoutMs = 60000) {
  await getClient();
  if (isReady) return true;
  return await new Promise((resolve) => {
    const t = setTimeout(() => {
      bus.off('ready', onReady);
      resolve(false);
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(t);
      resolve(true);
    };
    bus.on('ready', onReady);
  });
}

module.exports = {
  getClient,
  getLastQR,
  getLastState,
  waitReady,
  listChatsSummary,
  fetchChatMessages,
  sendText,
  sendBase64Media,
  bus,
  MEDIA_DIR,
};
