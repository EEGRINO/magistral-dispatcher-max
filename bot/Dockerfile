# Многостадийная сборка: TypeScript и devDependencies остаются в build-стадии
# и в финальный образ не попадают.

FROM node:22-alpine AS build
WORKDIR /app

# Отдельным слоем — чтобы npm install не переигрывался при каждой правке кода.
COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# У бота нет runtime-зависимостей (всё на нативном fetch), но package.json
# нужен: без "type": "module" Node не поймёт ESM-код в dist.
COPY package.json ./
COPY --from=build /app/dist ./dist

# Не root: процесс ходит только наружу по HTTPS, привилегии ему не нужны.
USER node

# Бот работает по long polling, входящих соединений нет — EXPOSE не нужен.
CMD ["node", "dist/index.js"]
