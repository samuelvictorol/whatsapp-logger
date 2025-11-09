
# WhatsApp Logger — Sessão Persistente (Docker)

Sessão persistente via `whatsapp-web.js` com **Docker**, **MongoDB** (opcional) e **frontend** com QR, conversas e mensagens em tempo real — incluindo **envios feitos no painel ou em outros dispositivos**.

## Novidades desta versão
- **Dockerfile** com `COPY package*.json` + `npm install --omit=dev --no-audit --no-fund`.
- **Resolução LID** automática (getNumberId) antes de enviar.
- **Realtime de mensagens enviadas e recebidas** (SSE):
  - `message` (incoming) e `message_create` (outgoing ou de outros dispositivos).
  - Emissão **imediata** após `sendMessage` para melhor UX.
- **Persistência no MongoDB** em tempo real (upsert por `_id` = id da mensagem). TTL opcional.

## Variáveis de ambiente
Veja `.env.example`. Principais:
- `MONGODB_URI` / `MONGO_DB` / `MONGO_COL` / `MSG_TTL_DAYS`
- `WWEBJS_STORE=/app/data/wwebjs` (persistência de sessão)
- `MEDIA_DIR=/app/data/media`
- `PORT` (default 10000)

## Subir
```bash
docker compose up -d --build
```
Acesse: `http://localhost:10000`

## Endpoints
- `GET /api/chats`
- `GET /api/chat/:id/messages?limit=50&before=<id>`
- `POST /api/send-text` `{ to, body }`
- `POST /api/send-media` (multipart `file` ou `{to, mimetype, base64, caption}`)
- `GET /events` (SSE): `state`, `qr`, `log`, `message`, `message_ack`

## Persistência Mongo
Cada `bus.emit('message')` grava no Mongo. Campos: `_id`, `chatId`, `from`, `to`, `fromMe`, `type`, `body`, `hasMedia`, `media`, `ack`, `isStatus`, `timestamp`, `createdAt`.
Se `MSG_TTL_DAYS>0`, criamos índice TTL em `createdAt`.
