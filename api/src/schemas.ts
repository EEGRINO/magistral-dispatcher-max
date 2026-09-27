/**
 * Схемы запросов и ответов + перевод строк БД в DTO.
 *
 * Это же — исполняемая версия контракта из docs/api.md: Fastify по этим
 * схемам валидирует вход и сериализует ответ, поэтому ответ физически
 * не может содержать поля, которых здесь нет.
 *
 * Имена полей в DTO намеренно snake_case, как в БД: лишний слой
 * переименований на MVP только добавляет мест, где можно ошибиться.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';

/** T или null — в JSON Schema это union, отдельного «nullable» там нет. */
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/**
 * T или null — для ВХОДНЫХ данных (тело запроса). Не anyOf, а nullable:
 * Fastify проверяет вход с приведением типов (coerceTypes), и в anyOf
 * [integer, null] ajv сначала пробует integer и превращает null в 0 —
 * «стереть этаж» записало бы этаж 0. С nullable null принимается как есть.
 */
const NullableInput = <T extends TSchema>(schema: T) =>
  Type.Unsafe<Static<T> | null>({ ...schema, nullable: true });

/** Положительный целый идентификатор. */
const Id = Type.Integer({ minimum: 1 });

// ── Ошибки ─────────────────────────────────────────────────────────────

export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String({ description: 'Машиночитаемый код ошибки' }),
      message: Type.String({ description: 'Пояснение для человека' }),
      details: Type.Optional(
        Type.Array(Type.String(), { description: 'Подробности валидации, если есть' }),
      ),
    }),
  },
  { $id: 'ErrorResponse' },
);

// ── /health ────────────────────────────────────────────────────────────

export const HealthResponse = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  service: Type.Literal('api'),
  db: Type.Union([Type.Literal('ok'), Type.Literal('down')]),
  ts: Type.String({ format: 'date-time' }),
});

// ── Житель ─────────────────────────────────────────────────────────────

/** Телефон в нормализованном виде — ровно так он хранится в БД. */
const Phone = Type.String({ pattern: '^\\+7[0-9]{10}$', description: '+7 и 10 цифр' });

/**
 * Номер телефона наружу не отдаётся: это персональные данные, а клиентам api
 * (бот, мини-апп) он не нужен — житель и так знает свой номер.
 */
export const Resident = Type.Object({
  id: Id,
  /** Дом основной (первой) квартиры; все дома жителя — GET /residents/:id/houses. */
  house_id: Nullable(Id),
  max_chat_id: Nullable(Type.Integer()),
  max_user_id: Nullable(Type.Integer()),
  created_at: Type.String({ format: 'date-time' }),
});

export const LinkByPhoneBody = Type.Object(
  {
    phone: Phone,
    max_chat_id: Type.Integer({ minimum: 1, description: 'chat_id диалога с ботом в MAX' }),
    max_user_id: Type.Integer({ minimum: 1, description: 'id пользователя MAX' }),
  },
  // Лишние поля — почти всегда опечатка на стороне клиента, и молча их
  // проглатывать хуже, чем сразу сказать об этом.
  { additionalProperties: false },
);

export const MaxUserIdParams = Type.Object({ max_user_id: Id });

export const ResidentResponse = Type.Object({ resident: Resident });

// ── Дом жителя ─────────────────────────────────────────────────────────

/** Только то, что нужно боту: адрес, чат, данные для экстренной ветки. */
export const House = Type.Object({
  id: Id,
  address: Type.String(),
  chat_link: Nullable(Type.String()),
  /** Телефон АДС дома; null — бот называет 112. */
  emergency_phone: Nullable(Type.String()),
  /** false — у дома нет газа, кнопку «Запах газа» бот не показывает. */
  has_gas: Type.Boolean(),
  /** Название УК/ТСЖ дома — «оформлю срочную заявку в …»; null — не указана. */
  uk_name: Nullable(Type.String()),
  /** Часовой пояс дома (IANA) — по нему бот показывает время подачи заявки. */
  timezone: Type.String(),
});

export const ResidentIdParams = Type.Object({ id: Id });

/**
 * house: null — дом жителя ещё неизвестен (УК его не указала, житель не вводил).
 * У жителя с несколькими домами — дом основной квартиры.
 */
export const HouseResponse = Type.Object({ house: Nullable(House) });

/** Дома жителя по его квартирам, основной первым; пусто — дом неизвестен. */
export const HouseListResponse = Type.Object({ houses: Type.Array(House) });

export const HouseByInviteBody = Type.Object(
  {
    // Формат кода не фиксируем жёстко: сейчас это 12 hex-знаков, но УК может
    // завести свой. Ограничение — как у payload диплинка MAX (docs/max-notes.md).
    invite_code: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }),
  },
  { additionalProperties: false },
);

export const HouseByInviteResponse = Type.Object({
  house: House,
  /** true — у жителя по данным УК другой дом; показан он, а не дом из QR. */
  mismatch: Type.Boolean(),
});

export const HouseByAddressBody = Type.Object(
  { address: Type.String({ minLength: 1, maxLength: 200, description: 'как ввёл житель' }) },
  { additionalProperties: false },
);

// ── УК: дома и жители (/admin, только изнутри сервера) ─────────────────
//
// Здесь телефон жителя отдаётся: это рабочий список УК, а не ответ жителю.

const ChatLink = Type.String({ pattern: '^https://', maxLength: 2048 });
const AddressText = Type.String({ minLength: 1, maxLength: 200 });

export const AdminHouse = Type.Object({
  id: Id,
  address: Type.String(),
  /** Нормализованные улица и номер — по ним житель находит дом вводом адреса. */
  street: Nullable(Type.String()),
  number: Nullable(Type.String()),
  chat_link: Nullable(Type.String()),
  /** Код для QR-ссылки https://max.ru/<бот>?start=<код>. */
  invite_code: Type.String(),
  /** Сколько жителей числится в доме, без архива. */
  residents: Type.Integer({ minimum: 0 }),
  created_at: Type.String({ format: 'date-time' }),
});

export const HouseListQuery = Type.Object(
  { address: Type.Optional(AddressText) },
  { additionalProperties: false },
);

export const CreateHouseBody = Type.Object(
  { address: AddressText, chat_link: Type.Optional(NullableInput(ChatLink)) },
  { additionalProperties: false },
);

export const UpdateHouseBody = Type.Object(
  { address: Type.Optional(AddressText), chat_link: Type.Optional(NullableInput(ChatLink)) },
  { additionalProperties: false, minProperties: 1 },
);

export const AdminHouseResponse = Type.Object({ house: AdminHouse });
export const AdminHouseListResponse = Type.Object({ houses: Type.Array(AdminHouse) });

export const AdminResident = Type.Object({
  id: Id,
  phone: Type.String(),
  house_id: Nullable(Id),
  house_address: Nullable(Type.String()),
  entrance: Nullable(Type.Integer()),
  floor: Nullable(Type.Integer()),
  apartment: Nullable(Type.String()),
  contract_number: Nullable(Type.String()),
  /**
   * Сколько всего квартир у жителя (0009). Поля house_id…contract_number выше —
   * основная квартира; остальные УК ведёт в таблице resident_premises.
   */
  premises_count: Type.Integer(),
  /** Житель уже вошёл в бота. Сам id MAX УК не нужен. */
  max_linked: Type.Boolean(),
  archived_at: Nullable(Type.String({ format: 'date-time' })),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
});

/**
 * Поля основной квартиры. null — стереть значение; поле не передано — не менять.
 * house_id: null — убрать основную квартиру вовсе (следующая станет основной).
 */
const ResidentPlace = {
  house_id: Type.Optional(NullableInput(Id)),
  entrance: Type.Optional(NullableInput(Type.Integer({ minimum: 1, maximum: 100 }))),
  floor: Type.Optional(NullableInput(Type.Integer({ minimum: -5, maximum: 200 }))),
  apartment: Type.Optional(NullableInput(Type.String({ minLength: 1, maxLength: 16 }))),
  contract_number: Type.Optional(NullableInput(Type.String({ minLength: 1, maxLength: 64 }))),
};

export const ResidentListQuery = Type.Object(
  {
    house_id: Type.Optional(Id),
    phone: Type.Optional(Phone),
    include_archived: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

export const CreateResidentBody = Type.Object(
  { phone: Phone, ...ResidentPlace },
  { additionalProperties: false },
);

export const UpdateResidentBody = Type.Object(
  { phone: Type.Optional(Phone), ...ResidentPlace },
  { additionalProperties: false, minProperties: 1 },
);

export const AdminResidentResponse = Type.Object({ resident: AdminResident });
export const AdminResidentListResponse = Type.Object({ residents: Type.Array(AdminResident) });

// ── Мини-приложение (/app, публичные, с проверкой initData) ───────────

export const AppMeResponse = Type.Object({
  resident_id: Id,
  /** null — дом жителя неизвестен (УК не указала, житель не вводил адрес). Несколько — основной. */
  house: Nullable(House),
  /** Все дома жителя по квартирам, основной первым (0009): больше одного — мини-апп спрашивает дом. */
  houses: Type.Array(House),
});

/** Как тело POST /tickets, но без resident_id: жителя определяет api по initData. */
export const AppCreateTicketBody = Type.Object(
  {
    problem_type: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z_]+$' }),
    place: Type.Optional(NullableInput(Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z_]+$' }))),
    description: Type.Optional(NullableInput(Type.String({ minLength: 1, maxLength: 4000 }))),
    detail_code: Type.Optional(NullableInput(Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z_]+$' }))),
    /**
     * Дом заявки — один из домов жителя (0009). Обязателен, если домов
     * несколько: иначе 400 house_required. Не передан при одном доме — он.
     */
    house_id: Type.Optional(Id),
  },
  { additionalProperties: false },
);

// ── Смена статуса и уведомления (/admin/tickets, /notifications) ──────

const TicketStatusValue = Type.Union([
  Type.Literal('new'),
  Type.Literal('in_progress'),
  Type.Literal('resolved'),
  Type.Literal('cancelled'),
]);

/** Заявка в списке УК/диспетчера: с адресом и ответственным. */
export const AdminTicket = Type.Object({
  id: Id,
  resident_id: Id,
  house_address: Nullable(Type.String()),
  problem_type: Type.String(),
  place: Nullable(Type.String()),
  detail_code: Nullable(Type.String()),
  description: Nullable(Type.String()),
  rule_id: Nullable(Type.String()),
  status: TicketStatusValue,
  responsible_name: Nullable(Type.String()),
  deadline_at: Nullable(Type.String({ format: 'date-time' })),
  created_at: Type.String({ format: 'date-time' }),
});

export const AdminTicketListQuery = Type.Object(
  {
    house_id: Type.Optional(Id),
    active: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

export const AdminTicketListResponse = Type.Object({ tickets: Type.Array(AdminTicket) });

export const ChangeStatusBody = Type.Object({ status: TicketStatusValue }, { additionalProperties: false });

export const ChangeStatusResponse = Type.Object({
  ticket: AdminTicket,
  /** false — статус уже был таким, событие не записано, уведомления не будет. */
  changed: Type.Boolean(),
});

/** Недоставленное уведомление о смене статуса — для бота. */
export const PendingNotification = Type.Object({
  event_id: Id,
  ticket_id: Id,
  new_status: TicketStatusValue,
  problem_type: Type.String(),
  responsible_name: Nullable(Type.String()),
  /** Когда статус сменился — время события status_changed. */
  changed_at: Type.String({ format: 'date-time' }),
  /** Часовой пояс дома заявки — по нему бот пишет время; дом неизвестен — Europe/Moscow. */
  timezone: Type.String(),
  /** Куда писать: диалог жителя с ботом. */
  max_chat_id: Type.Integer(),
});

export const PendingNotificationsQuery = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })) },
  { additionalProperties: false },
);

export const PendingNotificationsResponse = Type.Object({ notifications: Type.Array(PendingNotification) });

export const EventIdParams = Type.Object({ event_id: Id });

export const DeliveredResponse = Type.Object({ ok: Type.Literal(true) });

// ── Заявка ─────────────────────────────────────────────────────────────

/** cancelled — отменил житель, пока заявка была «принята» (0008); заявка остаётся в БД. */
export const TicketStatus = Type.Union([
  Type.Literal('new'),
  Type.Literal('in_progress'),
  Type.Literal('resolved'),
  Type.Literal('cancelled'),
]);

export const Ticket = Type.Object({
  id: Id,
  resident_id: Id,
  house_id: Nullable(Id),
  problem_type: Type.String(),
  place: Nullable(Type.String()),
  description: Nullable(Type.String()),
  /** Ответ жителя на уточнение после типа; null — уточнения не было. */
  detail_code: Nullable(Type.String()),
  /** Правило config/rules.yaml, по которому направлена заявка; null — заявка до маршрутизации. */
  rule_id: Nullable(Type.String()),
  /**
   * Кто отвечает — для жителя: название организации или службы
   * («аварийная газовая служба (104)»); null — назначить некого.
   */
  responsible_name: Nullable(Type.String()),
  /** Срок сверен с первоисточником — только тогда deadline_at можно показывать жителю. */
  deadline_verified: Type.Boolean(),
  /** Часовой пояс дома заявки (IANA) — для времени подачи в боте; дом неизвестен — Europe/Moscow. */
  timezone: Type.String(),
  status: TicketStatus,
  /** Когда статус последний раз менялся; null — не менялся с подачи (событие status_changed). */
  status_changed_at: Nullable(Type.String({ format: 'date-time' })),
  assigned_organization_id: Nullable(Id),
  deadline_at: Nullable(Type.String({ format: 'date-time' })),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
});

export const CreateTicketBody = Type.Object(
  {
    resident_id: Id,
    problem_type: Type.String({ minLength: 1, maxLength: 200 }),
    place: Type.Optional(NullableInput(Type.String({ minLength: 1, maxLength: 200 }))),
    /** Своими словами жителя. Длинное сообщение MAX — до 4000 символов. */
    description: Type.Optional(NullableInput(Type.String({ minLength: 1, maxLength: 4000 }))),
    /** Код ответа на уточнение — кнопка бота: riser, valve, chute, one_socket… */
    detail_code: Type.Optional(NullableInput(Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z_]+$' }))),
    /**
     * Дом заявки — один из домов жителя (0009). Обязателен, если домов
     * несколько: иначе 400 house_required. Не передан при одном доме — он.
     */
    house_id: Type.Optional(Id),
  },
  { additionalProperties: false },
);

export const TicketResponse = Type.Object({ ticket: Ticket });

export const TicketIdParams = Type.Object({ id: Id });

/** Бот отменяет заявку от имени жителя — заявка должна быть его. */
export const CancelTicketBody = Type.Object({ resident_id: Id }, { additionalProperties: false });

export const ResidentTicketsQuery = Type.Object(
  {
    /** true — только незакрытые (new, in_progress). */
    active: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

/** Новые сверху; не больше 50 — боту для «Мои заявки» хватает с запасом. */
export const TicketListResponse = Type.Object({ tickets: Type.Array(Ticket) });

// ── Типы ───────────────────────────────────────────────────────────────

export type ResidentDto = Static<typeof Resident>;
export type HouseDto = Static<typeof House>;
export type TicketDto = Static<typeof Ticket>;

// ── Строки БД → DTO ────────────────────────────────────────────────────
//
// Преобразование явное, а не «отдадим строку как есть»: pg возвращает
// TIMESTAMPTZ объектом Date, а контракт обещает ISO-строку. Делать это
// здесь надёжнее, чем полагаться на то, как сериализатор поступит с Date.

export interface ResidentRow {
  id: number;
  /** Дом основной квартиры — подзапрос к resident_premises, см. RESIDENT_COLUMNS. */
  house_id: number | null;
  max_chat_id: number | null;
  max_user_id: number | null;
  created_at: Date;
}

export interface TicketRow {
  id: number;
  resident_id: number;
  house_id: number | null;
  problem_type: string;
  place: string | null;
  description: string | null;
  detail_code: string | null;
  rule_id: string | null;
  assigned_organization_name: string | null;
  house_timezone: string | null;
  status: 'new' | 'in_progress' | 'resolved' | 'cancelled';
  status_changed_at: Date | null;
  assigned_organization_id: number | null;
  deadline_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const toResidentDto = (row: ResidentRow): ResidentDto => ({
  id: row.id,
  house_id: row.house_id,
  max_chat_id: row.max_chat_id,
  max_user_id: row.max_user_id,
  created_at: row.created_at.toISOString(),
});

/** Дом неизвестен — время заявки показываем по Москве, как по умолчанию у дома (0008). */
export const DEFAULT_TIMEZONE = 'Europe/Moscow';

/** Что о заявке знает только маршрутизация (rules.yaml), а не строка БД. */
export interface TicketRouteView {
  responsible_name: string | null;
  deadline_verified: boolean;
}

export const toTicketDto = (row: TicketRow, route: TicketRouteView): TicketDto => ({
  id: row.id,
  resident_id: row.resident_id,
  house_id: row.house_id,
  problem_type: row.problem_type,
  place: row.place,
  description: row.description,
  detail_code: row.detail_code,
  rule_id: row.rule_id,
  responsible_name: route.responsible_name,
  deadline_verified: route.deadline_verified,
  timezone: row.house_timezone ?? DEFAULT_TIMEZONE,
  status: row.status,
  status_changed_at: row.status_changed_at ? row.status_changed_at.toISOString() : null,
  assigned_organization_id: row.assigned_organization_id,
  deadline_at: row.deadline_at ? row.deadline_at.toISOString() : null,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});
