/**
 * Каркас API. Сегодня здесь намеренно только /health: он нужен,
 * чтобы `docker compose up` было чем проверить.
 *
 * Контракт API, маршрутизация заявок и работа с БД — задачи следующих дней,
 * и схема БД требует согласования с разработчиком (см. CLAUDE.md).
 */
import Fastify from 'fastify';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

app.get('/health', async () => ({
  status: 'ok',
  service: 'api',
  ts: new Date().toISOString(),
}));

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  app.log.error(`Некорректный PORT: ${process.env.PORT}`);
  process.exit(1);
}

// 0.0.0.0, а не localhost: внутри контейнера слушать только петлю —
// значит быть недоступным с хоста и из других сервисов compose.
await app.listen({ host: '0.0.0.0', port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'остановка');
    void app.close().then(() => process.exit(0));
  });
}
