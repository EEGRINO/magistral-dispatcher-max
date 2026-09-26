/**
 * «Статус» — житель смотрит свои заявки (шаг C, 24.09.2026; тексты Павла).
 * Здесь только разбор команд и подписи — без сети и без отправки.
 *
 *   «Статус», «/status», «Мои заявки»      → список незакрытых заявок
 *   «Статус 12», «/status №12»             → одна заявка
 *   «12», «№12» (вне сценария заявки)      → одна заявка: ответ на «отправьте номер»
 */
import type { DangerType } from './emergency.js';
import { PROBLEM_TYPES, isProblemType } from './report.js';

export type StatusCommand = { kind: 'list' } | { kind: 'one'; ticketId: number };

const normalize = (text: string): string => text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function toTicketId(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

export function parseStatusCommand(text: string): StatusCommand | null {
  const t = normalize(text);
  if (/^\/?(status|статус)$/.test(t) || t === 'мои заявки') return { kind: 'list' };

  const match = /^\/?(status|статус)( заявки)? ?(№|#)? ?(\d{1,9})$/.exec(t);
  const ticketId = match ? toTicketId(match[4]!) : null;
  return ticketId === null ? null : { kind: 'one', ticketId };
}

/** Сообщение — только номер заявки: «12», «№ 12», «#12». */
export function parseTicketNumber(text: string): number | null {
  const match = /^(№|#)? ?(\d{1,9})$/.exec(normalize(text));
  return match ? toTicketId(match[2]!) : null;
}

/** Статусы заявки для жителя. «принята» — как в текстах Павла. */
export const STATUS_LABELS = { new: 'принята', in_progress: 'в работе', resolved: 'решена', cancelled: 'отменена' } as const;
export type TicketStatus = keyof typeof STATUS_LABELS;

const DANGER_LABELS: Record<DangerType, string> = {
  gas_smell: '🔥 Запах газа',
  exposed_wiring: '⚠️ Искрит проводка',
  flooding_threat: '🌊 Угроза затопления',
  elevator_entrapment: '🆘 Человек застрял в лифте',
};

/** Аварийная заявка — problem_type из danger_types. */
export const isEmergency = (problemType: string): boolean => problemType in DANGER_LABELS;

/** «Что случилось» по коду заявки; незнакомый код (заявка из старой версии) — как есть. */
export function problemLabel(problemType: string): string {
  if (isProblemType(problemType)) return PROBLEM_TYPES[problemType];
  if (problemType in DANGER_LABELS) return DANGER_LABELS[problemType as DangerType];
  return problemType;
}
