const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { Client, LocalAuth } = require('whatsapp-web.js');

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'data', 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

let client = null;
let initialized = false;
const bus = new EventEmitter();
const seen = new Set(); // anti-duplicação por id

function extFromMime(mime = '') {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  return map[mime] || (mime.split('/')[1] || 'bin');
}

function jidNumber(jid = '') {
  return String(jid).replace(/@.+$/, '');
}

function bestName(contact) {
  if (!contact) return null;
  return (
    contact.name ||
    contact.verifiedName ||
    contact.pushname ||
    contact.shortName ||
    jidNumber(contact.id?._serialized || '')
  );
}

async function enrichAndEmitMessage(rawMsg, direction) {
  try {
    if (!rawMsg || !rawMsg.id) return;
    const id = rawMsg.id._serialized;
    if (seen.has(id)) return; // evita duplicado real
    seen.add(id);

    const chat = await rawMsg.getChat();
    const isGroup = !!chat.isGroup;
    const chatId = chat.id._serialized;
    const chatName = chat.name || (isGroup ? jidNumber(chatId) : undefined);

    const fromMe = !!rawMsg.fromMe;
    const from = rawMsg.from;
    const to = rawMsg.to;
    const timestamp = rawMsg.timestamp;
    const authorJid = rawMsg.author || rawMsg.from;
    const type = rawMsg.type || 'chat'; // chat, image, video, audio, ptt, sticker, document...

    let authorName = null;
    try {
      const contact = await client.getContactById(authorJid);
      authorName = bestName(contact);
    } catch { }

    const peerJid = isGroup ? null : (fromMe ? to : from);

    // mídia (se houver)
    let mediaUrl = null, mimetype = null, filename = null, size = null, dataUrlPreview = null;
    try {
      if (rawMsg.hasMedia || ['image', 'video', 'audio', 'sticker', 'document', 'ptt'].includes(type)) {
        const media = await rawMsg.downloadMedia();
        if (media && media.data) {
          mimetype = media.mimetype || null;
          filename = media.filename || null;
          const ext = extFromMime(mimetype);
          const fileBase = id + '.' + ext;
          const abspath = path.join(MEDIA_DIR, fileBase);
          const buf = Buffer.from(media.data, 'base64');
          size = buf.length;
          fs.writeFileSync(abspath, buf);
          mediaUrl = `/media/${fileBase}`;

          // preview inline para imagens pequenas
          if (mimetype && mimetype.startsWith('image/') && buf.length < 200 * 1024) {
            dataUrlPreview = `data:${mimetype};base64,${media.data}`;
          }
        }
      }
    } catch (e) {
      // segue sem mídia
    }

    const payload = {
      id,
      direction: direction || (fromMe ? 'out' : 'in'),
      chatId,
      chatName: chatName || null,
      isGroup,
      from,
      to,
      author: authorJid,
      authorName,
      fromMe,
      body: rawMsg.body || '',
      type,
      ts: (timestamp && timestamp * 1000) || Date.now(),
      // mídia
      mediaUrl, mimetype, filename, size, dataUrlPreview,
      // util p/ front
      peerJid,
    };

    bus.emit('message', payload);
  } catch (err) {
    bus.emit('status', { stage: 'warn', error: 'enrich_fail', detail: String(err) });
  }
}

function getClient() {
  if (client) return client;

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: process.env.WWEBJS_CLIENT_ID || 'whatsapp-bot',
      dataPath: process.env.WWEBJS_DATA_PATH || '/data/wwebjs'
    }),
    puppeteer: {
      headless: true,
       executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ],
    }
  });

  if (!initialized) {
    initialized = true;

    client.on('qr', (qr) => bus.emit('qr', { qr }));
    client.on('loading_screen', (percent, message) => bus.emit('status', { stage: 'loading', percent, message }));
    client.on('authenticated', () => bus.emit('status', { stage: 'authenticated' }));
    client.on('ready', () => bus.emit('status', { stage: 'ready' }));
    client.on('disconnected', (reason) => bus.emit('status', { stage: 'disconnected', reason }));

    client.on('message', async (msg) => {
      await enrichAndEmitMessage(msg, 'in');
    });

    client.on('message_create', async (msg) => {
      if (msg.fromMe) await enrichAndEmitMessage(msg, 'out');
    });

    client.initialize().catch((e) => bus.emit('status', { stage: 'error', error: String(e) }));
  }

  return client;
}

module.exports = { getClient, bus, MEDIA_DIR };
