# WhatsApp Logger — Dashboard + API
> TL;DR: Dashboard em tempo real via SSE, suporte a texto, imagem, áudio/ptt, sticker e docs, mídia servida com Content-Type correto, persistência em Mongo e buffer assíncrono via Redis (flush ajustável). Proteção opcional com DASH_TOKEN.


## ✨ Principais recursos

- 🔌 SSE (/events) para status, QR Code e mensagens em tempo real

- 🖼️ Mídia salva em disco + /media com Content-Type correto (imagem/áudio/vídeo/sticker/doc)

- 🧠 Anti-duplicação e bolha otimista no front

- 🗄️ MongoDB com índices + TTL opcional (MSG_TTL_DAYS)

- 🧰 Redis opcional para flush em lote (FLUSH_SECONDS, FLUSH_BATCH_LIMIT)

- 🔒 DASH_TOKEN para proteger /events, /send, /messages, /chats

- 🛠️ Pronto para Docker/Render (PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium)

## 🧭 Documentação completa dos endpoints

> Leia a documentação rica em exemplos (cURL/fetch) em public/documentacao.html 

Resumo rápido:

GET /events — stream SSE (status, qr, message)

POST /send — { to, body } texto

GET /messages — histórico (filtros: limit, chatId, days)

GET /chats — últimas por chat (filtro: days)

GET /healthz — health check

GET /media/:id.ext e GET /media/by-id/:id — servir mídia

## ⚙️ Variáveis de ambiente (essenciais)

| Variável                    |                  Padrão | Descrição                                                           |
| --------------------------- | ----------------------: | ------------------------------------------------------------------- |
| `PORT`                      |                 `10000` | Porta HTTP                                                          |
| `DASH_TOKEN`                |                       — | Token do painel (protege `/events`, `/send`, `/messages`, `/chats`) |
| `MONGODB_URI`               |                       — | String de conexão                                                   |
| `MONGO_DB` / `MONGO_COL`    | `whatsapp` / `messages` | Banco/Coleção                                                       |
| `MSG_TTL_DAYS`              |                     `0` | TTL por `createdAt` (0 = desliga)                                   |
| `REDIS_URL`                 |                       — | Ativa buffer e flush assíncrono                                     |
| `FLUSH_SECONDS`             |                  `3600` | Intervalo do flush em segundos                                      |
| `FLUSH_BATCH_LIMIT`         |                  `5000` | Máx itens por flush                                                 |
| `MEDIA_DIR`                 |       `/app/data/media` | Pasta de mídia                                                      |
| `WWEBJS_CLIENT_ID`          |          `whatsapp-bot` | ID da sessão                                                        |
| `WWEBJS_STORE`              |      `/app/data/wwebjs` | Persistência local                                                  |
| `PUPPETEER_EXECUTABLE_PATH` |     `/usr/bin/chromium` | Chromium (Docker/Render)                                            |

## 🏁 Quickstart

1) Copie e edite seu .env
> cp .env.example .env
2) Suba em Docker
> docker compose up -d --build
-3) Acesse
> Painel:        http://localhost:10000/
> Documentação:  http://localhost:10000/documentacao.html   (ou /docs/)
