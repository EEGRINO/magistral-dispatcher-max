/**
 * Клавиатуры бота. Клавиатура — вложение inline_keyboard, форма кнопок —
 * docs/max-notes.md, раздел «Inline-клавиатура». Подписи кнопок заявки — из
 * текстов Павла (24.09.2026).
 */
import { config } from './config.js';
import type { DangerType } from './emergency.js';
import { PLACES, PLACES_BY_TYPE, PROBLEM_TYPES, type OwnerZone, type ProblemType } from './report.js';
import type { MaxAttachment } from './max-api.js';

/** payload кнопок callback — по ним бот понимает, что нажато. */
export const Action = {
  houseChat: 'menu:house_chat',
  cancelAddress: 'address:cancel',
  report: 'menu:report',
  tickets: 'menu:tickets',
  /** «Нет, всё в порядке» после подозрения на опасность по словам. */
  dismissDanger: 'danger:dismiss',
  /** «Я позвонил(а)» после инструкции при запахе газа. */
  gasCalled: 'gas:called',
  skipDescription: 'desc:skip',
  sendTicket: 'ticket:send',
  cancelTicket: 'ticket:cancel',
  /** «« Назад» — предыдущий шаг заявки. */
  back: 'nav:back',
  /** «« Меню» — там, где меню заменилось другим экраном. */
  menu: 'nav:menu',
} as const;

/**
 * Шаги заявки: type:<код>, clar:<ответ>, place:<код>, src:<откуда течёт>,
 * own:<ok|send|alt> — экран зоны собственника.
 */
export const typeAction = (type: ProblemType): string => `type:${type}`;
export const placeAction = (place: keyof typeof PLACES): string => `place:${place}`;

/** Подтверждение опасности, заподозренной по словам: danger_confirm:<тип>. */
export const confirmDangerAction = (type: DangerType): string => `danger_confirm:${type}`;

type Button = Record<string, unknown>;

const callback = (text: string, payload: string): Button[] => [{ type: 'callback', text, payload }];

/** Пустую клавиатуру не шлём вовсе: как MAX отнесётся к buttons: [], дока не говорит. */
function keyboard(rows: Button[][]): MaxAttachment[] {
  return rows.length > 0 ? [{ type: 'inline_keyboard', payload: { buttons: rows } }] : [];
}

/**
 * Кнопка открытия мини-приложения внутри MAX. В ней не адрес мини-аппа, а
 * username бота: какой URL открыть, MAX берёт из настроек бота в
 * business.max.ru. Пока URL там не привязан, кнопка открывать нечего.
 */
function openAppButton(botUsername: string): Button {
  return { type: 'open_app', text: 'Отправить заявку ЖКХ', web_app: botUsername };
}

/** Без username бота кнопку open_app не собрать — тогда меню без неё. */
function appRow(botUsername: string | null): Button[][] {
  return botUsername ? [[openAppButton(botUsername)]] : [];
}

/**
 * Меню (решение 26.09.2026): мини-приложение — первым, заявка в чате бота —
 * запасной путь и не скрывается никогда: бот не может знать, откроется ли
 * мини-апп у жителя (белые списки, клиент MAX), а диалог в чате работает всегда.
 */
function menuRows(botUsername: string | null): Button[][] {
  return [
    ...appRow(botUsername),
    callback('Сообщить о проблеме в чате', Action.report),
    callback('Мои заявки', Action.tickets),
    callback('Чат дома', Action.houseChat),
  ];
}

export function menuKeyboard(botUsername: string | null): MaxAttachment[] {
  return keyboard(menuRows(botUsername));
}

/** Отмена заявки: tc:ask:<id> → подтверждение → tc:yes:<id> / tc:no:<id>. */
export const cancelAction = (step: 'ask' | 'yes' | 'no', ticketId: number): string => `tc:${step}:${ticketId}`;

/** Подробности заявки: «Отменить заявку» — только у «принятой», дальше меню. */
export function ticketDetailsKeyboard(
  ticket: { id: number; status: string },
  botUsername: string | null,
): MaxAttachment[] {
  return keyboard([
    ...(ticket.status === 'new' ? [callback('Отменить заявку', cancelAction('ask', ticket.id))] : []),
    ...menuRows(botUsername),
  ]);
}

export function confirmCancelKeyboard(ticketId: number): MaxAttachment[] {
  return keyboard([
    callback('Да, отменить', cancelAction('yes', ticketId)),
    callback('Нет, оставить', cancelAction('no', ticketId)),
  ]);
}

/**
 * Ответ «Чат дома»: ссылка на чат (если УК её завела) и сразу кнопка заявки —
 * одним сообщением, а не двумя: в MAX лимит 2 сообщения в секунду на диалог.
 */
export function houseChatKeyboard(chatLink: string | null, botUsername: string | null): MaxAttachment[] {
  return keyboard([
    ...(chatLink ? [[{ type: 'link', text: 'Перейти в чат дома', url: chatLink }]] : []),
    ...appRow(botUsername),
    // Этот экран заменил меню на месте — без кнопки к меню не вернуться.
    callback('« Меню', Action.menu),
  ]);
}

export const cancelAddressKeyboard: MaxAttachment[] = keyboard([callback('Отмена', Action.cancelAddress)]);

// ── опасность ─────────────────────────────────────────────────────────────

export function confirmDangerKeyboard(type: DangerType): MaxAttachment[] {
  return keyboard([
    callback('Да, это авария', confirmDangerAction(type)),
    callback('Нет, всё в порядке', Action.dismissDanger),
  ]);
}

/** После инструкции при запахе газа (тексты Павла). */
export const gasCalledKeyboard: MaxAttachment[] = keyboard([callback('Я позвонил(а)', Action.gasCalled)]);

// ── обычная заявка ────────────────────────────────────────────────────────

/** «Отмена» — на каждом шаге заявки: выйти можно в любой момент. */
const cancelTicketRow: Button[] = callback('Отмена', Action.cancelTicket);

/** «« Назад» — на каждом шаге заявки после первого (решение 26.09.2026). */
const backRow: Button[] = callback('« Назад', Action.back);

/** «Что случилось?». Дому без газа кнопку «Запах газа» не показываем (rules.yaml, fallback_policy). */
export function typeKeyboard(hasGas: boolean): MaxAttachment[] {
  const types = (Object.keys(PROBLEM_TYPES) as ProblemType[]).filter((type) => hasGas || type !== 'gas');
  // На первом шаге только «Отмена»: «Назад» делал бы то же самое — вернул в меню.
  return keyboard([...types.map((type) => callback(PROBLEM_TYPES[type], typeAction(type))), cancelTicketRow]);
}

/** Уточнение после типа — кнопки ведут в опасность, в зону собственника или дальше. */
const CLARIFY_BUTTONS: Record<'leak' | 'electricity' | 'elevator' | 'blockage', [string, string][]> = {
  leak: [
    ['🌊 Сильно течёт, заливает / может залить соседей', 'clar:severe'],
    ['💧 Капает или течёт умеренно', 'clar:moderate'],
  ],
  electricity: [
    ['⚠️ Искрит, дымит, пахнет гарью, оголённые провода', 'clar:sparking'],
    ['Нет света во всей квартире / в подъезде / во всём доме', 'clar:outage'],
    ['Не работает одна розетка или выключатель, у соседей свет есть', 'clar:one_socket'],
  ],
  elevator: [
    ['🆘 Да, человек застрял', 'clar:trapped'],
    ['Нет, лифт просто не работает', 'clar:broken'],
  ],
  // TODO(Павел): подписи — черновик Игоря; в rules.yaml это blockage_sewage и blockage_chute.
  blockage: [
    ['🚽 Канализация: раковина, унитаз, стояк', 'clar:sewage'],
    ['🗑️ Мусоропровод', 'clar:chute'],
  ],
};

export function clarifyKeyboard(type: keyof typeof CLARIFY_BUTTONS): MaxAttachment[] {
  return keyboard([...CLARIFY_BUTTONS[type].map(([text, payload]) => callback(text, payload)), backRow, cancelTicketRow]);
}

/** «Где?» — только места, для которых у типа есть правило. */
export function placeKeyboard(type: keyof typeof PLACES_BY_TYPE): MaxAttachment[] {
  return keyboard([
    ...PLACES_BY_TYPE[type].map((place) => callback(PLACES[place], placeAction(place))),
    backRow,
    cancelTicketRow,
  ]);
}

/** «Откуда именно течёт?» — протечка в квартире; граница по ПП № 491, п. 5. */
export const leakSourceKeyboard: MaxAttachment[] = keyboard([
  callback('Стояк или труба до первого крана', 'src:riser'),
  callback('Сам кран на трубе от стояка (первый вентиль)', 'src:valve'),
  callback('Смеситель, гибкий шланг, унитаз, стиральная машина, трубы после крана', 'src:owner'),
  callback('Не знаю / течёт с потолка', 'src:unknown'),
  backRow,
  cancelTicketRow,
]);

/** Экран зоны собственника: всегда есть «Всё равно передать в УК» — тупик хуже лишней заявки. */
export function ownerZoneKeyboard(zone: OwnerZone): MaxAttachment[] {
  return keyboard([
    callback('✅ Понятно, спасибо', 'own:ok'),
    callback('📨 Всё равно передать в УК', 'own:send'),
    zone === 'leak'
      ? callback('🔁 Кран не перекрывается / течёт сам кран', 'own:alt')
      : callback('⚠️ Теперь искрит или пахнет гарью', 'own:alt'),
    backRow,
  ]);
}

export const descriptionKeyboard: MaxAttachment[] = keyboard([
  callback('Без описания', Action.skipDescription),
  backRow,
  cancelTicketRow,
]);

export const confirmTicketKeyboard: MaxAttachment[] = keyboard([
  callback('Отправить', Action.sendTicket),
  backRow,
  cancelTicketRow,
]);

export const requestContactKeyboard: MaxAttachment[] = keyboard([
  [{ type: 'request_contact', text: 'Поделиться контактом' }],
]);
