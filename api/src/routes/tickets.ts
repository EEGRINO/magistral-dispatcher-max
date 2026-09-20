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
import {
  CreateTicketBody,
  ErrorResponse,
  TicketIdParams,
  TicketResponse,
  toTicketDto,
  type TicketRow,
} from '../schemas.js';

/** Поля заявки, возвращаемые наружу. Один список на оба запроса. */
const TICKET_COLUMNS = `
  id, resident_id, house_id, problem_type, place, status,
  assigned_organization_id, deadline_at, created_at, updated_at
`;

export const ticketRoutes: FastifyPluginAsyncTypebox = async (app) => {
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
      const { resident_id, problem_type, place = null } = request.body;

      // Заявка и первая запись в истории создаются вместе или не создаются
      // вовсе: заявка без события 'created' сломала бы ленту событий.
      const ticket = await withTransaction(async (client) => {
        const residentResult = await client.query<{ id: number; house_id: number | null }>(
          'SELECT id, house_id FROM residents WHERE id = $1',
          [resident_id],
        );

        const resident = residentResult.rows[0];

        if (!resident) {
          throw notFound(`Житель ${resident_id} не найден`);
        }

        // house_id копируем из жителя в саму заявку: житель может переехать,
        // заявка должна остаться привязанной к дому, где была проблема.
        const inserted = await client.query<TicketRow>(
          `INSERT INTO tickets (resident_id, house_id, problem_type, place)
           VALUES ($1, $2, $3, $4)
           RETURNING ${TICKET_COLUMNS}`,
          [resident_id, resident.house_id, problem_type, place],
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
