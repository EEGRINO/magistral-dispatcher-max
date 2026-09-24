/**
 * Жители. Их заранее заводит УК (для демо — seed): телефон и дом. Бот при входе
 * только привязывает к записи диалог и пользователя MAX.
 *
 * Оба эндпоинта — ВНУТРЕННИЕ, для бота по сети compose. Наружу через nginx их
 * публиковать нельзя: подлинность номера проверяет бот (подпись контакта MAX),
 * а api верит ему на слово. Открытый наружу link-by-phone позволил бы привязать
 * к себе чужую квартиру, просто назвав её номер.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { pool } from '../db.js';
import { notFound, phoneNotRegistered } from '../errors.js';
import {
  ErrorResponse,
  LinkByPhoneBody,
  MaxUserIdParams,
  ResidentResponse,
  toResidentDto,
  type ResidentRow,
} from '../schemas.js';

const RESIDENT_COLUMNS = 'id, house_id, max_chat_id, max_user_id, created_at';

export const residentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/residents/link-by-phone',
    {
      schema: {
        description: 'Привязать диалог и пользователя MAX к жителю с этим номером',
        body: LinkByPhoneBody,
        response: {
          200: ResidentResponse,
          400: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request) => {
      const { phone, max_chat_id, max_user_id } = request.body;

      // Одним UPDATE, без предварительного SELECT: нет гонки между проверкой
      // и записью. Если квартира уже была привязана к другому аккаунту MAX —
      // перезаписываем: номер подтверждён подписью MAX, значит сейчас он
      // принадлежит именно этому аккаунту.
      //
      // Если этот аккаунт MAX уже привязан к ДРУГОЙ квартире, сработает UNIQUE
      // на max_user_id и ответ будет 409 conflict — одна квартира на аккаунт.
      const { rows } = await pool.query<ResidentRow & { relinked: boolean }>(
        `WITH previous AS (
           SELECT max_user_id AS old_user_id FROM residents WHERE phone = $1
         )
         UPDATE residents
            SET max_chat_id = $2, max_user_id = $3
          WHERE phone = $1
      RETURNING ${RESIDENT_COLUMNS},
                (SELECT old_user_id IS NOT NULL AND old_user_id <> $3 FROM previous) AS relinked`,
        [phone, max_chat_id, max_user_id],
      );

      const row = rows[0];

      if (!row) {
        throw phoneNotRegistered();
      }

      if (row.relinked) {
        // Номер телефона в лог не пишем — только id записи.
        request.log.warn({ resident_id: row.id }, 'квартира перепривязана к другому аккаунту MAX');
      }

      return { resident: toResidentDto(row) };
    },
  );

  app.get(
    '/residents/by-max-user/:max_user_id',
    {
      schema: {
        description: 'Житель, к которому привязан этот пользователь MAX',
        params: MaxUserIdParams,
        response: {
          200: ResidentResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const { max_user_id } = request.params;

      const { rows } = await pool.query<ResidentRow>(
        `SELECT ${RESIDENT_COLUMNS} FROM residents WHERE max_user_id = $1`,
        [max_user_id],
      );

      const row = rows[0];

      if (!row) {
        throw notFound(`Пользователь MAX ${max_user_id} не привязан к жителю`);
      }

      return { resident: toResidentDto(row) };
    },
  );
};
