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
import { parseAddress } from '../address.js';
import { pool } from '../db.js';
import { addressUnrecognized, houseNotFound, notFound, phoneNotRegistered } from '../errors.js';
import {
  ErrorResponse,
  HouseByAddressBody,
  HouseByInviteBody,
  HouseByInviteResponse,
  HouseResponse,
  LinkByPhoneBody,
  MaxUserIdParams,
  ResidentIdParams,
  ResidentResponse,
  toResidentDto,
  type HouseDto,
  type ResidentRow,
} from '../schemas.js';

const RESIDENT_COLUMNS = 'id, house_id, max_chat_id, max_user_id, created_at';

/**
 * Дом жителя: undefined — жителя нет, null — житель есть, дом неизвестен.
 */
async function houseOfResident(residentId: number): Promise<HouseDto | null | undefined> {
  const { rows } = await pool.query<{ house_id: number | null; address: string | null; chat_link: string | null }>(
    `SELECT h.id AS house_id, h.address, h.chat_link
       FROM residents r
       LEFT JOIN houses h ON h.id = r.house_id
      WHERE r.id = $1`,
    [residentId],
  );

  const row = rows[0];
  if (!row) return undefined;
  if (row.house_id === null || row.address === null) return null;
  return { id: row.house_id, address: row.address, chat_link: row.chat_link };
}

/**
 * Записать дом жителю, только если его дом ещё неизвестен. Данные УК главнее
 * того, что пришло из QR или ввёл сам житель (решение 24.09.2026): уже
 * указанный дом не перезаписываем. Условие в WHERE делает это атомарно.
 */
async function assignHouseIfEmpty(residentId: number, houseId: number): Promise<void> {
  await pool.query('UPDATE residents SET house_id = $2 WHERE id = $1 AND house_id IS NULL', [
    residentId,
    houseId,
  ]);
}

export const residentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Вторая линия защиты — на случай, если nginx снова откроет эти пути наружу
  // (так уже было 24.09.2026: оба домена проксировали в api всё подряд).
  //
  // nginx ставит X-Real-IP / X-Forwarded-For на КАЖДЫЙ проксируемый запрос, и
  // снаружи убрать эти заголовки нельзя. Бот ходит в api напрямую по сети
  // compose и их не шлёт. Значит, запрос с ними пришёл из интернета — отвечаем
  // обычным «маршрута нет», как на любой несуществующий путь: 403 подсказал бы,
  // что здесь что-то охраняется.
  //
  // Намеренно не через trustProxy: он решает, верить ли адресу клиента из этих
  // заголовков, а здесь важен сам факт их наличия. trustProxy не трогаем.
  //
  // Хук объявлен внутри этого плагина — Fastify применяет его только к
  // маршрутам /residents/*, /health и /tickets он не касается.
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers['x-real-ip'] !== undefined || request.headers['x-forwarded-for'] !== undefined) {
      request.log.warn({ url: request.url }, 'внешний запрос к внутреннему /residents — отвечаем 404');
      reply.callNotFound();
      return reply;
    }
  });

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

  app.get(
    '/residents/:id/house',
    {
      schema: {
        description: 'Дом жителя со ссылкой на чат; house: null — дом неизвестен',
        params: ResidentIdParams,
        response: { 200: HouseResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const house = await houseOfResident(request.params.id);
      if (house === undefined) throw notFound(`Житель ${request.params.id} не найден`);
      return { house };
    },
  );

  app.post(
    '/residents/:id/house-by-invite',
    {
      schema: {
        description: 'Дом по коду из QR/диплинка; заполняет дом жителя, если он неизвестен',
        params: ResidentIdParams,
        body: HouseByInviteBody,
        response: { 200: HouseByInviteResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const { id } = request.params;

      const { rows } = await pool.query<{ id: number }>('SELECT id FROM houses WHERE invite_code = $1', [
        request.body.invite_code,
      ]);
      const invited = rows[0];
      if (!invited) throw houseNotFound('Дом с таким кодом не найден');

      await assignHouseIfEmpty(id, invited.id);

      const house = await houseOfResident(id);
      if (house === undefined) throw notFound(`Житель ${id} не найден`);
      // После assignHouseIfEmpty дом известен всегда: либо был, либо записан.
      if (house === null) throw new Error('дом жителя пуст после записи из QR');

      const mismatch = house.id !== invited.id;
      if (mismatch) {
        request.log.warn(
          { resident_id: id, resident_house_id: house.id, invited_house_id: invited.id },
          'QR другого дома — остаётся дом по данным УК',
        );
      }

      return { house, mismatch };
    },
  );

  app.post(
    '/residents/:id/house-by-address',
    {
      schema: {
        description: 'Дом по адресу, введённому жителем; заполняет дом жителя, если он неизвестен',
        params: ResidentIdParams,
        body: HouseByAddressBody,
        response: { 200: HouseResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const { id } = request.params;

      const parsed = parseAddress(request.body.address);
      if (!parsed) throw addressUnrecognized();

      const { rows } = await pool.query<{ id: number }>(
        'SELECT id FROM houses WHERE street = $1 AND number = $2',
        [parsed.street, parsed.number],
      );
      const found = rows[0];
      if (!found) throw houseNotFound('Дом по этому адресу не найден');

      await assignHouseIfEmpty(id, found.id);

      const house = await houseOfResident(id);
      if (house === undefined) throw notFound(`Житель ${id} не найден`);
      return { house };
    },
  );
};
