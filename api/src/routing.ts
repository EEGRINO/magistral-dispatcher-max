/**
 * Маршрутизация заявок по config/rules.yaml (Павел; согласовано 24.09.2026).
 *
 * Правила читаются из YAML при старте api — справочник правится без пересборки
 * образа, как задумано для config/. Ошибка в файле — api не стартует и говорит,
 * какое правило и какое поле не так: молча работать на полуразобранных правилах
 * опаснее, чем не подняться.
 *
 * Выбор правила — чистая функция resolve() без БД: её напрямую проверяют тесты
 * Павла (docs/routing-test-cases.json, api/test/routing.test.mjs).
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export const RESPONSIBLE = [
  'management_company',
  'rso_water',
  'rso_heat',
  'rso_electricity',
  'rso_gas',
  'gas_emergency_service',
  'owner',
] as const;
export type Responsible = (typeof RESPONSIBLE)[number];

export interface Rule {
  id: string;
  type: string;
  place: string[];
  /** Ответы на уточнение, при которых правило подходит; null — общее правило типа. */
  detail: string[] | null;
  responsible: Responsible;
  danger: boolean;
  ownerZone: boolean;
  /** routing: manual — диспетчер классифицирует вручную. */
  manual: boolean;
  /** Нормативный срок в часах; null — числа нет. */
  deadlineHours: number | null;
  /**
   * Срок сверен с первоисточником (deadline_verified: true в rules.yaml ставит
   * Павел). Пока false — жителю срок не показывается вовсе (решение 24.09.2026):
   * цифры «средней уверенности» называть нельзя.
   */
  deadlineVerified: boolean;
}

export interface Rules {
  rules: Rule[];
  byId: Map<string, Rule>;
  dangerTypes: Set<string>;
}

/**
 * Ответственный, у которого нет организации в доме, — как его назвать жителю.
 * Остальные категории — название организации из БД.
 */
export const RESPONSIBLE_LABEL: Partial<Record<Responsible, string>> = {
  gas_emergency_service: 'аварийная газовая служба (104)',
};

/** Правило ручной классификации — и для «Другое», и запасной выход (fallback_policy). */
export const MANUAL_RULE_ID = 'other_unsure';

/** «Всё равно передать в УК» из зоны собственника — к диспетчеру вручную (тексты Павла). */
export const OWNER_OVERRIDE = 'owner_override';

class RulesError extends Error {}

function fail(where: string, message: string): never {
  throw new RulesError(`config/rules.yaml, ${where}: ${message}`);
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);

function parseRule(raw: unknown, index: number): Rule {
  if (typeof raw !== 'object' || raw === null) fail(`rules[${index}]`, 'правило должно быть объектом');
  const r = raw as Record<string, unknown>;
  const where = `правило ${typeof r.id === 'string' ? r.id : `rules[${index}]`}`;

  if (typeof r.id !== 'string' || !r.id) fail(where, 'нет id');
  if (typeof r.type !== 'string' || !r.type) fail(where, 'нет type');
  if (!isStringArray(r.place) || r.place.length === 0) fail(where, 'place — непустой список мест');
  if (r.detail !== undefined && (!isStringArray(r.detail) || r.detail.length === 0)) {
    fail(where, 'detail — непустой список кодов ответа');
  }
  if (!(RESPONSIBLE as readonly unknown[]).includes(r.responsible)) {
    fail(where, `responsible «${String(r.responsible)}» не из responsible_categories`);
  }
  if (typeof r.danger !== 'boolean') fail(where, 'danger — true или false');
  const hours = r.deadline_hours;
  if (hours !== undefined && hours !== null && (typeof hours !== 'number' || !(hours > 0))) {
    fail(where, 'deadline_hours — положительное число или null');
  }
  if (r.routing !== undefined && r.routing !== 'manual') fail(where, 'routing — только manual');
  if (r.deadline_verified !== undefined && typeof r.deadline_verified !== 'boolean') {
    fail(where, 'deadline_verified — true или false');
  }

  return {
    id: r.id,
    type: r.type,
    place: r.place,
    detail: (r.detail as string[] | undefined) ?? null,
    responsible: r.responsible as Responsible,
    danger: r.danger,
    ownerZone: r.owner_zone === true,
    manual: r.routing === 'manual',
    deadlineHours: typeof hours === 'number' ? hours : null,
    deadlineVerified: r.deadline_verified === true,
  };
}

export function parseRules(text: string): Rules {
  const doc = parse(text) as { rules?: unknown; danger_types?: unknown } | null;
  if (!doc || !Array.isArray(doc.rules)) fail('корень', 'нет списка rules');

  const rules = doc.rules.map(parseRule);
  const byId = new Map<string, Rule>();
  for (const rule of rules) {
    if (byId.has(rule.id)) fail(`правило ${rule.id}`, 'id повторяется');
    byId.set(rule.id, rule);
  }

  if (!isStringArray(doc.danger_types)) fail('danger_types', 'нужен список id правил');
  for (const id of doc.danger_types) {
    if (!byId.has(id)) fail('danger_types', `нет правила ${id}`);
  }
  if (!byId.has(MANUAL_RULE_ID)) fail('rules', `нет правила ${MANUAL_RULE_ID} — без него некуда деть неизвестный тип`);

  return { rules, byId, dangerTypes: new Set(doc.danger_types) };
}

export function loadRules(path: string): Rules {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new RulesError(
      `Не прочитан файл правил ${path}: ${error instanceof Error ? error.message : String(error)}\n` +
        '  В Docker: папка config/ монтируется в api (docker-compose.yml); локально — RULES_PATH',
    );
  }
  return parseRules(text);
}

// ── выбор правила ─────────────────────────────────────────────────────────

export interface RouteInput {
  /** Тип (leak, gas…) или id опасного правила (gas_smell…) у аварийной заявки. */
  problemType: string;
  place: string | null;
  detail: string | null;
}

/** Что нужно знать о доме для выбора правила. */
export interface HouseFacts {
  hasGas: boolean;
}

export type RouteResult =
  /** fallback — тип или сочетание не нашлись, ушло на ручную классификацию (WARN в лог). */
  | { ok: true; rule: Rule; fallback: boolean }
  | { ok: false; reason: 'house_not_found' | 'gas_without_supply' };

/**
 * «Двор»: в rules.yaml — yard, бот шлёт street. Пока Павел не выбрал одно имя,
 * считаем их одним местом.
 */
const YARD = new Set(['yard', 'street']);

function placeMatches(rule: Rule, place: string | null): boolean {
  if (place === null) return true;
  if (rule.place.includes(place)) return true;
  return YARD.has(place) && rule.place.some((p) => YARD.has(p));
}

/**
 * Правило для заявки.
 *
 * house: объект — дом известен; null — дом жителя не указан (правило всё равно
 * выбирается, ответственного назначить некому); undefined — дом указан, но в
 * базе его нет (TC-28) → ошибка.
 *
 * Порядок:
 * 1. Аварийная заявка приходит с id опасного правила — оно и есть. Запах газа
 *    по словам принимаем и в доме без газа: пахнуть может с улицы или от соседей.
 * 2. «Всё равно передать в УК» — ручная классификация.
 * 3. Тип «газ» в доме без газа — ошибка (fallback_policy.gas_without_supply).
 * 4. Правила того же типа и места: с detail — только если ответ жителя в
 *    списке; из подошедших правило с detail точнее общего.
 * 5. Ничего не подошло — ручная классификация, fallback (fallback_policy.unknown_type).
 */
export function resolve(rules: Rules, input: RouteInput, house: HouseFacts | null | undefined): RouteResult {
  if (house === undefined) return { ok: false, reason: 'house_not_found' };

  const manual = rules.byId.get(MANUAL_RULE_ID)!;

  const danger = rules.dangerTypes.has(input.problemType) ? rules.byId.get(input.problemType) : undefined;
  if (danger) return { ok: true, rule: danger, fallback: false };

  if (input.detail === OWNER_OVERRIDE) return { ok: true, rule: manual, fallback: false };

  if (input.problemType === 'gas' && house !== null && !house.hasGas) {
    return { ok: false, reason: 'gas_without_supply' };
  }

  const candidates = rules.rules.filter(
    (rule) =>
      rule.type === input.problemType &&
      placeMatches(rule, input.place) &&
      (rule.detail === null || (input.detail !== null && rule.detail.includes(input.detail))),
  );
  const rule = candidates.find((r) => r.detail !== null) ?? candidates[0];

  return rule ? { ok: true, rule, fallback: false } : { ok: true, rule: manual, fallback: true };
}
