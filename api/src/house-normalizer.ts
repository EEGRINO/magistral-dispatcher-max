/**
 * Дома, заведённые или исправленные прямо в БД (pgAdmin), — без разобранных
 * улицы и номера: по ним житель находит дом вводом адреса. Раз в минуту api
 * разбирает такие адреса тем же parseAddress, что и ввод жителя, — одна
 * реализация разбора на всех. Согласовано 26.09.2026 (миграция 0007
 * сбрасывает street/number при смене адреса в БД).
 */
import type { FastifyBaseLogger } from 'fastify';
import { parseAddress } from './address.js';
import { pool } from './db.js';

/** Про один и тот же неразборчивый адрес не пишем в лог каждую минуту. */
const reported = new Set<string>();

async function normalizeHouses(log: FastifyBaseLogger): Promise<void> {
  const { rows } = await pool.query<{ id: number; address: string }>(
    'SELECT id, address FROM houses WHERE street IS NULL OR number IS NULL',
  );

  for (const house of rows) {
    const parsed = parseAddress(house.address);
    const key = `${house.id}:${house.address}`;

    if (!parsed) {
      if (!reported.has(key)) {
        reported.add(key);
        log.warn({ house_id: house.id }, 'адрес дома не разобран на улицу и номер — жители не найдут его вводом адреса');
      }
      continue;
    }

    try {
      await pool.query(
        'UPDATE houses SET street = $2, number = $3 WHERE id = $1 AND (street IS NULL OR number IS NULL)',
        [house.id, parsed.street, parsed.number],
      );
      log.info({ house_id: house.id }, 'улица и номер дома заполнены по адресу');
    } catch (error) {
      // Такая же улица и номер уже у другого дома (UNIQUE) — дубль адреса.
      if ((error as { code?: string }).code === '23505') {
        if (!reported.has(key)) {
          reported.add(key);
          log.warn({ house_id: house.id }, 'дом с такой улицей и номером уже есть — проверьте, не дубль ли');
        }
        continue;
      }
      throw error;
    }
  }
}

/** Запустить: сразу и затем раз в intervalMs. Возвращает остановку. */
export function startHouseNormalizer(log: FastifyBaseLogger, intervalMs: number): () => void {
  const tick = () => {
    normalizeHouses(log).catch((error: unknown) => log.error({ err: error }, 'разбор адресов домов не выполнен'));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
