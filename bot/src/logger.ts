/**
 * Минимальный структурный логгер. Без зависимостей — на MVP хватает,
 * а меньше пакетов = меньше поверхности для проблем при сборке образа.
 */
import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(config.logLevel as Level) in ORDER ? (config.logLevel as Level) : 'info'];

/**
 * Страховка: токен не должен попасть в лог даже случайно — например, если
 * кто-то залогирует объект запроса целиком вместе с заголовками.
 */
function redact(text: string): string {
  return config.token.length > 0 ? text.split(config.token).join('***REDACTED***') : text;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    svc: 'bot',
    msg,
    ...meta,
  };

  const out = redact(JSON.stringify(line));
  if (level === 'error' || level === 'warn') console.error(out);
  else console.log(out);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
