/**
 * Проверка initData мини-приложения (api/src/init-data.ts).
 *
 * Подпись здесь собирается по тому же алгоритму из docs/max-notes.md —
 * это проверка, что реализация следует алгоритму и отклоняет подделки.
 * Что MAX подписывает именно так, подтверждает только живой запуск мини-аппа.
 */
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyInitData } from '../dist/init-data.js';

const TOKEN = 'test-token-not-a-real-secret';
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const DAY = 24 * 60 * 60;

/** initData как у MAX: пары key=value (значения URL-кодированы) и hash подписи. */
function sign(fields, token = TOKEN) {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const signingKey = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', signingKey).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const fields = (overrides = {}) => ({
  auth_date: String(NOW / 1000 - 60),
  query_id: 'q1',
  user: JSON.stringify({ id: 163719150, first_name: 'Иван', username: 'ivan' }),
  chat: JSON.stringify({ id: 516093921, type: 'DIALOG' }),
  ...overrides,
});

test('подлинный initData — user.id', () => {
  assert.deepEqual(verifyInitData(sign(fields()), TOKEN, DAY, NOW), { ok: true, userId: 163719150 });
});

test('чужой user.id при той же подписи — отказ', () => {
  const forged = sign(fields()).replace(encodeURIComponent('163719150'), encodeURIComponent('999'));
  assert.equal(verifyInitData(forged, TOKEN, DAY, NOW).reason, 'bad_signature');
});

test('подписано другим токеном — отказ', () => {
  assert.equal(verifyInitData(sign(fields(), 'other-token'), TOKEN, DAY, NOW).reason, 'bad_signature');
});

test('старше суток — отказ; «из будущего» больше 5 минут — отказ', () => {
  assert.equal(verifyInitData(sign(fields({ auth_date: String(NOW / 1000 - DAY - 1) })), TOKEN, DAY, NOW).reason, 'expired');
  assert.equal(verifyInitData(sign(fields({ auth_date: String(NOW / 1000 + 600) })), TOKEN, DAY, NOW).reason, 'expired');
});

test('пусто, без hash, ключ дважды — отказ', () => {
  assert.equal(verifyInitData(undefined, TOKEN, DAY, NOW).reason, 'missing');
  assert.equal(verifyInitData('auth_date=1&user=%7B%7D', TOKEN, DAY, NOW).reason, 'malformed');
  assert.equal(verifyInitData(`${sign(fields())}&query_id=q2`, TOKEN, DAY, NOW).reason, 'malformed');
});

test('без user — отказ', () => {
  const { user, ...rest } = fields();
  assert.equal(verifyInitData(sign(rest), TOKEN, DAY, NOW).reason, 'no_user');
});
