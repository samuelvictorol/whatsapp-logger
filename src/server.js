
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const QRCode = require('qrcode');
const mime = require('mime-types');
const { MongoClient } = require('mongodb');

const {
  getClient,
  getLastQR,
  getLastState,
  waitReady,
  listChatsSummary,
  fetchChatMessages,
  sendText,
  sendBase64Media,
  bus,
  MEDIA_DIR
} = require('./whatsapp');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.DASH_TOKEN || '';

const MONGO_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGO_DB || 'whatsapp';
const COL_NAME = process.env.MONGO_COL || 'messages';
const MSG_TTL_DAYS = Math.max(0, Number(process.env.MSG_TTL_DAYS || 0));

let mongoClient = null;
let mongoCol = null;

(async () => {
  try {
    if (MONGO_URI) {
      mongoClient = new MongoClient(MONGO_URI);
      await mongoClient.connect();
      const db = mongoClient.db(DB_NAME);
      mongoCol = db.collection(COL_NAME);
      if (MSG_TTL_DAYS > 0) {
        await mongoCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: MSG_TTL_DAYS * 86400 });
      }
      await mongoCol.createIndex({ _id: 1 }, { unique: true });
      bus.emit('log', `[MONGO] Conectado e pronto.`);
    } else {
      bus.emit('log', `[MONGO] MONGODB_URI vazio — persistência desligada.`);
    }
  } catch (e) {
    bus.emit('log', `[MONGO ERROR] ${e?.message || e}`);
  }
})();

bus.on('message', async (rec) => {
  try {
    if (!mongoCol) return;
    const doc = {
      _id: rec.id || `${rec.chatId || 'chat'}:${rec.timestamp}`,
      chatId: rec.chatId,
      from: rec.from,
      to: rec.to,
      fromMe: !!rec.fromMe,
      type: rec.type,
      body: rec.body || null,
      hasMedia: !!rec.hasMedia,
      media: rec.media && rec.media.file ? { file: rec.media.file, mimetype: rec.media.mimetype, size: rec.media.size } :
             rec.media && rec.media.mimetype ? { mimetype: rec.media.mimetype } : null,
      ack: rec.ack,
      isStatus: !!rec.isStatus,
      timestamp: rec.timestamp || Date.now(),
      createdAt: new Date(rec.timestamp || Date.now()),
    };
    await mongoCol.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });
  } catch (e) {
    bus.emit('log', `[MONGO SAVE ERROR] ${e?.message || e}`);
  }
});

// static
app.use('/', express.static(path.join(__dirname, '..', 'public')));

function requireToken(req, res, next) {
  if (!TOKEN) return next();
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${TOKEN}`) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ---------- SSE EVENTS ----------
app.get('/events', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const snap = getLastState();
  send('state', snap);
  const qr = getLastQR();
  if (qr) send('qr', { dataURL: qr });
  send('log', { message: '[SSE] Conectado.' });

  const onQR = (dataURL) => send('qr', { dataURL });
  const onState = (state) => send('state', { state });
  const onReady = () => send('ready', { ok: true });
  const onLog = (message) => send('log', { message });
  const onMsg = (msg) => send('message', msg);
  const onAck = (ack) => send('message_ack', ack);

  bus.on('qr', onQR);
  bus.on('state', onState);
  bus.on('ready', onReady);
  bus.on('log', onLog);
  bus.on('message', onMsg);
  bus.on('message_ack', onAck);

  const ping = setInterval(() => { res.write(':\n\n'); }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('qr', onQR);
    bus.off('state', onState);
    bus.off('ready', onReady);
    bus.off('log', onLog);
    bus.off('message', onMsg);
    bus.off('message_ack', onAck);
  });
});

// ---------- HEALTH & STATUS ----------
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/status', async (req, res) => {
  const s = getLastState();
  res.json(s);
});

// ---------- QR AS PNG ----------
app.get('/qr.png', async (req, res) => {
  const dataURL = getLastQR();
  if (!dataURL) return res.status(204).end();
  const base64Data = dataURL.split(',')[1];
  const buf = Buffer.from(base64Data, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.send(buf);
});

// ---------- MEDIA SERVE ----------
app.get('/media/:file', (req, res) => {
  const file = path.join(MEDIA_DIR, req.params.file);
  if (!fs.existsSync(file)) return res.status(404).end();
  const ct = mime.lookup(file) || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  fs.createReadStream(file).pipe(res);
});

// ---------- API: chats & messages ----------
app.get('/api/chats', requireToken, async (req, res) => {
  const ok = await waitReady(30000);
  if (!ok) return res.status(503).json({ error: 'client not ready' });
  try {
    const data = await listChatsSummary();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/api/chat/:id/messages', requireToken, async (req, res) => {
  const ok = await waitReady(30000);
  if (!ok) return res.status(503).json({ error: 'client not ready' });
  const { id } = req.params;
  const { limit, before } = req.query;
  try {
    const data = await fetchChatMessages(id, limit, before);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- API: send text ----------
app.post('/api/send-text', requireToken, async (req, res) => {
  const ok = await waitReady(30000);
  if (!ok) return res.status(503).json({ error: 'client not ready' });
  const { to, body } = req.body || {};
  if (!to || !body) return res.status(400).json({ error: 'to e body são obrigatórios' });
  try {
    const out = await sendText(to, body);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- API: send media ----------
app.post('/api/send-media', requireToken, upload.single('file'), async (req, res) => {
  const ok = await waitReady(30000);
  if (!ok) return res.status(503).json({ error: 'client not ready' });

  try {
    const to = req.body?.to;
    const caption = req.body?.caption || '';
    let mimetype = req.body?.mimetype;
    let base64 = req.body?.base64;

    if (req.file && req.file.buffer) {
      mimetype = req.file.mimetype || mimetype || 'application/octet-stream';
      base64 = req.file.buffer.toString('base64');
    }

    if (!to || !mimetype || !base64) {
      return res.status(400).json({ error: 'to, mimetype e base64 (ou multipart file) são obrigatórios' });
    }

    const out = await sendBase64Media(to, base64, mimetype, caption);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- START CLIENT ----------
getClient();

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`HTTP server listening on :${PORT}`);
  bus.emit('log', `[HTTP] Servidor iniciado na porta ${PORT}`);
});
