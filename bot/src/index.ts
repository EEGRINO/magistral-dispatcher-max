/**
 * Точка входа. Делает ровно одно: импортирует логику бота так, чтобы ошибка
 * валидации конфига (пустой MAX_BOT_TOKEN — самый вероятный сценарий на новой
 * машине) превратилась в одну понятную строку, а не в стектрейс модуля.
 *
 * Именно поэтому импорт динамический: статический выполнился бы до try/catch.
 */
try {
  const { run } = await import('./bot.js');
  await run();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`\n❌ Бот не запустился.\n\n${reason}\n`);
  process.exit(1);
}
