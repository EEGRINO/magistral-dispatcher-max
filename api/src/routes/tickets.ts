/**
 * Заявки.
 *
 * При создании заявка маршрутизируется по config/rules.yaml (routing.ts):
 * сработавшее правило, ответственная организация дома и нормативный срок
 * записываются в саму заявку — снимком на момент создания.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { pool, withTransaction } from '../db.js';
import { notFound } from '../errors.js';
import { rejectProxied } from '../internal-only.js';
import { MANUAL_RULE_ID, resolve, type Responsible, type Rules } from '../routing.js';
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
  id, resident_id, house_id, problem_type, place, description, detail_code, rule_id, status,
  assigned_organization_id, deadline_at, created_at, updated_at
`;

/** Какая организация дома отвечает по категории правила; null — назначить некого. */
function responsibleOrganization(
  responsible: Responsible,
  house: { organization_id: number | null; rso: Map<string, number> } | null,
): number | null {
  if (!house) return null;
  switch (responsible) {
    case 'management_company':
      return house.organization_id;
    case 'rso_water':
    case 'rso_heat':
    case 'rso_electricity':
    case 'rso_gas':
      return house.rso.get(responsible.slice('rso_'.length)) ?? null;
    // Городская газовая служба (104) — не организация дома; зона собственника — некому.
    case 'gas_emergency_service':
    case 'owner':
      return null;
  }
}

export const ticketRoutes: FastifyPluginAsyncTypebox<{ rules: Rules }> = async (app, { rules }) => {
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
      const { resident_id, problem_type, place = null, description = null, detail_code = null } = request.body;

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

        // Дом для маршрутизации: есть ли газ, УК и РСО по ролям.
        let house: { has_gas: boolean; organization_id: number | null; rso: Map<string, number> } | null = null;
        if (resident.house_id !== null) {
          const houseResult = await client.query<{ has_gas: boolean; organization_id: number | null }>(
            'SELECT has_gas, organization_id FROM houses WHERE id = $1',
            [resident.house_id],
          );
          const rsoResult = await client.query<{ role: string; organization_id: number }>(
            'SELECT role, organization_id FROM house_organizations WHERE house_id = $1',
            [resident.house_id],
          );
          const found = houseResult.rows[0];
          if (found) house = { ...found, rso: new Map(rsoResult.rows.map((r) => [r.role, r.organization_id])) };
        }

        const route = resolve(
          rules,
          { problemType: problem_type, place, detail: detail_code },
          house ? { hasGas: house.has_gas } : null,
        );
        // Ошибка проверки (газ в доме без газа) заявку не теряет: житель уже
        // написал о проблеме — пусть разберёт диспетчер (ручная классификация).
        const rule = route.ok ? route.rule : rules.byId.get(MANUAL_RULE_ID)!;
        if (!route.ok || route.fallback) {
          request.log.warn(
            { resident_id, problem_type, place, detail_code, reason: route.ok ? 'no_rule' : route.reason },
            'заявка не нашла правило — на ручную классификацию',
          );
        }

        // house_id копируем из жителя в саму заявку: житель может переехать,
        // заявка должна остаться привязанной к дому, где была проблема.
        // Срок — от момента создания, в часах из правила; нет числа — NULL.
        const inserted = await client.query<TicketRow>(
          `INSERT INTO tickets (resident_id, house_id, problem_type, place, description, detail_code,
                                rule_id, assigned_organization_id, deadline_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   now() + $9::numeric * interval '1 hour')
           RETURNING ${TICKET_COLUMNS}`,
          [
            resident_id,
            resident.house_id,
            problem_type,
            place,
            description,
            detail_code,
            rule.id,
            responsibleOrganization(rule.responsible, house),
            rule.deadlineHours,
          ],
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
