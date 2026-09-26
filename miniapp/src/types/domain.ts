/**
 * Модель мини-аппа = модель api (docs/api.md, объект Ticket). Коды и подписи
 * типов, мест и опасностей — те же, что у бота (bot/src/report.ts,
 * bot/src/status.ts): житель должен видеть одинаковые слова в обоих местах.
 */

export const PROBLEM_TYPES = {
  leak: '💧 Протечка / потоп',
  blockage: '🚽 Засор',
  heating: '🌡️ Нет отопления / холодно',
  electricity: '⚡ Электричество',
  elevator: '🛗 Лифт',
  gas: '🔥 Запах газа',
  common_area: '🏢 Подъезд / двор',
  structural: '🪟 Окна / двери / кровля',
  pests: '🐜 Насекомые / грызуны',
  other: '❓ Другое / не уверен',
} as const;
export type ProblemType = keyof typeof PROBLEM_TYPES;

export const PLACES = {
  in_apartment: '🏠 У меня в квартире',
  entrance: '🚪 В подъезде',
  whole_house: '🏘️ Во всём доме',
  street: '🛣️ На улице / во дворе',
} as const;
export type Place = keyof typeof PLACES;

/** Допустимые места типа — как у бота. Газ мест не имеет: сразу экстренная ветка. */
export const PLACES_BY_TYPE: Record<Exclude<ProblemType, 'gas'>, Place[]> = {
  leak: ['in_apartment', 'entrance', 'whole_house'],
  blockage: ['in_apartment', 'entrance', 'whole_house', 'street'],
  heating: ['in_apartment', 'whole_house'],
  electricity: ['in_apartment', 'entrance', 'whole_house'],
  elevator: ['entrance'],
  common_area: ['entrance', 'street'],
  structural: ['in_apartment', 'entrance', 'whole_house'],
  pests: ['in_apartment', 'entrance', 'whole_house'],
  other: ['in_apartment', 'entrance', 'whole_house', 'street'],
};

/** Аварийная заявка: problem_type — код опасности, отдельного поля приоритета нет. */
export const DANGER_TYPES = {
  gas_smell: '🔥 Запах газа',
  exposed_wiring: '⚠️ Искрит проводка',
  flooding_threat: '🌊 Угроза затопления',
  elevator_entrapment: '🆘 Человек застрял в лифте',
} as const;
export type DangerType = keyof typeof DANGER_TYPES;

export type TicketStatus = 'new' | 'in_progress' | 'resolved' | 'cancelled';

/** Подписи статусов — свои у мини-аппа (решение 24.09.2026), коды — api. */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  new: 'В рассмотрении',
  in_progress: 'В работе',
  resolved: 'Решено',
  cancelled: 'Отменена',
};

/** Незакрытая заявка: ещё ждёт или в работе. */
export const isActive = (status: TicketStatus): boolean => status === 'new' || status === 'in_progress';

/** Поля объекта Ticket из docs/api.md, которые показывает мини-апп. */
export interface Ticket {
  id: number;
  problem_type: string;
  place: string | null;
  description: string | null;
  status: TicketStatus;
  created_at: string;
  responsible_name: string | null;
  deadline_at: string | null;
  deadline_verified: boolean;
}

/** Дом жителя — как у бота в черновике заявки (bot/src/report.ts, DraftHouse). */
export interface House {
  address: string;
  chat_link: string | null;
  emergency_phone: string | null;
  has_gas: boolean;
  uk_name: string | null;
}

export const isEmergency = (problemType: string): boolean => problemType in DANGER_TYPES;

/** «Что случилось» по коду; незнакомый код — как есть. */
export function problemLabel(problemType: string): string {
  if (problemType in PROBLEM_TYPES) return PROBLEM_TYPES[problemType as ProblemType];
  if (problemType in DANGER_TYPES) return DANGER_TYPES[problemType as DangerType];
  return problemType;
}

export function placeLabel(place: string | null): string | null {
  return place !== null && place in PLACES ? PLACES[place as Place] : null;
}

/**
 * Дата и время подачи — «26.09.2026, 17:34» в часовом поясе устройства жителя
 * (решение 26.09.2026): браузер его знает, в отличие от бота.
 */
const createdDate = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const formatCreated = (iso: string): string => createdDate.format(new Date(iso));
