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

export const config = {
  port: readPort(),
  databaseUrl: requireEnv('DATABASE_URL'),
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',

  /**
   * Правила маршрутизации. В Docker папка config/ монтируется в /app/config
   * (docker-compose.yml); локально api запускается из api/, отсюда ../config.
   */
  rulesPath: process.env.RULES_PATH?.trim() || '../config/rules.yaml',
} as const;
