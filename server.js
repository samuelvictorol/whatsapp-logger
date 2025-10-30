require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const mime = require('mime-types');
const Redis = require('ioredis');

const { getClient, bus, MEDIA_DIR } = require('./whatsapp');

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.DASH_TOKEN || '';
const MONGO_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGO_DB || 'whatsapp';
const COL_NAME = process.env.MONGO_COL || 'messages';
const MSG_TTL_DAYS = Number(process.env.MSG_TTL_DAYS || 0);

// Buffer opcional com Redis (para flush em lote)
const REDIS_URL = process.env.REDIS_URL || '';
const FLUSH_SECONDS = Math.max(30, Number(process.env.FLUSH_SECONDS || 3600));
const FLUSH_BATCH_LIMIT = Math.max(100, Number(process.env.FLUSH_BATCH_LIMIT || 5000));
const REDIS_LIST_KEY = process.env.REDIS_LIST_KEY || 'wapp:buffer:v1';
const REDIS_BOOT_TIMEOUT_MS = Number(process.env.REDIS_BOOT_TIMEOUT_MS || 10000);

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(cors({ origin: true, credentials: true }));

// estáticos públicos (SPA)
app.use(express.static(path.join(__dirname, 'public')));

// mídia estática (define Content-Type correto)
app.use('/media', express.static(MEDIA_DIR, {
  setHeaders: (res, filePath) => {
    const type = mime.lookup(filePath);
    if (type) res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', 'inline');
  }
}));

// fallback por ID (sem saber a extensão)
app.get('/media/by-id/:id', (req, res) => {
  try {
    const id = req.params.id;
    const files = fs.readdirSync(MEDIA_DIR).filter(n => n.startsWith(id + '.'));
    if (!files.length) return res.status(404).send('not found');
    const file = path.join(MEDIA_DIR, files[0]);
    const type = mime.lookup(file) || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(file);
  } catch {
    res.status(404).send('not found');
  }
});

/* --------- Mongo --------- */
let mongo, db, messages;

async function ensureIndexes() {
  if (!messages) return;
  await messages.createIndex({ chatId: 1, ts: -1 }, { name: 'chat_ts' });
  if (MSG_TTL_DAYS > 0) {
    const secs = Math.max(1, Math.floor(MSG_TTL_DAYS * 86400));
    const name = 'ttl_createdAt';
    try {
      const idxs = await messages.listIndexes().toArray();
      const cur = idxs.find(i => i.name === name);
      if (cur && cur.expireAfterSeconds !== secs) {
        await messages.dropIndex(name).catch(() => {});
      }
    } catch {}
    await messages.createIndex({ createdAt: 1 }, { expireAfterSeconds: secs, name });
    console.log(`[mongo] TTL ativo: ${MSG_TTL_DAYS} dia(s)`);
  } else {
    console.log('[mongo] TTL desativado.');
  }
}

(async () => {
  try {
    if (!MONGO_URI) {
      console.warn('[mongo] MONGODB_URI ausente. Persistência desativada.');
    } else {
      mongo = new MongoClient(MONGO_URI, { maxPoolSize: 8, serverSelectionTimeoutMS: 12000 });
      await mongo.connect();
      db = mongo.db(DB_NAME);
      messages = db.collection(COL_NAME);
      await ensureIndexes();
      console.log('[mongo] conectado');
    }
  } catch (e) {
    console.error('[mongo] falha ao conectar:', e.message);
  }
})();

/* --------- Redis opcional --------- */
let redis = null;
let flushTimer = null;

async function startFlusher() {
  if (!messages || !redis || redis.status !== 'ready') return;
  console.log(`[Redis] flush agendado a cada ${FLUSH_SECONDS}s • batch máx ${FLUSH_BATCH_LIMIT} • key=${REDIS_LIST_KEY}`);
  flushTimer = setInterval(async () => {
    try {
      if (!messages) return;
      const batch = [];
      for (let i = 0; i < FLUSH_BATCH_LIMIT; i++) {
        const item = await redis.lpop(REDIS_LIST_KEY);
        if (!item) break;
        batch.push(JSON.parse(item));
      }
      if (!batch.length) return;
      const ops = batch.map(doc => {
        const key = doc._id || doc.id || `${doc.chatId}:${doc.ts}`;
        return { updateOne: { filter: { _id: key }, update: { $set: doc }, upsert: true } };
      });
      await messages.bulkWrite(ops, { ordered: false });
      console.log(`[flush] persistidos ${ops.length}`);
    } catch (e) {
      console.warn('[flush] falhou:', e.message);
    }
  }, FLUSH_SECONDS * 1000);
  flushTimer.unref();
}

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined
  });
  redis.on('error', (e) => console.warn('[redis] erro:', e?.message || e));
  Promise.race([
    new Promise(r => redis.once('ready', r)),
    new Promise(r => redis.once('error', r)),
    new Promise(r => setTimeout(r, REDIS_BOOT_TIMEOUT_MS))
  ]).then(() => {
    if (redis && redis.status === 'ready') startFlusher();
    else {
      console.warn('[redis] indisponível, usando gravação direta no Mongo');
      try { redis && redis.disconnect(); } catch {}
      redis = null;
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    }
  });
}

/* --------- WhatsApp (singleton) --------- */
const wpp = getClient();

/* --------- SSE: /events --------- */
const clients = new Set();

// snapshot em memória p/ reemitir imediatamente ao conectar
const last = { status: null, qr: null, qrAt: 0 };

function isValidQr(s) {
  if (typeof s !== 'string') return false;
  if (s.includes('undefined')) return false;
  const parts = s.split(',');
  return parts.length === 5 && parts[0].startsWith('2@');
}

function auth(req, res, next) {
  if (!TOKEN) return next();
  const header = req.headers.authorization || '';
  const queryToken = req.query.token;
  const okHeader = header.startsWith('Bearer ') && header.slice(7) === TOKEN;
  const okQuery = queryToken && queryToken === TOKEN;
  if (!okHeader && !okQuery) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const client = { res };
  clients.add(client);

  res.write(`event: status\ndata: ${JSON.stringify({ stage: 'connected' })}\n\n`);

  if (last.status) {
    res.write(`event: status\ndata: ${JSON.stringify(last.status)}\n\n`);
  }
  // janela maior (30s) pra não perder QR recém-emitido
  if (last.qr && Date.now() - last.qrAt < 30000) {
    res.write(`event: qr\ndata: ${JSON.stringify({ qr: last.qr })}\n\n`);
  }

  const hb = setInterval(() => {
    res.write(`event: ping\ndata: ${Date.now()}\n\n`);
  }, 15000);

  const cleanup = () => { clearInterval(hb); clients.delete(client); };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
});

function push(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.res.write(data);
}

/* --------- Bridge: WhatsApp -> SSE + persistência --------- */
bus.on('qr', (p) => {
  const s = p?.qr;
  if (!isValidQr(s)) return;        // ignora QR inválido
  last.qr = s;
  last.qrAt = Date.now();
  push('qr', { qr: s });            // envia QR cru
});

bus.on('status', (p) => {
  last.status = p || null;
  push('status', p);
});

function shouldIgnore(p) {
  return p.from === 'status@broadcast' || p.to === 'status@broadcast';
}

bus.on('message', async (p) => {
  if (shouldIgnore(p)) return;
  push('message', p);
  try {
    if (!messages) return;
    const ts = Number(p.ts || p.timestamp || Date.now());
    const doc = { ...p, ts: ts < 1e12 ? ts * 1000 : ts, createdAt: new Date() };
    if (doc.id) doc._id = doc.id;

    if (redis) {
      await redis.rpush(REDIS_LIST_KEY, JSON.stringify(doc));
    } else {
      const key = doc._id || doc.id || `${doc.chatId}:${doc.ts}`;
      await messages.updateOne({ _id: key }, { $set: doc }, { upsert: true });
    }
  } catch (e) {
    console.warn('[mongo] upsert falhou:', e.message);
  }
});

/* --------- REST --------- */
app.get('/status', (_, res) => {
  res.json({ ok: true, lastStatus: last.status, lastQrAgeMs: last.qrAt ? (Date.now() - last.qrAt) : null });
});

app.get('/healthz', async (_, res) => {
  res.status(200).json({ ok: true, mongo: !!messages, redis: redis ? redis.status : 'disabled' });
});

app.post('/send', auth, async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: 'to/body obrigatórios' });
    await wpp.sendMessage(to, body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/messages', auth, async (req, res) => {
  try {
    if (!messages) return res.json([]);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
    const chatId = req.query.chatId || null;
    const sinceDays = Number(req.query.days || req.query.sinceDays || 0);

    const filter = {};
    if (chatId) filter.chatId = chatId;
    if (sinceDays > 0) {
      const cutoff = Date.now() - sinceDays * 86400000;
      filter.ts = { $gte: cutoff };
    }

    const docs = await messages.find(filter).sort({ ts: -1 }).limit(limit).toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/chats', auth, async (req, res) => {
  try {
    if (!messages) return res.json([]);
    const sinceDays = Number(req.query.days || req.query.sinceDays || 0);
    const match = {};
    if (sinceDays > 0) {
      const cutoff = Date.now() - sinceDays * 86400000;
      match.ts = { $gte: cutoff };
    }

    const pipe = [
      Object.keys(match).length ? { $match: match } : null,
      { $sort: { ts: -1 } },
      {
        $group: {
          _id: '$chatId',
          lastTs: { $first: '$ts' },
          lastBody: { $first: '$body' },
          chatName: { $first: '$chatName' },
          isGroup: { $first: '$isGroup' }
        }
      },
      { $sort: { lastTs: -1 } },
      { $limit: 500 }
    ].filter(Boolean);

    const rows = await messages.aggregate(pipe).toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`[http] up :${PORT}`));
