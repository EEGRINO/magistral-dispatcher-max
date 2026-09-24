/**
 * Обычная заявка в диалоге — модель Павла (config/rules.yaml, тексты бота от
 * 23–24.09.2026), согласовано 24.09.2026 (docs/Решения_проекта.md):
 *
 *   что случилось → уточнение (опасно? зона собственника?) → где →
 *   откуда течёт (протечка в квартире) → описание → подтверждение → номер
 *
 * Здесь только справочник: коды, подписи, допустимые места. Коды — это type и
 * place из config/rules.yaml, в заявке — problem_type и place.
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

/**
 * Какие места бывают у типа — объединение place правил этого типа в
 * config/rules.yaml. Кнопок других мест не показываем: правила для них нет.
 * `yard` в rules.yaml здесь — `street`: какое имя финальное, решает Павел.
 * Газ — сразу экстренная ветка, места у него не спрашиваем.
 * TODO: брать из config/rules.yaml, когда появится маршрутизация.
 */
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

export const isProblemType = (value: string): value is ProblemType => value in PROBLEM_TYPES;
export const isPlace = (value: string): value is Place => value in PLACES;

/** Чья зона собственника: протечка из оборудования или одна розетка/выключатель. */
export type OwnerZone = 'leak' | 'electricity';

/** Дом жителя — снимок на время заявки: адрес, телефон АДС, газ, название УК. */
export interface DraftHouse {
  address: string;
  emergency_phone: string | null;
  has_gas: boolean;
  uk_name: string | null;
}

/** Черновик заявки — в памяти бота, как ожидание адреса. */
export interface ReportDraft {
  residentId: number;
  /** null — дом жителя неизвестен. */
  house: DraftHouse | null;
  step: 'type' | 'clarify' | 'place' | 'leak_source' | 'owner' | 'description' | 'confirm';
  type?: Exclude<ProblemType, 'gas'>;
  place?: Place;
  /** На экране зоны собственника — чьей. */
  ownerZone?: OwnerZone;
  /**
   * Ответ на уточнение — tickets.detail_code, по нему api выбирает правило
   * (detail в config/rules.yaml): riser, valve, unknown, moderate, sewage,
   * chute, outage, broken, owner_override.
   */
  detail?: string;
  description?: string | null;
}
