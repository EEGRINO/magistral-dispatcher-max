/**
 * Петля «смена статуса → уведомление жителю». Согласовано 26.09.2026.
 *
 *   УК / диспетчер: POST /admin/tickets/:id/status  → событие status_changed
 *   бот, раз в несколько секунд: GET /notifications/pending
 *   бот, отправив жителю:        POST /notifications/:event_id/delivered → событие notified
 *
 * Очередь — сами события заявки (ticket_events), отдельной таблицы нет: тип
 * notified был в схеме с 0001. Статус меняет только api, пишет в MAX только
 * бот — токен бота в api не нужен.
 *
 * Все маршруты ВНУТРЕННИЕ (internal-only.ts): вызывают их команда УК на
 * сервере и бот. Экран диспетчера в мини-приложении ляжет на эти же маршруты,
 * когда у него будет вход с проверкой initData.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { pool, withTransaction } from '../db.js';
import { notFound } from '../errors.js';
import { rejectProxied } from '../internal-only.js';
import { RESPONSIBLE_LABEL, type Rules } from '../routing.js';
import {
  AdminTicketListQuery,
  AdminTicketListResponse,
  ChangeStatusBody,
  ChangeStatusResponse,
  DeliveredResponse,
  ErrorResponse,
  EventIdParams,
  PendingNotificationsQuery,
  PendingNotificationsResponse,
  TicketIdParams,
} from '../schemas.js';

type Status = 'new' | 'in_progress' | 'resolved';

interface AdminTicketRow {
  id: number;
  resident_id: number;
  house_address: string | null;
  problem_type: string;
  place: string | null;
  detail_code: string | null;
  description: string | null;
  rule_id: string | null;
  status: Status;
  organization_name: string | null;
  deadline_at: Date | null;
  created_at: Date;
}

const ADMIN_TICKET_SELECT = `
  SELECT t.id, t.resident_id, h.address AS house_address, t.problem_type, t.place, t.detail_code,
         t.description, t.rule_id, t.status, o.name AS organization_name, t.deadline_at, t.created_at
    FROM tickets t
    LEFT JOIN houses h ON h.id = t.house_id
    LEFT JOIN organizations o ON o.id = t.assigned_organization_id`;

export const dispatchRoutes: FastifyPluginAsyncTypebox<{ rules: Rules }> = async (app, { rules }) => {
  app.addHook('onRequest', rejectProxied);

  /** Ответственный — как в Ticket: организация, иначе подпись службы из правила. */
  const responsibleName = (row: { organization_name: string | null; rule_id: string | null }): string | null => {
    if (row.organization_name) return row.organization_name;
    const rule = row.rule_id ? rules.byId.get(row.rule_id) : undefined;
    return rule ? RESPONSIBLE_LABEL[rule.responsible] ?? null : null;
  };

  const toAdminTicket = (row: AdminTicketRow) => ({
    id: row.id,
    resident_id: row.resident_id,
    house_address: row.house_address,
    problem_type: row.problem_type,
    place: row.place,
    detail_code: row.detail_code,
    description: row.description,
    rule_id: row.rule_id,
    status: row.status,
    responsible_name: responsibleName(row),
    deadline_at: row.deadline_at ? row.deadline_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  });

  // ── УК / диспетчер ──────────────────────────────────────────────────────

  app.get(
    '/admin/tickets',
    {
      schema: {
        description: 'Заявки для УК/диспетчера, новые сверху; фильтры: дом, только незакрытые',
        querystring: AdminTicketListQuery,
        response: { 200: AdminTicketListResponse },
      },
    },
    async (request) => {
      const where: string[] = [];
      const values: unknown[] = [];
      if (request.query.house_id !== undefined) {
        values.push(request.query.house_id);
        where.push(`t.house_id = $${values.length}`);
      }
      if (request.query.active) where.push("t.status <> 'resolved'");

      const { rows } = await pool.query<AdminTicketRow>(
        `${ADMIN_TICKET_SELECT}
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT 200`,
        values,
      );
      return { tickets: rows.map(toAdminTicket) };
    },
  );

  app.post(
    '/admin/tickets/:id/status',
    {
      schema: {
        description: 'Сменить статус заявки; житель получит уведомление от бота',
        params: TicketIdParams,
        body: ChangeStatusBody,
        response: { 200: ChangeStatusResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const { id } = request.params;
      const { status } = request.body;

      // Статус и событие — в одной транзакции: событие без смены статуса
      // (или наоборот) дало бы жителю уведомление о том, чего не было.
      const changed = await withTransaction(async (client) => {
        const current = await client.query<{ status: Status }>('SELECT status FROM tickets WHERE id = $1 FOR UPDATE', [
          id,
        ]);
        const before = current.rows[0];
        if (!before) throw notFound(`Заявка ${id} не найдена`);
        if (before.status === status) return false;

        // updated_at обновит триггер (0001).
        await client.query('UPDATE tickets SET status = $2 WHERE id = $1', [id, status]);
        await client.query(
          `INSERT INTO ticket_events (ticket_id, event_type, old_status, new_status)
           VALUES ($1, 'status_changed', $2, $3)`,
          [id, before.status, status],
        );
        return true;
      });

      if (changed) request.log.info({ ticket_id: id, status }, 'статус заявки изменён');

      const { rows } = await pool.query<AdminTicketRow>(`${ADMIN_TICKET_SELECT} WHERE t.id = $1`, [id]);
      return { ticket: toAdminTicket(rows[0]!), changed };
    },
  );

  // ── бот ─────────────────────────────────────────────────────────────────

  app.get(
    '/notifications/pending',
    {
      schema: {
        description: 'Недоставленные уведомления о смене статуса — по последнему изменению каждой заявки',
        querystring: PendingNotificationsQuery,
        response: { 200: PendingNotificationsResponse },
      },
    },
    async (request) => {
      // Берём только ПОСЛЕДНЮЮ смену статуса заявки: если статус успели
      // сменить дважды (в работе → решена), житель получит одно «решена», а не
      // оба и не устаревшее «в работе» после «решена». Доставлено — если после
      // этого события есть notified. Жителям без привязки к MAX (не входили,
      // в архиве) писать некуда — таких не отдаём.
      const { rows } = await pool.query<{
        event_id: number;
        ticket_id: number;
        new_status: Status;
        problem_type: string;
        organization_name: string | null;
        rule_id: string | null;
        max_chat_id: number;
      }>(
        `WITH latest AS (
           SELECT DISTINCT ON (ticket_id) id, ticket_id, new_status
             FROM ticket_events
            WHERE event_type = 'status_changed'
            ORDER BY ticket_id, id DESC
         )
         SELECT e.id AS event_id, e.ticket_id, e.new_status, t.problem_type, t.rule_id,
                o.name AS organization_name, r.max_chat_id
           FROM latest e
           JOIN tickets t ON t.id = e.ticket_id
           JOIN residents r ON r.id = t.resident_id AND r.archived_at IS NULL AND r.max_chat_id IS NOT NULL
           LEFT JOIN organizations o ON o.id = t.assigned_organization_id
          WHERE NOT EXISTS (
                  SELECT 1 FROM ticket_events n
                   WHERE n.ticket_id = e.ticket_id AND n.event_type = 'notified' AND n.id > e.id
                )
          ORDER BY e.id
          LIMIT $1`,
        [request.query.limit ?? 20],
      );

      return {
        notifications: rows.map((row) => ({
          event_id: row.event_id,
          ticket_id: row.ticket_id,
          new_status: row.new_status,
          problem_type: row.problem_type,
          responsible_name: responsibleName(row),
          max_chat_id: row.max_chat_id,
        })),
      };
    },
  );

  app.post(
    '/notifications/:event_id/delivered',
    {
      schema: {
        description: 'Бот доставил уведомление о смене статуса — записать событие notified',
        params: EventIdParams,
        response: { 200: DeliveredResponse, 404: ErrorResponse },
      },
    },
    async (request) => {
      const { event_id } = request.params;

      // Повторный вызов ничего не дублирует: notified пишется, только если
      // после этого события его ещё нет.
      const { rows } = await pool.query<{ ticket_id: number }>(
        `WITH e AS (
           SELECT id, ticket_id, new_status FROM ticket_events
            WHERE id = $1 AND event_type = 'status_changed'
         ),
         ins AS (
           INSERT INTO ticket_events (ticket_id, event_type, new_status)
           SELECT e.ticket_id, 'notified', e.new_status FROM e
            WHERE NOT EXISTS (
                    SELECT 1 FROM ticket_events n
                     WHERE n.ticket_id = e.ticket_id AND n.event_type = 'notified' AND n.id > e.id
                  )
           RETURNING ticket_id
         )
         SELECT ticket_id FROM e`,
        [event_id],
      );
      if (!rows[0]) throw notFound(`Событие смены статуса ${event_id} не найдено`);
      return { ok: true as const };
    },
  );
};
