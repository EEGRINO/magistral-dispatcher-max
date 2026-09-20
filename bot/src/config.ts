/**
 * Конфигурация бота. Единственное место, где читается process.env.
 *
 * Токен берётся ТОЛЬКО из окружения. Дефолтного значения у него нет и быть не может:
 * фолбэк на "тестовый" токен в коде — это и есть утечка секрета в git.
 */

/** Значения из .env.example — если они доехали до рантайма, .env не заполнен. */
const PLACEHOLDERS = new Set([
  'paste-your-max-bot-token-here',
  'your-token-here',
  'changeme',
  'change-me',
]);

function readToken(): string {
  const raw = process.env.MAX_BOT_TOKEN?.trim();

  if (!raw) {
    throw new Error(
      'MAX_BOT_TOKEN не задан.\n' +
        '  Локально:  cp .env.example .env  и подставить токен из @MasterBot\n' +
        '  В Docker:  docker compose читает .env из корня репозитория',
    );
  }

  if (PLACEHOLDERS.has(raw)) {
    throw new Error(
      `MAX_BOT_TOKEN всё ещё равен плейсхолдеру "${raw}". Подставь настоящий токен в .env.`,
    );
  }

  return raw;
}

function readPollTimeout(): number {
  const raw = Number(process.env.MAX_POLL_TIMEOUT ?? 90);
  // Дока MAX ограничивает timeout диапазоном 0..90 секунд.
  if (!Number.isFinite(raw) || raw < 0 || raw > 90) {
    throw new Error(`MAX_POLL_TIMEOUT должен быть числом 0..90, получено: ${process.env.MAX_POLL_TIMEOUT}`);
  }
  return Math.floor(raw);
}

export const config = {
  token: readToken(),

  /**
   * С 19.07.2026 база — platform-api2.max.ru.
   * Старые botapi.max.ru / platform-api.max.ru отвечают ошибкой. См. docs/max-notes.md.
   */
  baseUrl: (process.env.MAX_API_BASE_URL?.trim() || 'https://platform-api2.max.ru').replace(/\/+$/, ''),

  pollTimeoutSec: readPollTimeout(),

  /**
   * Внутренний api. В docker-compose переопределяется на http://api:3000
   * (имя сервиса в сети compose), локально по умолчанию — localhost.
   */
  apiBaseUrl: (process.env.API_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, ''),

  /** Таймаут запроса к api. Короткий: человек ждёт ответа в чате. */
  apiTimeoutMs: Number(process.env.API_TIMEOUT_MS ?? 5000),

  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
} as const;

export const messages = {
  /** Фолбэк, когда api недоступен: лучше поздороваться без ID, чем молчать. */
  greeting: 'Бот на связи. Напиши что-нибудь — я повторю.',

  greetingWithId: (residentId: number): string =>
    `Бот на связи. Ваш ID: ${residentId}. Напиши что-нибудь — я повторю.`,

  nonText: 'Пока я понимаю только текст. Напиши сообщение словами.',
} as const;
