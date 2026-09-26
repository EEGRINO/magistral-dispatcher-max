/**
 * Заявки — маршруты для бота. Создание и чтение — ticket-store.ts, общий с
 * мини-приложением (routes/app.ts).
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { pool } from '../db.js';
import { notFound } from '../errors.js';
import { rejectProxied } from '../internal-only.js';
import type { Rules } from '../routing.js';
import {
  CancelTicketBody,
  CreateTicketBody,
  ErrorResponse,
  ResidentIdParams,
  ResidentTicketsQuery,
  TicketIdParams,
  TicketListResponse,
  TicketResponse,
  type TicketRow,
} from '../schemas.js';
import { TICKET_SELECT, cancelTicket, createTicket, residentTickets, ticketDto } from '../ticket-store.js';

export const ticketRoutes: FastifyPluginAsyncTypebox<{ rules: Rules }> = async (app, { rules }) => {
  // Внутренние: бот передаёт resident_id, и api ему верит. Снаружи — 404,
  // см. internal-only.ts. Мини-апп ходит в свои маршруты с проверкой initData.
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
      const { resident_id, problem_type, place = null, description = null, detail_code = null, house_id } = request.body;
      const ticket = await createTicket(rules, request.log, {
        resident_id,
        problem_type,
        place,
        description,
        detail_code,
        house_id,
      });
      return reply.code(201).send({ ticket: ticketDto(rules, ticket) });
    },
  );

  app.post(
    '/tickets/:id/cancel',
    {
      schema: {
        description: 'Житель отменяет свою «принятую» заявку (бот передаёт resident_id)',
        params: TicketIdParams,
        body: CancelTicketBody,
        response: { 200: TicketResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request) => {
      const ticket = await cancelTicket(request.body.resident_id, request.params.id);
      request.log.info({ resident_id: request.body.resident_id, ticket_id: ticket.id }, 'заявка отменена жителем');
      return { ticket: ticketDto(rules, ticket) };
    },
  );

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

      const rows = await residentTickets(id, request.query.active === true);
      return { tickets: rows.map((row) => ticketDto(rules, row)) };
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
      const { rows } = await pool.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [id]);
      const row = rows[0];
      if (!row) throw notFound(`Заявка ${id} не найдена`);
      return { ticket: ticketDto(rules, row) };
    },
  );
};
