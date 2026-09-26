/**
 * Жители. Их заранее заводит УК (для демо — seed): телефон и дом. Бот при входе
 * только привязывает к записи диалог и пользователя MAX.
 *
 * Все эндпоинты — ВНУТРЕННИЕ, для бота по сети compose. Наружу через nginx их
 * публиковать нельзя: подлинность номера проверяет бот (подпись контакта MAX),
 * а api верит ему на слово. Открытый наружу link-by-phone позволил бы привязать
 * к себе чужую квартиру, просто назвав её номер.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { parseAddress } from '../address.js';
import { pool } from '../db.js';
import { rejectProxied } from '../internal-only.js';
import { addressUnrecognized, houseNotFound, notFound, phoneNotRegistered } from '../errors.js';
import {
  ErrorResponse,
  HouseByAddressBody,
  HouseByInviteBody,
  HouseByInviteResponse,
  HouseListResponse,
  HouseResponse,
  LinkByPhoneBody,
  MaxUserIdParams,
  ResidentIdParams,
  ResidentResponse,
  DEFAULT_TIMEZONE,
  toResidentDto,
  type HouseDto,
  type ResidentRow,
} from '../schemas.js';

/**
 * house_id жителя — дом основной (первой) квартиры, для клиентов, которые
 * знают один дом (0009). Все дома — housesOfResident.
 */
const RESIDENT_COLUMNS = `id, max_chat_id, max_user_id, created_at,
  (SELECT p.house_id FROM resident_premises p WHERE p.resident_id = residents.id ORDER BY p.id LIMIT 1) AS house_id`;

/**
 * Дома жителя по его квартирам, основной первым; две квартиры в одном доме —
 * один дом. undefined — жителя нет, [] — дом неизвестен.
 */
export async function housesOfResident(residentId: number): Promise<HouseDto[] | undefined> {
  const exists = await pool.query('SELECT 1 FROM residents WHERE id = $1', [residentId]);
  if (exists.rowCount === 0) return undefined;

  const { rows } = await pool.query<{
    id: number;
    address: string;
    chat_link: string | null;
    emergency_phone: string | null;
    has_gas: boolean;
    uk_name: string | null;
    timezone: string | null;
  }>(
    `SELECT h.id, h.address, h.chat_link, h.emergency_phone, h.has_gas, o.name AS uk_name, h.timezone
       FROM resident_premises p
       JOIN houses h ON h.id = p.house_id
       LEFT JOIN organizations o ON o.id = h.organization_id
      WHERE p.resident_id = $1
      GROUP BY h.id, o.name
      ORDER BY min(p.id)`,
    [residentId],
  );

  return rows.map((row) => ({ ...row, timezone: row.timezone ?? DEFAULT_TIMEZONE }));
}

/**
 * Дом основной квартиры: undefined — жителя нет, null — житель есть, дом неизвестен.
 */
export async function houseOfResident(residentId: number): Promise<HouseDto | null | undefined> {
  const houses = await housesOfResident(residentId);
  return houses === undefined ? undefined : (houses[0] ?? null);
}

/**
 * Завести жителю квартиру в этом доме, только если ни одной квартиры у него
 * ещё нет. Данные УК главнее того, что пришло из QR или ввёл сам житель
 * (решение 24.09.2026): известные дома не трогаем. Второй дом житель себе
 * не добавляет — его заводит УК.
 */
async function assignHouseIfEmpty(residentId: number, houseId: number): Promise<void> {
  await pool.query(
    `INSERT INTO resident_premises (resident_id, house_id)
     SELECT $1, $2
      WHERE EXISTS (SELECT 1 FROM residents WHERE id = $1 AND archived_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM resident_premises WHERE resident_id = $1)
     ON CONFLICT DO NOTHING`,
    [residentId, houseId],
  );
}

/**
 * Дом по QR или адресу для жителя: свой — он и есть; домов нет — этот
 * становится домом жителя; иначе — дом основной квартиры (данные УК главнее).
 */
async function resolveHouse(residentId: number, houseId: number): Promise<HouseDto | undefined> {
  let houses = await housesOfResident(residentId);
  if (houses === undefined) return undefined;
  if (houses.length === 0) {
    await assignHouseIfEmpty(residentId, houseId);
    houses = (await housesOfResident(residentId)) ?? [];
  }
  const house = houses.find((h) => h.id === houseId) ?? houses[0];
  // После assignHouseIfEmpty дом известен всегда: либо был, либо записан.
  if (!house) throw new Error('у жителя нет дома после записи из QR или адреса');
  return house;
}

export const residentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Только для запросов изнутри сервера, см. internal-only.ts. Хук объявлен
  // внутри этого плагина — /health и /tickets он не касается.
  app.addHook('onRequest', rejectProxied);

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

      // Архивных жителей не трогаем: для бота их номера как будто нет.
      //
      // Одним UPDATE, без предварительного SELECT: нет гонки между проверкой
      // и записью. Если квартира уже была привязана к другому аккаунту MAX —
      // перезаписываем: номер подтверждён подписью MAX, значит сейчас он
      // принадлежит именно этому аккаунту.
      //
      // Если этот аккаунт MAX уже привязан к ДРУГОЙ квартире, сработает UNIQUE
      // на max_user_id и ответ будет 409 conflict — одна квартира на аккаунт.
      const { rows } = await pool.query<ResidentRow & { relinked: boolean }>(
        `WITH previous AS (
           SELECT max_user_id AS old_user_id FROM residents
            WHERE phone = $1 AND archived_at IS NULL
         )
         UPDATE residents
            SET max_chat_id = $2, max_user_id = $3, updated_at = now()
          WHERE phone = $1 AND archived_at IS NULL
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
        `SELECT ${RESIDENT_COLUMNS} FROM residents WHERE max_user_id = $1 AND archived_at IS NULL`,
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

  app.get(
    '/residents/:id/houses',
    {
      schema: {
        description: 'Дома жителя по его квартирам, основной первым; пусто — дом неизвестен',
        params: ResidentIdParams,
        response: { 200: HouseListResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const houses = await housesOfResident(request.params.id);
      if (houses === undefined) throw notFound(`Житель ${request.params.id} не найден`);
      return { houses };
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

      const house = await resolveHouse(id, invited.id);
      if (house === undefined) throw notFound(`Житель ${id} не найден`);

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

      const house = await resolveHouse(id, found.id);
      if (house === undefined) throw notFound(`Житель ${id} не найден`);
      return { house };
    },
  );
};
