/**
 * POST /residents/find-or-create — точка входа жителя.
 *
 * Бот дёргает её на каждый /start и не обязан знать, новый это человек
 * или вернувшийся: идемпотентность — ответственность api.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { pool } from '../db.js';
import {
  ErrorResponse,
  FindOrCreateResidentBody,
  FindOrCreateResidentResponse,
  toResidentDto,
  type ResidentRow,
} from '../schemas.js';

/** Строка + флаг «вставлена ли она именно этим запросом». */
type FindOrCreateRow = ResidentRow & { created: boolean };

export const residentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/residents/find-or-create',
    {
      schema: {
        description: 'Найти жителя по max_chat_id или создать нового',
        body: FindOrCreateResidentBody,
        response: {
          200: FindOrCreateResidentResponse,
          400: ErrorResponse,
        },
      },
    },
    async (request) => {
      const { max_chat_id, house_id = null } = request.body;

      // Одним запросом вместо SELECT + INSERT: между ними два параллельных
      // /start от одного человека успели бы создать дубль. UNIQUE на
      // max_chat_id + ON CONFLICT снимают гонку на уровне БД.
      //
      // COALESCE: если house_id уже известен, а пришёл пустой — не затираем.
      //
      // xmax = 0 — приём PostgreSQL, отличающий INSERT от UPDATE в одном
      // запросе: у только что вставленной строки xmax нулевой.
      const { rows } = await pool.query<FindOrCreateRow>(
        `INSERT INTO residents (max_chat_id, house_id)
         VALUES ($1, $2)
         ON CONFLICT (max_chat_id) DO UPDATE
           SET house_id = COALESCE(EXCLUDED.house_id, residents.house_id)
         RETURNING id, max_chat_id, house_id, created_at, (xmax = 0) AS created`,
        [max_chat_id, house_id],
      );

      const row = rows[0];

      if (!row) {
        // Недостижимо: INSERT ... RETURNING всегда отдаёт строку либо бросает.
        throw new Error('residents find-or-create не вернул строку');
      }

      return { resident: toResidentDto(row), created: row.created };
    },
  );
};
