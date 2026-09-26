/**
 * Проверка initData мини-приложения MAX — по docs/max-notes.md, «Проверка
 * initData на сервере» (dev.max.ru/docs/webapps/validation, 24.09.2026):
 *
 *   1. разобрать строку на пары key=value, каждый ключ — один раз;
 *   2. вынуть hash;
 *   3. URL-декодировать значения, отсортировать пары по ключу;
 *   4. склеить «key=value» через \n;
 *   5. secret_key = HMAC-SHA256, ключ — строка "WebAppData", данные — токен бота;
 *   6. signature = hex(HMAC-SHA256, ключ — secret_key, данные — строка из п. 4);
 *   7. signature == hash — данные подлинные.
 *
 * Подпись можно посчитать только токеном бота, поэтому подделать user.id
 * (а с ним — чужие заявки) без токена нельзя. Сам initData и hash в лог не
 * пишем: это пропуск жителя на время жизни initData.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type InitDataCheck =
  | { ok: true; userId: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'bad_signature' | 'expired' | 'no_user' };

export function verifyInitData(
  raw: string | undefined,
  botToken: string,
  maxAgeSec: number,
  nowMs: number = Date.now(),
): InitDataCheck {
  if (!raw) return { ok: false, reason: 'missing' };

  // URLSearchParams и разбивает на пары, и URL-декодирует значения (п. 1, 3).
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return { ok: false, reason: 'malformed' };

  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'malformed' };

  const launchParams = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const signingKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const signature = createHmac('sha256', signingKey).update(launchParams).digest();
  if (!timingSafeEqual(signature, Buffer.from(hash, 'hex'))) return { ok: false, reason: 'bad_signature' };

  // Свежесть: дока срок не задаёт — берём maxAgeSec. Подпись без срока жила бы
  // вечно: перехваченный initData открывал бы заявки жителя навсегда.
  const authDate = Number(params.get('auth_date'));
  const ageSec = nowMs / 1000 - authDate;
  if (!Number.isFinite(authDate) || ageSec > maxAgeSec || ageSec < -300) return { ok: false, reason: 'expired' };

  let userId: unknown;
  try {
    userId = (JSON.parse(params.get('user') ?? 'null') as { id?: unknown } | null)?.id;
  } catch {
    return { ok: false, reason: 'no_user' };
  }
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId < 1) return { ok: false, reason: 'no_user' };

  return { ok: true, userId };
}
