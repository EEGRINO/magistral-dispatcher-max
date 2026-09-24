/**
 * ВРЕМЕННО (24.09.2026): изолированная проверка кнопки request_contact в веб- и
 * мобильном клиенте MAX — пункт П4. Ничего не пишет в БД и не проверяет подпись:
 * только показывает, что пришло. После проверки либо становится входом по
 * контакту (шаг 2), либо удаляется.
 */
import type { MaxAttachment, MaxMessage } from './max-api.js';

export const TEST_CONTACT_COMMAND = '/testcontact';

export const requestContactKeyboard: MaxAttachment[] = [
  {
    type: 'inline_keyboard',
    payload: { buttons: [[{ type: 'request_contact', text: 'Поделиться контактом' }]] },
  },
];

interface ContactPayload {
  vcf_info?: unknown;
  hash?: unknown;
  max_info?: { user_id?: unknown } | null;
}

/** Вложение-контакт из сообщения, если оно там есть. */
export function findContact(message: MaxMessage | undefined): ContactPayload | null {
  const attachment = message?.body?.attachments?.find((item) => item.type === 'contact');
  if (!attachment || typeof attachment.payload !== 'object' || attachment.payload === null) {
    return null;
  }
  return attachment.payload as ContactPayload;
}

/** Текст ответа с полученными полями — для глаз, без проверок. */
export function describeContact(contact: ContactPayload, senderId: number | undefined): string {
  const vcf = typeof contact.vcf_info === 'string' ? contact.vcf_info : '';
  const tel = /TEL[^:]*:([^\r\n]+)/.exec(vcf)?.[1]?.trim() ?? 'не найден в vcf_info';
  const hash = typeof contact.hash === 'string' ? contact.hash : '';
  const contactUserId = contact.max_info?.user_id;

  return [
    'Тест кнопки контакта — получено:',
    `номер (TEL из vCard): ${tel}`,
    `hash: ${hash || 'нет'} (длина ${hash.length})`,
    `id отправителя: ${senderId ?? 'нет'}`,
    `id в контакте (max_info.user_id): ${String(contactUserId ?? 'нет')} — ` +
      (contactUserId === senderId ? 'совпадает' : 'НЕ совпадает'),
  ].join('\n');
}
