# Одноразовый контейнер: применяет миграции и завершается.
# Сервер из него не поднимается, поэтому образ без многостадийной сборки —
# node-pg-migrate нужен именно в рантайме.

FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY migrations ./migrations
COPY seed.js ./

USER node

# Применить все неприменённые миграции и выйти.
# Код возврата 0 — то, чего ждёт `depends_on: service_completed_successfully`.
CMD ["npm", "run", "migrate:up"]
