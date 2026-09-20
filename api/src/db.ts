/**
 * Пул соединений с PostgreSQL и помощник для транзакций.
 */
import pg from 'pg';
import { config } from './config.js';

// pg — CommonJS-пакет, именованные импорты из него в ESM ненадёжны,
// поэтому берём default и разбираем вручную.
const { Pool, types } = pg;

/**
 * int8 (BIGSERIAL) драйвер по умолчанию отдаёт СТРОКОЙ — чтобы не терять
 * точность на значениях больше 2^53. Наши id столько не наберут даже близко,
 * а строковый id в JSON сломал бы типизацию клиента (и `===` сравнения),
 * поэтому приводим к number.
 *
 * Если когда-нибудь появится счётчик, реально уходящий за 9·10^15, —
 * это место придётся пересмотреть.
 */
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Не ждать соединения бесконечно: лучше быстро ответить 500, чем повесить
  // запрос от бота, у которого свой таймаут.
  connectionTimeoutMillis: 5_000,
});

/**
 * Выполняет fn в одной транзакции на одном соединении.
 * Соединение возвращается в пул в любом случае, включая исключение.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
