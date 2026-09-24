/**
 * Клавиатуры бота. Клавиатура — вложение inline_keyboard, форма кнопок —
 * docs/max-notes.md, раздел «Inline-клавиатура».
 */
import { config } from './config.js';
import type { MaxAttachment } from './max-api.js';

/** payload кнопок callback — по ним бот понимает, что нажато. */
export const Action = {
  houseChat: 'menu:house_chat',
  cancelAddress: 'address:cancel',
} as const;

type Button = Record<string, unknown>;

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
 * ВРЕМЕННО: мини-апп обычной ссылкой, пока URL не привязан к боту и open_app
 * открывать нечего. Страница откроется без данных входа MAX — это ожидаемо.
 */
function testAppRow(): Button[][] {
  return config.miniappTestUrl
    ? [[{ type: 'link', text: 'Мини-апп (тест)', url: config.miniappTestUrl }]]
    : [];
}

export function menuKeyboard(botUsername: string | null): MaxAttachment[] {
  return keyboard([
    [{ type: 'callback', text: 'Чат дома', payload: Action.houseChat }],
    ...appRow(botUsername),
    ...testAppRow(),
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
  ]);
}

export const cancelAddressKeyboard: MaxAttachment[] = keyboard([
  [{ type: 'callback', text: 'Отмена', payload: Action.cancelAddress }],
]);

export const requestContactKeyboard: MaxAttachment[] = keyboard([
  [{ type: 'request_contact', text: 'Поделиться контактом' }],
]);
