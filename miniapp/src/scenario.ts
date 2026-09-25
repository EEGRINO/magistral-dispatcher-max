/**
 * Сценарий «Сообщить о проблеме» — копия сценария бота (согласован 24.09.2026,
 * docs/Решения_проекта.md): что случилось → уточнение (опасно? зона
 * собственника?) → где → откуда течёт → описание → проверка → номер.
 *
 * Вопросы, подписи кнопок и тексты — из bot/src/config.ts и bot/src/keyboards.ts
 * (тексты Павла). Правишь здесь — поправь и в боте: житель видит оба.
 */
import type { DangerType, House, Place, ProblemType } from './types/domain';

export type ClarifyType = 'leak' | 'electricity' | 'elevator' | 'blockage';

export const isClarifyType = (type: ProblemType): type is ClarifyType =>
  type === 'leak' || type === 'electricity' || type === 'elevator' || type === 'blockage';

/** Что делает ответ на уточнение. detail — tickets.detail_code, по нему api выбирает правило. */
export type ClarifyOutcome =
  | { kind: 'danger'; danger: DangerType }
  | { kind: 'place'; detail: string }
  | { kind: 'owner'; detail: string; place: Place }
  | { kind: 'fixed_place'; detail: string; place: Place };

export const CLARIFY: Record<ClarifyType, { question: string; options: { label: string; outcome: ClarifyOutcome }[] }> = {
  leak: {
    question: 'Насколько всё серьёзно?',
    options: [
      { label: '🌊 Сильно течёт, заливает / может залить соседей', outcome: { kind: 'danger', danger: 'flooding_threat' } },
      { label: '💧 Капает или течёт умеренно', outcome: { kind: 'place', detail: 'moderate' } },
    ],
  },
  electricity: {
    question: 'Что именно происходит?',
    options: [
      { label: '⚠️ Искрит, дымит, пахнет гарью, оголённые провода', outcome: { kind: 'danger', danger: 'exposed_wiring' } },
      { label: 'Нет света во всей квартире / в подъезде / во всём доме', outcome: { kind: 'place', detail: 'outage' } },
      {
        label: 'Не работает одна розетка или выключатель, у соседей свет есть',
        outcome: { kind: 'owner', detail: 'one_socket', place: 'in_apartment' },
      },
    ],
  },
  elevator: {
    question: 'Внутри кабины кто-то есть?',
    options: [
      { label: '🆘 Да, человек застрял', outcome: { kind: 'danger', danger: 'elevator_entrapment' } },
      { label: 'Нет, лифт просто не работает', outcome: { kind: 'place', detail: 'broken' } },
    ],
  },
  blockage: {
    question: 'Что засорилось?',
    options: [
      { label: '🚽 Канализация: раковина, унитаз, стояк', outcome: { kind: 'place', detail: 'sewage' } },
      // Мусоропровод — всегда в подъезде, место не спрашиваем.
      { label: '🗑️ Мусоропровод', outcome: { kind: 'fixed_place', detail: 'chute', place: 'entrance' } },
    ],
  },
};

/** «Откуда именно течёт?» — протечка в квартире; граница по ПП № 491, п. 5. */
export const LEAK_SOURCES: { label: string; detail: string; owner: boolean }[] = [
  { label: 'Стояк или труба до первого крана', detail: 'riser', owner: false },
  { label: 'Сам кран на трубе от стояка (первый вентиль)', detail: 'valve', owner: false },
  { label: 'Смеситель, гибкий шланг, унитаз, стиральная машина, трубы после крана', detail: 'owner', owner: true },
  // «Не знаю» — в УК: отказать по догадке хуже, чем принять лишнюю заявку.
  { label: 'Не знаю / течёт с потолка', detail: 'unknown', owner: false },
];

export type OwnerZone = 'leak' | 'electricity';

const ukName = (house: House | null): string => house?.uk_name ?? 'управляющую компанию';

export function ownerZoneText(zone: OwnerZone, house: House | null): string {
  return zone === 'leak'
    ? 'Судя по вашему ответу, течёт оборудование после первого крана на трубе от стояка — ' +
        'смеситель, гибкая подводка или сантехника.\n\n' +
        'По правилам содержания общего имущества (Постановление Правительства РФ № 491, п. 5) ' +
        'это имущество собственника квартиры, поэтому управляющая компания его не ремонтирует ' +
        'по обычной заявке.\n\n' +
        'Что сделать:\n' +
        '1. Перекройте кран на трубе от стояка — вода перестанет поступать.\n' +
        `2. Вызовите сантехника: частного мастера или платную услугу в ${ukName(house)}.\n` +
        '3. Если вода попала к соседям снизу — предупредите их.'
    : 'Если у соседей свет есть, а у вас не работает только часть розеток или выключатель, ' +
        'скорее всего, дело во внутренней проводке квартиры.\n\n' +
        'По правилам содержания общего имущества (Постановление Правительства РФ № 491, п. 5) ' +
        'проводка и розетки после автомата в квартирном щитке — имущество собственника, ' +
        'управляющая компания их не ремонтирует по обычной заявке.\n\n' +
        'Что проверить:\n' +
        '1. Посмотрите в щитке, не выбило ли автомат. Если выбило — попробуйте включить один раз.\n' +
        '2. Если выбивает снова — не включайте повторно, отключите приборы из этой линии ' +
        'и вызовите электрика.';
}

/** Третья кнопка экрана собственника: течёт сам кран — общее имущество; искрит — авария. */
export const OWNER_ALT_LABEL: Record<OwnerZone, string> = {
  leak: '🔁 Кран не перекрывается / течёт сам кран',
  electricity: '⚠️ Теперь искрит или пахнет гарью',
};

/** Телефон, который можно набрать: подпись и номер для ссылки tel:. */
export interface Phone {
  label: string;
  number: string;
}

/** Телефон АДС дома; нет его — 112 (тексты Павла, п. 4). */
function adsPhone(house: House | null): Phone {
  return house?.emergency_phone
    ? { label: 'Аварийная служба дома', number: house.emergency_phone }
    : { label: 'Телефон аварийной службы дома не указан', number: '112' };
}

/**
 * Экстренные инструкции — тексты Павла, как у бота. Телефоны отдельно от текста:
 * в мини-аппе это кнопки звонка, а не строки, которые надо переписывать.
 */
export function dangerInstructions(type: DangerType, house: House | null): { text: string; phones: Phone[] } {
  switch (type) {
    case 'gas_smell':
      return {
        text:
          '⚠️ Запах газа — это опасно. Действуйте сейчас:\n\n' +
          '1. Не включайте и не выключайте свет и электроприборы, не пользуйтесь открытым огнём.\n' +
          '2. Перекройте газ на плите или трубе, если это можно сделать быстро.\n' +
          '3. Откройте окна и выйдите из помещения, предупредите соседей.\n' +
          '4. Уже на улице позвоните в аварийную газовую службу.',
        phones: [
          { label: 'Аварийная газовая служба', number: '104' },
          { label: 'Если 104 не отвечает', number: '112' },
        ],
      };
    case 'exposed_wiring':
      return {
        text:
          '⚠️ Искрящая проводка может вызвать пожар.\n\n' +
          '1. Не трогайте провода и щиток, не лейте воду.\n' +
          '2. Если щиток в квартире и до него можно безопасно дотянуться — отключите автомат.\n' +
          '3. Отойдите сами и не подпускайте детей.',
        phones: [adsPhone(house), { label: 'Если появился дым или огонь', number: '101' }],
      };
    case 'flooding_threat':
      return {
        text:
          '⚠️ Похоже на серьёзную протечку. Что сделать прямо сейчас:\n\n' +
          '1. Перекройте воду краном на трубе от стояка, если можете до него добраться.\n' +
          '2. Обесточьте мокрые участки — отключите автомат в щитке, не трогайте мокрые розетки.\n' +
          '3. Предупредите соседей снизу.',
        phones: [adsPhone(house)],
      };
    case 'elevator_entrapment':
      return {
        text:
          '🆘 Человек застрял в лифте.\n\n' +
          'Если вы в кабине:\n' +
          '1. Нажмите кнопку вызова диспетчера в кабине.\n' +
          '2. Не пытайтесь сами открыть двери или выбраться — это опаснее, чем ждать.',
        phones: [adsPhone(house), { label: 'Если не отвечают или человеку плохо', number: '112' }],
      };
  }
}

/** Всё, что собрал житель к моменту отправки. */
export interface TicketDraft {
  problem_type: string;
  place: Place | null;
  detail_code: string | null;
  description: string | null;
}
