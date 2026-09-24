/**
 * Справочник УК: дома и жители. Согласовано 24.09.2026.
 *
 * ВНУТРЕННИЕ маршруты: вызывает их команда УК на сервере (api/src/cli.ts),
 * наружу через nginx не публикуются, а на запросы через прокси отвечают 404
 * (internal-only.ts). Входа для сотрудников УК пока нет — поэтому и только
 * изнутри сервера. Веб-панель УК потом ляжет на эти же маршруты.
 *
 * Жителей не удаляем, а переводим в архив: на них ссылаются заявки.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { parseAddress } from '../address.js';
import { pool } from '../db.js';
import { addressUnrecognized, notFound, residentArchived } from '../errors.js';
import { rejectProxied } from '../internal-only.js';
import {
  AdminHouseListResponse,
  AdminHouseResponse,
  AdminResidentListResponse,
  AdminResidentResponse,
  CreateHouseBody,
  CreateResidentBody,
  ErrorResponse,
  HouseListQuery,
  ResidentIdParams,
  ResidentListQuery,
  UpdateHouseBody,
  UpdateResidentBody,
} from '../schemas.js';

// ── Дома ───────────────────────────────────────────────────────────────

interface AdminHouseRow {
  id: number;
  address: string;
  street: string | null;
  number: string | null;
  chat_link: string | null;
  invite_code: string;
  residents: number;
  created_at: Date;
}

const HOUSE_SELECT = `
  SELECT h.id, h.address, h.street, h.number, h.chat_link, h.invite_code, h.created_at,
         (SELECT count(*) FROM residents r
           WHERE r.house_id = h.id AND r.archived_at IS NULL)::int AS residents
    FROM houses h`;

const toAdminHouse = (row: AdminHouseRow) => ({ ...row, created_at: row.created_at.toISOString() });

async function loadHouse(id: number) {
  const { rows } = await pool.query<AdminHouseRow>(`${HOUSE_SELECT} WHERE h.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw notFound(`Дом ${id} не найден`);
  return toAdminHouse(row);
}

/** Адрес как его написала УК → улица и номер для поиска; не разобрался — 400. */
function requireParsed(address: string) {
  const parsed = parseAddress(address);
  if (!parsed) throw addressUnrecognized();
  return parsed;
}

// ── Жители ─────────────────────────────────────────────────────────────

interface AdminResidentRow {
  id: number;
  phone: string;
  house_id: number | null;
  house_address: string | null;
  entrance: number | null;
  floor: number | null;
  apartment: string | null;
  contract_number: string | null;
  max_linked: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const RESIDENT_SELECT = `
  SELECT r.id, r.phone, r.house_id, h.address AS house_address,
         r.entrance, r.floor, r.apartment, r.contract_number,
         (r.max_user_id IS NOT NULL) AS max_linked,
         r.archived_at, r.created_at, r.updated_at
    FROM residents r
    LEFT JOIN houses h ON h.id = r.house_id`;

const toAdminResident = (row: AdminResidentRow) => ({
  ...row,
  archived_at: row.archived_at ? row.archived_at.toISOString() : null,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});

async function loadResident(id: number) {
  const { rows } = await pool.query<AdminResidentRow>(`${RESIDENT_SELECT} WHERE r.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw notFound(`Житель ${id} не найден`);
  return toAdminResident(row);
}

/** Поля «где живёт», которые можно менять, — в порядке колонок таблицы. */
const PLACE_COLUMNS = ['house_id', 'entrance', 'floor', 'apartment', 'contract_number'] as const;

// ── Маршруты ───────────────────────────────────────────────────────────

export const adminRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('onRequest', rejectProxied);

  app.get(
    '/admin/houses',
    {
      schema: {
        description: 'Дома УК; с ?address= — только дом с этим адресом (0 или 1)',
        querystring: HouseListQuery,
        response: { 200: AdminHouseListResponse, 400: ErrorResponse },
      },
    },
    async (request) => {
      const { address } = request.query;

      if (address === undefined) {
        const { rows } = await pool.query<AdminHouseRow>(`${HOUSE_SELECT} ORDER BY h.address`);
        return { houses: rows.map(toAdminHouse) };
      }

      const { street, number } = requireParsed(address);
      const { rows } = await pool.query<AdminHouseRow>(`${HOUSE_SELECT} WHERE h.street = $1 AND h.number = $2`, [
        street,
        number,
      ]);
      return { houses: rows.map(toAdminHouse) };
    },
  );

  app.post(
    '/admin/houses',
    {
      schema: {
        description: 'Завести дом. Адрес разбирается на улицу и номер — как при вводе жителем',
        body: CreateHouseBody,
        response: { 201: AdminHouseResponse, 400: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { address, chat_link = null } = request.body;
      const { street, number } = requireParsed(address);

      // Дубль адреса или пары улица+номер — UNIQUE в БД → 409 conflict.
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO houses (address, street, number, chat_link)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [address.trim(), street, number, chat_link],
      );

      reply.code(201);
      return { house: await loadHouse(rows[0]!.id) };
    },
  );

  app.patch(
    '/admin/houses/:id',
    {
      schema: {
        description: 'Изменить адрес дома и/или ссылку на чат (chat_link: null — убрать)',
        params: ResidentIdParams,
        body: UpdateHouseBody,
        response: { 200: AdminHouseResponse, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => {
      const { id } = request.params;
      const { address, chat_link } = request.body;

      const sets: string[] = [];
      const values: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };

      if (address !== undefined) {
        const { street, number } = requireParsed(address);
        set('address', address.trim());
        set('street', street);
        set('number', number);
      }
      if (chat_link !== undefined) set('chat_link', chat_link);

      const { rowCount } = await pool.query(`UPDATE houses SET ${sets.join(', ')} WHERE id = $1`, values);
      if (rowCount === 0) throw notFound(`Дом ${id} не найден`);

      return { house: await loadHouse(id) };
    },
  );

  app.get(
    '/admin/residents',
    {
      schema: {
        description: 'Жители; фильтры по дому и телефону, архив — по include_archived',
        querystring: ResidentListQuery,
        response: { 200: AdminResidentListResponse, 400: ErrorResponse },
      },
    },
    async (request) => {
      const { house_id, phone, include_archived } = request.query;

      const where: string[] = [];
      const values: unknown[] = [];
      if (house_id !== undefined) {
        values.push(house_id);
        where.push(`r.house_id = $${values.length}`);
      }
      if (phone !== undefined) {
        values.push(phone);
        where.push(`r.phone = $${values.length}`);
      }
      if (!include_archived) where.push('r.archived_at IS NULL');

      const { rows } = await pool.query<AdminResidentRow>(
        `${RESIDENT_SELECT}
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY h.address NULLS LAST, r.entrance NULLS LAST, r.apartment NULLS LAST, r.id`,
        values,
      );
      return { residents: rows.map(toAdminResident) };
    },
  );

  app.post(
    '/admin/residents',
    {
      schema: {
        description: 'Завести жителя. Телефон уникален среди жителей не в архиве',
        body: CreateResidentBody,
        response: { 201: AdminResidentResponse, 400: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const body = request.body;

      // Несуществующий house_id — FK → 400 invalid_reference;
      // номер уже заведён — UNIQUE → 409 conflict.
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO residents (phone, ${PLACE_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [body.phone, ...PLACE_COLUMNS.map((column) => body[column] ?? null)],
      );

      reply.code(201);
      return { resident: await loadResident(rows[0]!.id) };
    },
  );

  app.patch(
    '/admin/residents/:id',
    {
      schema: {
        description: 'Изменить телефон, дом, подъезд, этаж, квартиру, договор (null — стереть)',
        params: ResidentIdParams,
        body: UpdateResidentBody,
        response: { 200: AdminResidentResponse, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => {
      const { id } = request.params;
      const body = request.body;

      const sets: string[] = ['updated_at = now()'];
      const values: unknown[] = [id];
      const param = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };

      if (body.phone !== undefined) {
        // Номер сменился — привязку к MAX снимаем. Аккаунт MAX привязан тем,
        // кто подтвердил СТАРЫЙ номер; с новым номером он квартиру не получает,
        // пока не подтвердит его сам — просто войдёт в бота заново.
        // В SET справа видны СТАРЫЕ значения строки, поэтому сравнение честное.
        const p = param(body.phone);
        sets.push(
          `phone = ${p}`,
          `max_user_id = CASE WHEN phone = ${p} THEN max_user_id END`,
          `max_chat_id = CASE WHEN phone = ${p} THEN max_chat_id END`,
        );
      }
      for (const column of PLACE_COLUMNS) {
        if (body[column] !== undefined) sets.push(`${column} = ${param(body[column])}`);
      }

      const { rows } = await pool.query<{ id: number }>(
        `UPDATE residents SET ${sets.join(', ')}
          WHERE id = $1 AND archived_at IS NULL
      RETURNING id`,
        values,
      );

      if (!rows[0]) {
        const existing = await loadResident(id); // нет вовсе — 404 отсюда
        if (existing.archived_at) throw residentArchived();
        throw new Error('UPDATE жителя не затронул строку без видимой причины');
      }

      if (body.phone !== undefined) {
        // Номер в лог не пишем — только id записи.
        request.log.info({ resident_id: id }, 'телефон жителя изменён УК');
      }
      return { resident: await loadResident(id) };
    },
  );

  app.post(
    '/admin/residents/:id/archive',
    {
      schema: {
        description: 'Убрать жителя в архив: войти больше нельзя, заявки остаются. Повторный вызов — без изменений',
        params: ResidentIdParams,
        response: { 200: AdminResidentResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const { id } = request.params;

      // Привязку к MAX снимаем вместе с архивом: этот аккаунт MAX должен
      // иметь возможность войти в новую запись (если номер заведут заново).
      await pool.query(
        `UPDATE residents
            SET archived_at = now(), max_user_id = NULL, max_chat_id = NULL, updated_at = now()
          WHERE id = $1 AND archived_at IS NULL`,
        [id],
      );

      return { resident: await loadResident(id) };
    },
  );
};
