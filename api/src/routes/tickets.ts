/**
 * Заявки.
 *
 * Маршрутизации здесь намеренно нет (Д-8): заявка создаётся со статусом
 * 'new', без организации-исполнителя и без срока. Эти поля заполнит
 * маршрутизатор, когда появится config/rules.yaml.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { pool, withTransaction } from '../db.js';
import { notFound } from '../errors.js';
import { rejectProxied } from '../internal-only.js';
import {
  CreateTicketBody,
  ErrorResponse,
  ResidentIdParams,
  ResidentTicketsQuery,
  TicketIdParams,
  TicketListResponse,
  TicketResponse,
  toTicketDto,
  type TicketRow,
} from '../schemas.js';

/** Поля заявки, возвращаемые наружу. Один список на все запросы. */
const TICKET_COLUMNS = `
  id, resident_id, house_id, problem_type, place, description, status,
  assigned_organization_id, deadline_at, created_at, updated_at
`;

export const ticketRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Внутренние: бот передаёт resident_id, и api ему верит. Снаружи — 404,
  // см. internal-only.ts. Мини-апп получит свои маршруты с проверкой initData.
  app.addHook('onRequest', rejectProxied);

  app.post(
    '/tickets',
    {
      schema: {
        description: 'Создать заявку от имени жителя',
        body: CreateTicketBody,
        response: {
          201: TicketResponse,
          400: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const { resident_id, problem_type, place = null, description = null } = request.body;

      // Заявка и первая запись в истории создаются вместе или не создаются
      // вовсе: заявка без события 'created' сломала бы ленту событий.
      const ticket = await withTransaction(async (client) => {
        const residentResult = await client.query<{ id: number; house_id: number | null }>(
          // Житель из архива заявок не подаёт: для бота его уже нет.
          'SELECT id, house_id FROM residents WHERE id = $1 AND archived_at IS NULL',
          [resident_id],
        );

        const resident = residentResult.rows[0];

        if (!resident) {
          throw notFound(`Житель ${resident_id} не найден`);
        }

        // house_id копируем из жителя в саму заявку: житель может переехать,
        // заявка должна остаться привязанной к дому, где была проблема.
        const inserted = await client.query<TicketRow>(
          `INSERT INTO tickets (resident_id, house_id, problem_type, place, description)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${TICKET_COLUMNS}`,
          [resident_id, resident.house_id, problem_type, place, description],
        );

        const row = inserted.rows[0];

        if (!row) {
          throw new Error('INSERT tickets не вернул строку');
        }

        await client.query(
          `INSERT INTO ticket_events (ticket_id, event_type, new_status)
           VALUES ($1, 'created', $2)`,
          [row.id, row.status],
        );

        return row;
      });

      return reply.code(201).send({ ticket: toTicketDto(ticket) });
    },
  );

  // Здесь, а не в residents.ts: список колонок и перевод в DTO — общие с /tickets.
  app.get(
    '/residents/:id/tickets',
    {
      schema: {
        description: 'Заявки жителя, новые сверху; ?active=true — только незакрытые',
        params: ResidentIdParams,
        querystring: ResidentTicketsQuery,
        response: { 200: TicketListResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const { id } = request.params;

      const resident = await pool.query('SELECT 1 FROM residents WHERE id = $1 AND archived_at IS NULL', [id]);
      if (resident.rowCount === 0) throw notFound(`Житель ${id} не найден`);

      const { rows } = await pool.query<TicketRow>(
        `SELECT ${TICKET_COLUMNS} FROM tickets
          WHERE resident_id = $1
            ${request.query.active ? "AND status <> 'resolved'" : ''}
          ORDER BY created_at DESC, id DESC
          LIMIT 50`,
        [id],
      );
      return { tickets: rows.map(toTicketDto) };
    },
  );

  app.get(
    '/tickets/:id',
    {
      schema: {
        description: 'Получить заявку по номеру',
        params: TicketIdParams,
        response: {
          200: TicketResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request) => {
      const { id } = request.params;

      const { rows } = await pool.query<TicketRow>(
        `SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = $1`,
        [id],
      );

      const row = rows[0];

      if (!row) {
        throw notFound(`Заявка ${id} не найдена`);
      }

      return { ticket: toTicketDto(row) };
    },
  );
};
