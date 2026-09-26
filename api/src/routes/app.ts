/**
 * Мини-приложение жителя — ПУБЛИЧНЫЕ маршруты /app/*, через nginx как
 * https://<домен мини-аппа>/api/app/*. Согласовано 24–26.09.2026.
 *
 * Кто спрашивает, api узнаёт не из запроса, а из подписи: мини-апп шлёт
 * initData MAX в заголовке X-Max-Init-Data, api проверяет подпись токеном
 * бота (init-data.ts) и берёт из неё user.id. Житель — тот, к кому этот
 * аккаунт MAX привязан входом в бота по контакту (residents.max_user_id).
 * id жителя с клиента не принимается ни в каком виде — только свои заявки.
 *
 * Поэтому здесь нет rejectProxied: эти маршруты и должны приходить через
 * nginx. Все остальные маршруты api по-прежнему только изнутри сервера.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import { initDataInvalid, miniappDisabled, notLinked } from '../errors.js';
import { verifyInitData } from '../init-data.js';
import type { Rules } from '../routing.js';
import { AppCreateTicketBody, AppMeResponse, ErrorResponse, TicketListResponse, TicketResponse } from '../schemas.js';
import { createTicket, residentTickets, ticketDto } from '../ticket-store.js';
import { houseOfResident } from './residents.js';

/** Житель по подписанному initData; иначе — ошибка с понятным кодом. */
async function authenticate(request: FastifyRequest): Promise<number> {
  if (!config.botToken) {
    request.log.error('MAX_BOT_TOKEN не задан — проверить initData мини-аппа нечем');
    throw miniappDisabled();
  }

  const header = request.headers['x-max-init-data'];
  const check = verifyInitData(typeof header === 'string' ? header : undefined, config.botToken, config.initDataMaxAgeSec);
  if (!check.ok) {
    // Причину — в лог, сам initData — нет: это пропуск жителя.
    request.log.warn({ reason: check.reason }, 'initData мини-аппа отклонён');
    throw initDataInvalid();
  }

  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM residents WHERE max_user_id = $1 AND archived_at IS NULL',
    [check.userId],
  );
  const resident = rows[0];
  if (!resident) {
    request.log.info({ user_id: check.userId }, 'мини-апп: аккаунт MAX не привязан к жителю');
    throw notLinked();
  }
  return resident.id;
}

const AuthErrors = { 401: ErrorResponse, 403: ErrorResponse, 503: ErrorResponse };

export const appRoutes: FastifyPluginAsyncTypebox<{ rules: Rules }> = async (app, { rules }) => {
  app.get(
    '/app/me',
    {
      schema: {
        description: 'Мини-апп: кто я и мой дом (адрес, чат, телефон АДС, газ, УК)',
        response: { 200: AppMeResponse, ...AuthErrors },
      },
    },
    async (request) => {
      const residentId = await authenticate(request);
      const house = await houseOfResident(residentId);
      return { resident_id: residentId, house: house ?? null };
    },
  );

  app.get(
    '/app/tickets',
    {
      schema: {
        description: 'Мини-апп: мои заявки, новые сверху (активные и решённые)',
        response: { 200: TicketListResponse, ...AuthErrors },
      },
    },
    async (request) => {
      const residentId = await authenticate(request);
      const rows = await residentTickets(residentId, false);
      return { tickets: rows.map((row) => ticketDto(rules, row)) };
    },
  );

  app.post(
    '/app/tickets',
    {
      schema: {
        description: 'Мини-апп: подать заявку от своего имени — с той же маршрутизацией, что и в боте',
        body: AppCreateTicketBody,
        response: { 201: TicketResponse, 400: ErrorResponse, ...AuthErrors },
      },
    },
    async (request, reply) => {
      const residentId = await authenticate(request);
      const { problem_type, place = null, description = null, detail_code = null } = request.body;
      const ticket = await createTicket(rules, request.log, {
        resident_id: residentId,
        problem_type,
        place,
        description,
        detail_code,
      });
      request.log.info({ resident_id: residentId, ticket_id: ticket.id, rule: ticket.rule_id }, 'заявка из мини-аппа');
      return reply.code(201).send({ ticket: ticketDto(rules, ticket) });
    },
  );
};
