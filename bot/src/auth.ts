/**
 * Вход жителя по контакту MAX (кнопка request_contact).
 *
 * Как это работает (подробно — docs/max-notes.md, «Контакт жителя»):
 * житель нажимает кнопку, MAX от его имени присылает сообщение с vCard и
 * подписью hash = HMAC-SHA256(токен бота, vcf_info). Подпись может посчитать
 * только тот, кто знает токен, — MAX и мы. Совпала — номер действительно
 * принадлежит этому аккаунту, ввести чужой номер нельзя.
 *
 * Проверено на живом боте 24.09.2026: кнопка работает в клиенте на компьютере,
 * hash — 64 символа, то есть hex.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MaxAttachment, MaxMessage } from './max-api.js';

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

/**
 * Любой вид номера → +7XXXXXXXXXX; null, если это не 10 цифр после +7/8.
 * Так же нормализует номера seed (db/seed.js) — иначе они не совпадут.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`;
  return null;
}

export type ContactCheck =
  | { ok: true; phone: string }
  | { ok: false; reason: 'foreign_contact' | 'bad_signature' | 'unsupported_phone' };

function signatureMatches(vcf: string, hash: string, token: string): boolean {
  const expected = createHmac('sha256', token).update(vcf).digest('hex');
  // Сравнение за постоянное время: обычный === отвечает быстрее на первом же
  // несовпавшем символе, и по времени ответа подпись можно подбирать.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(hash.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Две проверки, обе обязательны:
 *  - подпись — номер не подделан;
 *  - max_info.user_id == отправитель — это контакт самого жителя, а не чужая
 *    карточка, которую он переслал (у пересланной подпись тоже может быть верной).
 */
export function verifyContact(
  contact: ContactPayload,
  senderUserId: number | undefined,
  token: string,
): ContactCheck {
  if (senderUserId === undefined || contact.max_info?.user_id !== senderUserId) {
    return { ok: false, reason: 'foreign_contact' };
  }

  const vcf = typeof contact.vcf_info === 'string' ? contact.vcf_info : '';
  const hash = typeof contact.hash === 'string' ? contact.hash : '';

  if (!vcf || !hash || !signatureMatches(vcf, hash, token)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const tel = /TEL[^:]*:([^\r\n]+)/.exec(vcf)?.[1] ?? '';
  const phone = normalizePhone(tel);

  return phone ? { ok: true, phone } : { ok: false, reason: 'unsupported_phone' };
}
