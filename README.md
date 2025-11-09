
# <img width="32px" height="32px" alt="whatsapp logo" src="https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/WhatsApp.svg/1198px-WhatsApp.svg.png" /> WhatsApp Logger + MongoDB
- 📲 CONECTE e AUTOMATIZE seu WhatsApp com a API da <strong>WhatsApp Logger</strong>!

<img width="1003" height="476" alt="image" src="https://github.com/user-attachments/assets/3dc36e52-a6fe-4b7c-ac20-9a65d0a6fb66" />


<img width="1911" height="545" alt="image" src="https://github.com/user-attachments/assets/640ad562-6c12-4a87-aa43-e1b3c18dbc8f" />

> Sessão persistente via `whatsapp-web.js` com **Docker**, **MongoDB** e **frontend** com html,css e js QR, conversas e mensagens em tempo real — incluindo **envios feitos no painel ou em outros dispositivos**.

# Como Usar?
- [ ] Na aba 'Status e QR' escaneie o QR Code com seu aplicativo do whatsapp e adicione um novo acesso.
- [ ] Após conectar, clique na aba 'Conversas' e veja seu painel de chats em tempo real.
- [ ] Utilize os endpoints de envio de mensagens e mídias para integrar com suas aplicações.

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

> por Samuel Victor - https://samuelvictorol.github.io/portfolio
