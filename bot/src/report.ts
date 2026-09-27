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
  meter_replacement: '🔢 Замена счётчиков ГВС/ХВС',
  other: '❓ Другое / не уверен',
} as const;
export type ProblemType = keyof typeof PROBLEM_TYPES;

/**
 * Услуги — «Заказать услугу» в меню бота и в мини-аппе (схема разработчика,
 * 27.09.2026). Заявка как у проблемы: те же шаги описания и подтверждения,
 * в УК (config/rules.yaml).
 */
export const SERVICE_TYPES = {
  meter_verification: '🔎 Поверка счётчика ХВС/ГВС',
  radiator_replacement: '♨️ Замена батарей отопления',
} as const;
export type ServiceType = keyof typeof SERVICE_TYPES;

/** Тип заявки из черновика: проблема (кроме газа — он сразу авария) или услуга. */
export type TicketType = Exclude<ProblemType, 'gas'> | ServiceType;

export const isServiceType = (value: string): value is ServiceType => value in SERVICE_TYPES;

/** Подпись типа заявки — проблемы и услуги. */
export const ticketTypeLabel = (type: TicketType): string =>
  isServiceType(type) ? SERVICE_TYPES[type] : PROBLEM_TYPES[type];

/**
 * Где в квартире: счётчики — кухня или ванная, батареи — кухня или комната.
 * Дальше у счётчиков — ГВС/ХВС, у комнаты — сколько комнат.
 */
export const ROOMS = { kitchen: '🍳 Кухня', bathroom: '🛁 Ванная комната', room: '🛏️ Комната' } as const;
export type Room = keyof typeof ROOMS;

/** Типы со шагом «где в квартире» — и какие помещения у каждого. */
export const ROOMS_BY_TYPE: Partial<Record<TicketType, Room[]>> = {
  meter_replacement: ['kitchen', 'bathroom'],
  meter_verification: ['kitchen', 'bathroom'],
  radiator_replacement: ['kitchen', 'room'],
};

export const isMeterType = (type: TicketType | undefined): boolean =>
  type === 'meter_replacement' || type === 'meter_verification';

export const WATER = { hot: '🔴 ГВС — горячая вода', cold: '🔵 ХВС — холодная вода' } as const;
export type Water = keyof typeof WATER;

/** Сколько комнат — словами: detail_code в api только из латинских букв и «_». */
export const ROOM_COUNTS = { one: '1', two: '2', three: '3', four: '4', five_plus: '5 и больше' } as const;
export type RoomCount = keyof typeof ROOM_COUNTS;

/**
 * Подпись уточнения для жителя по detail_code: «Кухня, ГВС», «Комната, комнат: 2».
 * Остальные коды (riser, valve…) жителю не показываем — null.
 */
export function detailLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const water = /^(kitchen|bathroom)_(hot|cold)$/.exec(code);
  if (water) return `${water[1] === 'kitchen' ? 'Кухня' : 'Ванная комната'}, ${water[2] === 'hot' ? 'ГВС' : 'ХВС'}`;
  if (code === 'kitchen') return 'Кухня';
  const rooms = /^rooms_(one|two|three|four|five_plus)$/.exec(code);
  if (rooms) return `Комната, комнат: ${ROOM_COUNTS[rooms[1] as RoomCount]}`;
  return null;
}

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
  meter_replacement: ['in_apartment'],
  other: ['in_apartment', 'entrance', 'whole_house', 'street'],
};

export const isProblemType = (value: string): value is ProblemType => value in PROBLEM_TYPES;
export const isPlace = (value: string): value is Place => value in PLACES;

/** Чья зона собственника: протечка из оборудования или одна розетка/выключатель. */
export type OwnerZone = 'leak' | 'electricity';

/** Дом жителя — снимок на время заявки: адрес, телефон АДС, газ, название УК. */
export interface DraftHouse {
  /** id дома — уходит в заявку: у жителя может быть несколько домов (0009). */
  id: number;
  address: string;
  emergency_phone: string | null;
  has_gas: boolean;
  uk_name: string | null;
}

/** Черновик заявки — в памяти бота, как ожидание адреса. */
export interface ReportDraft {
  residentId: number;
  /** null — дом жителя неизвестен или ещё не выбран. */
  house: DraftHouse | null;
  /**
   * Шаг house — «В каком доме проблема?»: первый, только у жителя с
   * квартирами в нескольких домах (кейс 10 чек-листа, решение 26.09.2026).
   */
  step:
    | 'house'
    | 'type'
    | 'clarify'
    | 'place'
    | 'leak_source'
    | 'owner'
    | 'room'
    | 'water'
    | 'rooms_count'
    | 'description'
    | 'confirm';
  /** service — «Заказать услугу»: на шаге type список услуг, а не проблем. */
  mode?: 'service';
  /** Из каких домов выбирать на шаге house. */
  houses?: DraftHouse[];
  type?: TicketType;
  place?: Place;
  /** Где в квартире — счётчики и батареи. */
  room?: Room;
  /** На экране зоны собственника — чьей. */
  ownerZone?: OwnerZone;
  /**
   * Ответ на уточнение — tickets.detail_code, по нему api выбирает правило
   * (detail в config/rules.yaml): riser, valve, unknown, moderate, sewage,
   * chute, outage, broken, owner_override.
   */
  detail?: string;
  description?: string | null;
  /** Предыдущие состояния черновика — для «Назад»: последнее — куда вернуться. */
  history?: ReportDraft[];
}
