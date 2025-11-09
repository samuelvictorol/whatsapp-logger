
FROM node:20-bookworm-slim

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# se não houver lockfile no contexto, usamos install
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data/wwebjs /app/data/media

EXPOSE 10000

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/server.js"]
