/**
 * Заявки — создание, чтение, перевод в DTO. Общее для маршрутов бота
 * (routes/tickets.ts) и мини-приложения (routes/app.ts): заявка из любого
 * канала маршрутизируется и пишет историю одинаково.
 *
 * При создании заявка маршрутизируется по config/rules.yaml (routing.ts):
 * сработавшее правило, ответственная организация дома и нормативный срок
 * записываются в саму заявку — снимком на момент создания.
 */
import type { FastifyBaseLogger } from 'fastify';
import { pool, withTransaction } from './db.js';
import { houseNotLinked, houseRequired, notCancellable, notFound } from './errors.js';
import { MANUAL_RULE_ID, RESPONSIBLE_LABEL, resolve, type Responsible, type Rules } from './routing.js';
import { toTicketDto, type TicketDto, type TicketRow } from './schemas.js';

/** Заявка с названием ответственной организации. Один запрос на все маршруты. */
export const TICKET_SELECT = `
  SELECT t.id, t.resident_id, t.house_id, t.problem_type, t.place, t.description, t.detail_code,
         t.rule_id, t.status, t.assigned_organization_id, t.deadline_at, t.created_at, t.updated_at,
         o.name AS assigned_organization_name, h.timezone AS house_timezone,
         (SELECT max(e.created_at) FROM ticket_events e
           WHERE e.ticket_id = t.id AND e.event_type = 'status_changed') AS status_changed_at
    FROM tickets t
    LEFT JOIN organizations o ON o.id = t.assigned_organization_id
    LEFT JOIN houses h ON h.id = t.house_id`;

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

/**
 * Ответственный и сверенность срока — по правилу заявки. Правило ищется в
 * текущем rules.yaml: исчезло из файла — ответственный из БД остаётся, а срок
 * считаем несверенным.
 */
export function ticketDto(rules: Rules, row: TicketRow): TicketDto {
  const rule = row.rule_id ? rules.byId.get(row.rule_id) : undefined;
  return toTicketDto(row, {
    responsible_name: row.assigned_organization_name ?? (rule ? RESPONSIBLE_LABEL[rule.responsible] ?? null : null),
    deadline_verified: rule?.deadlineVerified ?? false,
  });
}

export interface NewTicket {
  resident_id: number;
  problem_type: string;
  place: string | null;
  description: string | null;
  detail_code: string | null;
  /** Дом заявки из домов жителя; не передан — единственный дом жителя. */
  house_id?: number | undefined;
}

/**
 * Создать заявку с маршрутизацией и событием created; житель не найден — 404.
 * Домов у жителя несколько, а дом не указан — 400 house_required: молча
 * отправить заявку в УК другого дома хуже, чем переспросить.
 */
export async function createTicket(rules: Rules, log: FastifyBaseLogger, input: NewTicket): Promise<TicketRow> {
  const { resident_id, problem_type, place, description, detail_code } = input;

  // Заявка и первая запись в истории создаются вместе или не создаются
  // вовсе: заявка без события 'created' сломала бы ленту событий.
  return withTransaction(async (client) => {
    const residentResult = await client.query<{ id: number }>(
      // Житель из архива заявок не подаёт: для бота его уже нет.
      'SELECT id FROM residents WHERE id = $1 AND archived_at IS NULL',
      [resident_id],
    );
    if (!residentResult.rows[0]) throw notFound(`Житель ${resident_id} не найден`);

    const housesResult = await client.query<{ house_id: number }>(
      'SELECT DISTINCT house_id FROM resident_premises WHERE resident_id = $1',
      [resident_id],
    );
    const houseIds = housesResult.rows.map((row) => Number(row.house_id));
    let houseId: number | null;
    if (input.house_id !== undefined) {
      if (!houseIds.includes(input.house_id)) throw houseNotLinked();
      houseId = input.house_id;
    } else if (houseIds.length > 1) {
      throw houseRequired();
    } else {
      houseId = houseIds[0] ?? null;
    }
    const resident = { house_id: houseId };

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

    const route = resolve(rules, { problemType: problem_type, place, detail: detail_code }, house ? { hasGas: house.has_gas } : null);
    // Ошибка проверки (газ в доме без газа) заявку не теряет: житель уже
    // написал о проблеме — пусть разберёт диспетчер (ручная классификация).
    const rule = route.ok ? route.rule : rules.byId.get(MANUAL_RULE_ID)!;
    if (!route.ok || route.fallback) {
      log.warn(
        { resident_id, problem_type, place, detail_code, reason: route.ok ? 'no_rule' : route.reason },
        'заявка не нашла правило — на ручную классификацию',
      );
    }

    // house_id копируем в саму заявку: житель может переехать, заявка должна
    // остаться привязанной к дому, где была проблема.
    // Срок — от момента создания, в часах из правила; нет числа — NULL.
    const inserted = await client.query<{ id: number; status: string }>(
      `INSERT INTO tickets (resident_id, house_id, problem_type, place, description, detail_code,
                            rule_id, assigned_organization_id, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               now() + $9::numeric * interval '1 hour')
       RETURNING id, status`,
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
    if (!row) throw new Error('INSERT tickets не вернул строку');

    await client.query(
      `INSERT INTO ticket_events (ticket_id, event_type, new_status)
       VALUES ($1, 'created', $2)`,
      [row.id, row.status],
    );

    // Перечитываем с названием организации — тем же запросом, что и GET.
    const created = await client.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [row.id]);
    return created.rows[0]!;
  });
}

/**
 * Житель отменяет свою заявку. Только «принятую» (решение 26.09.2026): взятую в
 * работу отменяет УК. Заявка остаётся в БД со статусом cancelled; событие
 * status_changed пишет триггер (0007). Сразу пишем и notified: отмену житель
 * сделал сам — присылать ему уведомление «отменена» незачем.
 * Чужая или несуществующая заявка — один ответ 404.
 */
export async function cancelTicket(residentId: number, ticketId: number): Promise<TicketRow> {
  await withTransaction(async (client) => {
    const current = await client.query<{ status: string }>(
      'SELECT status FROM tickets WHERE id = $1 AND resident_id = $2 FOR UPDATE',
      [ticketId, residentId],
    );
    const ticket = current.rows[0];
    if (!ticket) throw notFound(`Заявка ${ticketId} не найдена`);
    if (ticket.status !== 'new') throw notCancellable();

    await client.query("UPDATE tickets SET status = 'cancelled' WHERE id = $1", [ticketId]);
    await client.query(
      `INSERT INTO ticket_events (ticket_id, event_type, new_status) VALUES ($1, 'notified', 'cancelled')`,
      [ticketId],
    );
  });

  const { rows } = await pool.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [ticketId]);
  return rows[0]!;
}

/** Заявки жителя, новые сверху; activeOnly — только незакрытые. Не больше 50. */
export async function residentTickets(residentId: number, activeOnly: boolean): Promise<TicketRow[]> {
  const { rows } = await pool.query<TicketRow>(
    `${TICKET_SELECT}
      WHERE t.resident_id = $1
        ${activeOnly ? "AND t.status IN ('new', 'in_progress')" : ''}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 50`,
    [residentId],
  );
  return rows;
}
