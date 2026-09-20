/**
 * Точка входа api.
 *
 * Динамический импорт — чтобы ошибка конфигурации (нет DATABASE_URL)
 * превратилась в одну понятную строку, а не в стектрейс модуля.
 */
try {
  const { buildApp } = await import('./app.js');
  const { config } = await import('./config.js');
  const { pool } = await import('./db.js');

  const app = buildApp();

  // 0.0.0.0, а не localhost: внутри контейнера слушать только петлю —
  // значит быть недоступным и с хоста, и из других сервисов compose.
  await app.listen({ host: '0.0.0.0', port: config.port });

  let shuttingDown = false;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;

      app.log.info({ signal }, 'остановка');

      // Сначала перестаём принимать запросы, потом закрываем пул —
      // иначе запрос в полёте упадёт на закрытом соединении.
      void app
        .close()
        .then(() => pool.end())
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          app.log.error({ err: error }, 'ошибка при остановке');
          process.exit(1);
        });
    });
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`\n❌ api не запустился.\n\n${reason}\n`);
  process.exit(1);
}
