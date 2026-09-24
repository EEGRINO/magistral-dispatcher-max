/**
 * Тесты маршрутизации Павла: docs/routing-test-cases.json против config/rules.yaml.
 * Запуск: cd api && npm test (собирает dist и гоняет node --test).
 *
 * В кейсах уточнение жителя описано свободным текстом (context), а resolve()
 * принимает код ответа — кнопку бота. Соответствие «кейс → код» ниже задано
 * вручную по тексту context; когда Павел добавит поле detail в сами кейсы,
 * эта таблица станет не нужна.
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, resolve } from '../dist/routing.js';

const root = new URL('../../', import.meta.url);
const rules = parseRules(readFileSync(new URL('config/rules.yaml', root), 'utf8'));
const { cases } = JSON.parse(readFileSync(new URL('docs/routing-test-cases.json', root), 'utf8'));

/** context кейса → ответ жителя на уточнение в боте. */
const DETAIL = {
  'TC-01': 'riser', // «протечка из стояка»
  'TC-03': 'owner', // «течёт шланг стиральной машины»
  'TC-04': 'owner', // «капает смеситель на кухне»
  'TC-04b': 'valve', // «течёт сам вентиль»
  'TC-05': 'severe', // «сильный напор … угроза затопления»
  'TC-06': 'sewage', // «засор канализации в квартире»
  'TC-07': 'chute', // «засор мусоропровода»
  'TC-08': 'sewage', // «засор ливневой канализации во дворе»
  'TC-11': 'outage', // «нет света во всём доме»
  'TC-12': 'one_socket', // «не работает одна розетка, у соседей свет есть»
  'TC-13': 'sparking', // «искрит проводка»
  'TC-14': 'broken', // «лифт не едет, никого внутри нет»
  'TC-15': 'trapped', // «человек застрял внутри кабины»
};

/** Дома из houses.json Павла: у house-05, 06, 08 газа нет; house-99 не существует. */
const NO_GAS = new Set(['house-05', 'house-06', 'house-08']);
const house = (id) => (/^house-0[1-8]$/.test(id) ? { hasGas: !NO_GAS.has(id) } : undefined);

test('в routing-test-cases.json 29 кейсов', () => {
  assert.equal(cases.length, 29);
});

for (const c of cases) {
  test(`${c.id}: ${c.context}`, () => {
    const result = resolve(rules, { problemType: c.type, place: c.place, detail: DETAIL[c.id] ?? null }, house(c.house_id));
    const want = c.expected;

    // Кейсы, где ожидается ошибка, описаны поведением, а не rule_id.
    if (want.rule_id === undefined) {
      assert.equal(result.ok, false, `ждали ошибку проверки: ${want.behavior}`);
      return;
    }

    assert.ok(result.ok, `ждали правило ${want.rule_id}, получили ошибку ${result.ok ? '' : result.reason}`);
    const expectFallback = want.rule_id.includes('(fallback)');
    assert.equal(result.rule.id, want.rule_id.replace(' (fallback)', ''));
    assert.equal(result.fallback, expectFallback, 'признак fallback');
    assert.equal(result.rule.responsible, want.responsible);
    if (want.danger !== undefined) assert.equal(result.rule.danger, want.danger, 'danger');
    if (want.owner_zone !== undefined) assert.equal(result.rule.ownerZone, want.owner_zone, 'owner_zone');
    if (want.routing !== undefined) assert.equal(result.rule.manual, want.routing === 'manual', 'routing');
  });
}

// Поведение бота, которого в кейсах Павла нет.
test('аварийная заявка по id правила: запах газа принимаем и в доме без газа', () => {
  const result = resolve(rules, { problemType: 'gas_smell', place: null, detail: null }, { hasGas: false });
  assert.ok(result.ok && result.rule.id === 'gas_smell');
});

test('«Всё равно передать в УК» — ручная классификация, не fallback', () => {
  const result = resolve(rules, { problemType: 'leak', place: 'in_apartment', detail: 'owner_override' }, { hasGas: true });
  assert.ok(result.ok && result.rule.id === 'other_unsure' && !result.fallback);
});

test('дом не указан — правило всё равно выбирается', () => {
  const result = resolve(rules, { problemType: 'heating', place: 'whole_house', detail: null }, null);
  assert.ok(result.ok && result.rule.id === 'heating_outage');
});

test('«двор» от бота (street) находит правила с yard', () => {
  const result = resolve(rules, { problemType: 'common_area', place: 'street', detail: null }, { hasGas: true });
  assert.ok(result.ok && result.rule.id === 'common_area_issue' && !result.fallback);
});

test('битый rules.yaml — понятная ошибка, а не падение где-то дальше', () => {
  assert.throws(() => parseRules('rules:\n  - id: x\n    type: leak\n'), /правило x: place/);
  assert.throws(() => parseRules('danger_types: []\n'), /нет списка rules/);
});
