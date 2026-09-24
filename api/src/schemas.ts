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

/** Только то, что нужно жителю: адрес для подтверждения и ссылка на чат. */
export const House = Type.Object({
  id: Id,
  address: Type.String(),
  chat_link: Nullable(Type.String()),
});

export const ResidentIdParams = Type.Object({ id: Id });

/** house: null — дом жителя ещё неизвестен (УК его не указала, житель не вводил). */
export const HouseResponse = Type.Object({ house: Nullable(House) });

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

// ── Заявка ─────────────────────────────────────────────────────────────

export const TicketStatus = Type.Union([
  Type.Literal('new'),
  Type.Literal('in_progress'),
  Type.Literal('resolved'),
]);

export const Ticket = Type.Object({
  id: Id,
  resident_id: Id,
  house_id: Nullable(Id),
  problem_type: Type.String(),
  place: Nullable(Type.String()),
  status: TicketStatus,
  assigned_organization_id: Nullable(Id),
  deadline_at: Nullable(Type.String({ format: 'date-time' })),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
});

export const CreateTicketBody = Type.Object(
  {
    resident_id: Id,
    problem_type: Type.String({ minLength: 1, maxLength: 200 }),
    place: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 200 }))),
  },
  { additionalProperties: false },
);

export const TicketResponse = Type.Object({ ticket: Ticket });

export const TicketIdParams = Type.Object({ id: Id });

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
  status: 'new' | 'in_progress' | 'resolved';
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

export const toTicketDto = (row: TicketRow): TicketDto => ({
  id: row.id,
  resident_id: row.resident_id,
  house_id: row.house_id,
  problem_type: row.problem_type,
  place: row.place,
  status: row.status,
  assigned_organization_id: row.assigned_organization_id,
  deadline_at: row.deadline_at ? row.deadline_at.toISOString() : null,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});
