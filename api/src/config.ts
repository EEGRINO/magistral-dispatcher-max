/**
 * Конфигурация api. Единственное место, где читается process.env.
 */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} не задан.\n` +
        '  Локально:  cp .env.example .env\n' +
        '  В Docker:  переменную прокидывает docker-compose',
    );
  }

  return value;
}

function readPort(): number {
  const raw = Number(process.env.PORT ?? 3000);

  if (!Number.isInteger(raw) || raw <= 0 || raw > 65535) {
    throw new Error(`PORT должен быть целым числом 1..65535, получено: ${process.env.PORT}`);
  }

  return raw;
}

/**
 * Дом для демо-входа: жюри и тестировщики не заведены у УК, и без этого
 * «Поделиться контактом» для них — тупик. Не задан — демо-вход выключен.
 */
function readDemoHouseId(): number | null {
  const raw = process.env.DEMO_LOGIN_HOUSE_ID?.trim();
  if (!raw) return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`DEMO_LOGIN_HOUSE_ID должен быть id дома (целое > 0), получено: ${raw}`);
  }
  return id;
}

export const config = {
  port: readPort(),
  databaseUrl: requireEnv('DATABASE_URL'),
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',

  /**
   * Правила маршрутизации. В Docker папка config/ монтируется в /app/config
   * (docker-compose.yml); локально api запускается из api/, отсюда ../config.
   */
  rulesPath: process.env.RULES_PATH?.trim() || '../config/rules.yaml',

  /**
   * Токен бота — только чтобы проверять подпись initData мини-приложения
   * (init-data.ts): подпись считается этим токеном. Секрет: только из
   * окружения, в лог — никогда. Не задан — маршруты мини-аппа отвечают 503.
   */
  botToken: process.env.MAX_BOT_TOKEN?.trim() || null,

  /** Сколько живёт initData мини-аппа. Дока срок не задаёт; сутки — чтобы открытое с утра приложение работало весь день. */
  initDataMaxAgeSec: Number(process.env.INIT_DATA_MAX_AGE_SEC ?? 24 * 60 * 60),

  /** Как часто разбирать адреса домов, заведённых в БД напрямую (house-normalizer.ts). */
  houseNormalizeIntervalMs: Number(process.env.HOUSE_NORMALIZE_INTERVAL_MS ?? 60_000),

  /** Демо-вход в этот дом для номеров, которых нет у УК; null — выключен. */
  demoHouseId: readDemoHouseId(),
} as const;
