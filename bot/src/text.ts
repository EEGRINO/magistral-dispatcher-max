/**
 * Длина текста в символах, а не в половинках UTF-16: эмодзи — один символ, и
 * обрезка не разрезает его пополам (иначе в заявку ушёл бы битый символ).
 */

/** Лимит описания заявки в api и БД — 4000 символов (char_length в Postgres). */
export const DESCRIPTION_LIMIT = 4000;

/**
 * Сколько описания показывать в сообщениях бота. Целиком 4000 символов вместе с
 * остальными строками не влезли бы в лимит сообщения MAX (тоже 4000).
 */
export const DESCRIPTION_PREVIEW = 1000;

/** Первые max символов; cut — пришлось ли обрезать. */
export function cutText(text: string, max: number): { text: string; cut: boolean } {
  const chars = Array.from(text);
  return chars.length <= max ? { text, cut: false } : { text: chars.slice(0, max).join(''), cut: true };
}

/** Описание для показа в сообщении: длинное — началом, с пометкой, что сохранено целиком. */
export function previewDescription(text: string): string {
  const { text: start, cut } = cutText(text, DESCRIPTION_PREVIEW);
  return cut ? `${start}…\n(показано начало — в заявке описание сохранено полностью)` : text;
}
