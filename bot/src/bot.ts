/**
 * Логика бота: цикл long polling и диалог с жителем.
 *
 * Сценарий согласован 24.09.2026 (docs/Решения_проекта.md):
 *   - не вошёл → кнопка «Поделиться контактом» → проверка подписи MAX →
 *     привязка к жителю, заранее заведённому УК;
 *   - вошёл → меню: «Сообщить о проблеме», «Чат дома», «Отправить заявку ЖКХ»
 *     (мини-приложение);
 *   - «Чат дома»: дом по данным УК → по QR (?start=invite_code) → по адресу,
 *     введённому вручную; ответ — адрес и ссылка на чат дома.
 *
 * «Сообщить о проблеме» — модель Павла (config/rules.yaml, решение 24.09.2026):
 * что случилось → уточнение (протечка — сильно ли заливает, электричество —
 * искрит ли, лифт — есть ли кто внутри; газ — сразу) → где → откуда течёт →
 * описание → подтверждение → номер. Опасность выясняется ДО обычной заявки:
 * сначала инструкция с телефоном АДС дома, потом аварийная заявка. Зона
 * собственника — объяснение и «Всё равно передать в УК». Страховка по словам —
 * в любом тексте: опасность (инструкция + «Да, это авария») и огонь/дым (101/112).
 *
 * Состояний в БД нет. Вошёл ли человек — видно по БД; «ждём адрес», «код
 * дома из QR до входа» и черновики — в памяти (dialog-state.ts), перезапуск
 * их стирает.
 *
 * Модуль импортируется динамически из index.ts, поэтому падение валидации
 * конфига долетает до обработчика как обычная ошибка, а не как стектрейс.
 */
import { ApiClient, ApiClientError, type House, type Resident } from './api-client.js';
import { findContact, verifyContact } from './auth.js';
import { config, messages } from './config.js';
import { awaitingAddress, pendingDangerText, pendingInvite, recentEmergency, reportDraft } from './dialog-state.js';
import { detectDanger, detectFire, isDangerType, type DangerType } from './emergency.js';
import {
  Action,
  cancelAddressKeyboard,
  clarifyKeyboard,
  confirmDangerKeyboard,
  confirmTicketKeyboard,
  descriptionKeyboard,
  gasCalledKeyboard,
  houseChatKeyboard,
  leakSourceKeyboard,
  menuKeyboard,
  ownerZoneKeyboard,
  placeKeyboard,
  requestContactKeyboard,
  typeKeyboard,
} from './keyboards.js';
import { log } from './logger.js';
import { MaxApi, MaxApiError, type MaxAttachment, type MaxUpdate, type SendTarget } from './max-api.js';
import {
  PLACES_BY_TYPE,
  isPlace,
  isProblemType,
  type DraftHouse,
  type OwnerZone,
  type ReportDraft,
} from './report.js';

const api = new MaxApi();
const apiClient = new ApiClient();

/** Один контроллер на всё приложение: abort прерывает висящий long poll при выключении. */
const shutdown = new AbortController();
let running = true;

/** Пауза, прерываемая шатдауном, — чтобы backoff не задерживал остановку контейнера. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    shutdown.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Куда отправлять ответ. chat_id приоритетнее user_id: он работает и в личке,
 * и в группе. У нажатия кнопки адресат — чат сообщения с клавиатурой; если то
 * сообщение уже удалено, остаётся только нажавший пользователь.
 */
function resolveTarget(update: MaxUpdate): SendTarget | null {
  const chatId = update.message?.recipient?.chat_id ?? update.chat_id;
  if (typeof chatId === 'number') return { chatId };

  const userId =
    update.message?.sender?.user_id ??
    update.user?.user_id ??
    update.callback?.user?.user_id ??
    update.user_id;
  if (typeof userId === 'number') return { userId };

  return null;
}

// ── username бота для кнопки open_app ──────────────────────────────────────

let botUsername: string | null = null;
let usernameCheckedAt = 0;

/**
 * Лениво и не чаще раза в минуту: если MAX не ответил на старте, кнопка
 * «Отправить заявку ЖКХ» появится, как только GET /me пройдёт, — без рестарта.
 */
async function getBotUsername(): Promise<string | null> {
  if (botUsername || Date.now() - usernameCheckedAt < 60_000) return botUsername;
  usernameCheckedAt = Date.now();

  try {
    const me = await api.getMe(shutdown.signal);
    botUsername = me.username ?? null;
    if (botUsername) {
      log.info('username бота получен', { username: botUsername });
    } else {
      log.warn('у бота нет username — кнопка «Отправить заявку ЖКХ» не показывается');
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    log.warn('GET /me не удался — меню пока без кнопки заявки', { error: errorText(error) });
  }

  return botUsername;
}

// ── отправка ──────────────────────────────────────────────────────────────

function send(target: SendTarget, text: string, attachments?: MaxAttachment[]): Promise<void> {
  return api.sendMessage(target, text, shutdown.signal, attachments);
}

function askContact(target: SendTarget): Promise<void> {
  return send(target, messages.askContact, requestContactKeyboard);
}

async function sendMenu(target: SendTarget, lead?: string): Promise<void> {
  const text = lead ? `${lead}\n${messages.menu}` : messages.menu;
  await send(target, text, menuKeyboard(await getBotUsername()));
}

/** Адрес дома + кнопки «Перейти в чат дома» и «Отправить заявку ЖКХ» — одним сообщением. */
async function sendHouseChat(target: SendTarget, house: House, lead?: string): Promise<void> {
  const body = house.chat_link ? messages.houseChat(house.address) : messages.houseChatMissing(house.address);
  const text = lead ? `${lead}\n${body}` : body;
  await send(target, text, houseChatKeyboard(house.chat_link, await getBotUsername()));
}

/** api не ответил: говорим об этом, а не молчим — «бот не отвечает» для жителя хуже. */
async function serviceUnavailable(
  target: SendTarget,
  where: string,
  meta: Record<string, unknown>,
  error: unknown,
): Promise<void> {
  if (isAbort(error)) throw error;
  log.error(`api недоступен ${where}`, { ...meta, error: errorText(error) });
  await send(target, messages.serviceUnavailable);
}

/** Житель по user_id; undefined — api недоступен (ответ жителю уже отправлен). */
async function findResident(
  target: SendTarget,
  userId: number,
  where: string,
): Promise<Resident | null | undefined> {
  try {
    return await apiClient.findByMaxUser(userId, shutdown.signal);
  } catch (error) {
    await serviceUnavailable(target, where, { user_id: userId }, error);
    return undefined;
  }
}

/** Меню вошедшему, кнопка контакта — не вошедшему. */
async function showMenu(target: SendTarget, userId: number | undefined, lead?: string): Promise<void> {
  if (userId === undefined) {
    await askContact(target);
    return;
  }
  const resident = await findResident(target, userId, 'при показе меню');
  if (resident === undefined) return;
  await (resident ? sendMenu(target, lead) : askContact(target));
}

// ── опасность ─────────────────────────────────────────────────────────────

/**
 * Отдельный клиент с коротким таймаутом — только чтобы узнать телефон АДС дома
 * для экстренной инструкции. Инструкция важнее телефона: api не ответил за
 * 1,5 секунды — в тексте будет 112, но жителю не придётся ждать.
 */
const quickApiClient = new ApiClient(config.apiBaseUrl, 1500);

const toDraftHouse = (house: House | null): DraftHouse | null =>
  house
    ? { address: house.address, emergency_phone: house.emergency_phone, has_gas: house.has_gas, uk_name: house.uk_name }
    : null;

/** Дом жителя для экстренного текста; null — не вошёл, дома нет или api не успел. */
async function houseForEmergency(userId: number | undefined): Promise<DraftHouse | null> {
  if (userId === undefined) return null;
  const draft = reportDraft.get(userId);
  if (draft) return draft.house;

  try {
    const resident = await quickApiClient.findByMaxUser(userId, shutdown.signal);
    if (!resident) return null;
    return toDraftHouse(await quickApiClient.getHouse(resident.id, shutdown.signal));
  } catch (error) {
    if (isAbort(error)) throw error;
    log.warn('дом для экстренной инструкции не получен — в тексте 112', { user_id: userId, error: errorText(error) });
    return null;
  }
}

/**
 * Аварийная заявка. Инструкция жителю к этому моменту УЖЕ отправлена: заявка
 * может не создаться (api лежит, житель не вошёл), а что делать при утечке
 * газа, человек должен узнать в любом случае. При газе заявка тоже создаётся
 * (решение 24.09.2026) — и кнопка «Я позвонил(а)».
 */
async function registerEmergency(
  target: SendTarget,
  userId: number | undefined,
  type: DangerType,
  description: string | null,
): Promise<void> {
  if (userId === undefined) {
    await send(target, messages.emergencyNeedsLogin, requestContactKeyboard);
    return;
  }

  const earlier = recentEmergency.get(userId)?.[type];
  if (earlier !== undefined) {
    await send(target, messages.emergencyTicketExists(earlier));
    return;
  }

  try {
    const resident = await apiClient.findByMaxUser(userId, shutdown.signal);
    if (!resident) {
      await send(target, messages.emergencyNeedsLogin, requestContactKeyboard);
      return;
    }

    const ticket = await apiClient.createTicket(resident.id, { problemType: type, description }, shutdown.signal);
    recentEmergency.set(userId, { ...recentEmergency.get(userId), [type]: ticket.id });
    // warn, а не info: аварийную заявку в логе должно быть видно сразу.
    log.warn('аварийная заявка', { resident_id: resident.id, ticket_id: ticket.id, type });
    await send(
      target,
      messages.emergencyTicketCreated(ticket.id),
      type === 'gas_smell' ? gasCalledKeyboard : undefined,
    );
  } catch (error) {
    if (isAbort(error)) throw error;
    log.error('аварийная заявка не создана', { user_id: userId, type, error: errorText(error) });
    await send(target, messages.emergencyTicketFailed);
  }
}

/** Опасность выбрана кнопкой: инструкция и сразу заявка — житель выбрал её сам. */
async function handleDangerButton(
  target: SendTarget,
  userId: number | undefined,
  type: DangerType,
  house: DraftHouse | null,
): Promise<void> {
  log.info('опасность по кнопке', { user_id: userId, type });
  if (userId !== undefined) {
    pendingDangerText.delete(userId);
    // Авария вместо обычной заявки: черновик больше не нужен.
    reportDraft.delete(userId);
  }
  await send(target, messages.dangerInstructions(type, house, 'button'));
  await registerEmergency(target, userId, type, null);
}

/**
 * Опасность заподозрена по словам. Инструкция — сразу, без вопросов; заявку —
 * только по кнопке «Да, это авария»: «газ отключили» тоже совпадёт, и ложная
 * аварийная заявка диспетчеру не нужна. Сам текст в лог не пишем — в нём бывает адрес.
 */
async function handleDangerText(
  target: SendTarget,
  userId: number | undefined,
  text: string,
  type: DangerType,
): Promise<void> {
  log.info('опасность по словам', { user_id: userId, type });
  const house = await houseForEmergency(userId);
  if (userId !== undefined) {
    awaitingAddress.delete(userId);
    pendingDangerText.set(userId, text);
  }
  await send(target, messages.dangerInstructions(type, house, 'confirm'), confirmDangerKeyboard(type));
}

/**
 * Огонь или дым — общее правило: сразу 101/112, в любом состоянии, без api.
 * Сценарий прерывается: сначала безопасность, заявка — потом.
 */
async function handleFire(target: SendTarget, userId: number | undefined): Promise<void> {
  log.warn('огонь или дым по словам', { user_id: userId });
  if (userId !== undefined) {
    awaitingAddress.delete(userId);
    reportDraft.delete(userId);
    pendingDangerText.delete(userId);
  }
  await send(target, messages.fire);
}

// ── обычная заявка ────────────────────────────────────────────────────────

/** Ответы уточняющего вопроса — по типу. Кнопка от другого типа не принимается. */
const CLARIFY_ANSWERS = {
  leak: ['severe', 'moderate'],
  electricity: ['sparking', 'outage', 'one_socket'],
  elevator: ['trapped', 'broken'],
} as const;
type ClarifyType = keyof typeof CLARIFY_ANSWERS;
const isClarifyType = (type: string | undefined): type is ClarifyType => type !== undefined && type in CLARIFY_ANSWERS;

/** Вопрос текущего шага черновика — после перехода и когда житель пишет вместо кнопки. */
async function askStep(target: SendTarget, draft: ReportDraft, lead?: string): Promise<void> {
  const withLead = (text: string): string => (lead ? `${lead}\n${text}` : text);

  switch (draft.step) {
    case 'type':
      await send(target, withLead(messages.askType), typeKeyboard(draft.house?.has_gas ?? true));
      return;
    case 'clarify':
      if (isClarifyType(draft.type)) {
        await send(target, withLead(messages.askClarify(draft.type)), clarifyKeyboard(draft.type));
        return;
      }
      break;
    case 'place':
      if (draft.type) {
        await send(target, withLead(messages.askPlace), placeKeyboard(draft.type));
        return;
      }
      break;
    case 'leak_source':
      await send(target, withLead(messages.askLeakSource), leakSourceKeyboard);
      return;
    case 'owner':
      if (draft.ownerZone) {
        await send(target, withLead(messages.ownerZone(draft.ownerZone, draft.house)), ownerZoneKeyboard(draft.ownerZone));
        return;
      }
      break;
    case 'description':
      await send(target, withLead(messages.askDescription), descriptionKeyboard);
      return;
    case 'confirm':
      if (draft.type) {
        const summary = messages.confirmTicket({
          type: draft.type,
          place: draft.place,
          address: draft.house?.address ?? null,
          description: draft.description ?? null,
        });
        await send(target, withLead(summary), confirmTicketKeyboard);
        return;
      }
      break;
  }

  // Шаг без нужных для него ответов — черновик испорчен; начинаем с типа.
  draft.step = 'type';
  await askStep(target, draft, lead);
}

/** Перейти к шагу и задать его вопрос. Черновик пересохраняется — таймаут заново. */
async function goTo(target: SendTarget, userId: number, draft: ReportDraft, step: ReportDraft['step']): Promise<void> {
  draft.step = step;
  reportDraft.set(userId, draft);
  await askStep(target, draft);
}

/** После места: протечка в квартире — «откуда течёт?» (граница собственника), иначе описание. */
async function afterPlace(target: SendTarget, userId: number, draft: ReportDraft): Promise<void> {
  await goTo(target, userId, draft, draft.type === 'leak' && draft.place === 'in_apartment' ? 'leak_source' : 'description');
}

/** К вопросу «где?». Если место у типа одно (лифт — подъезд), не спрашиваем. */
async function toPlace(target: SendTarget, userId: number, draft: ReportDraft): Promise<void> {
  const places = draft.type ? PLACES_BY_TYPE[draft.type] : [];
  if (places.length === 1) {
    draft.place = places[0];
    await afterPlace(target, userId, draft);
    return;
  }
  await goTo(target, userId, draft, 'place');
}

/** Экран зоны собственника. Метрика пилота: сколько обращений закрыто инструкцией. */
async function toOwnerZone(target: SendTarget, userId: number, draft: ReportDraft, zone: OwnerZone): Promise<void> {
  draft.ownerZone = zone;
  log.info('зона собственника', { resident_id: draft.residentId, zone });
  await goTo(target, userId, draft, 'owner');
}

/** «Сообщить о проблеме»: черновик с домом жителя и «Что случилось?». */
async function startReport(target: SendTarget, userId: number | undefined): Promise<void> {
  if (userId === undefined) {
    await askContact(target);
    return;
  }
  const resident = await findResident(target, userId, 'при «Сообщить о проблеме»');
  if (resident === undefined) return;
  if (resident === null) {
    await askContact(target);
    return;
  }

  let house: House | null;
  try {
    house = await apiClient.getHouse(resident.id, shutdown.signal);
  } catch (error) {
    await serviceUnavailable(target, 'при «Сообщить о проблеме»', { resident_id: resident.id }, error);
    return;
  }

  // Новый сценарий — ожидание адреса больше не актуально.
  awaitingAddress.delete(userId);
  await goTo(target, userId, { residentId: resident.id, house: toDraftHouse(house), step: 'type' }, 'type');
}

/** Отправить заявку из черновика. При сбое черновик остаётся — можно нажать ещё раз. */
async function submitTicket(target: SendTarget, userId: number, draft: ReportDraft): Promise<void> {
  if (!draft.type) {
    await goTo(target, userId, draft, 'type');
    return;
  }

  // Сразу убираем: повторное нажатие «Отправить» не создаст вторую заявку.
  reportDraft.delete(userId);

  try {
    const ticket = await apiClient.createTicket(
      draft.residentId,
      { problemType: draft.type, place: draft.place ?? null, description: draft.description ?? null },
      shutdown.signal,
    );
    log.info('заявка создана', {
      resident_id: draft.residentId,
      ticket_id: ticket.id,
      type: draft.type,
      place: draft.place ?? null,
      // Метрика пилота: «всё равно передать в УК» из зоны собственника.
      owner_zone_override: draft.ownerZone !== undefined,
    });
    await sendMenu(target, messages.ticketCreated(ticket.id, draft.type === 'other'));
  } catch (error) {
    if (isAbort(error)) throw error;
    if (error instanceof ApiClientError && error.code === 'not_found') {
      // Житель ушёл в архив, пока заполнял заявку.
      log.warn('заявка от жителя, которого нет', { resident_id: draft.residentId });
      await askContact(target);
      return;
    }
    reportDraft.set(userId, draft);
    await serviceUnavailable(target, 'при отправке заявки', { resident_id: draft.residentId }, error);
  }
}

/**
 * Кнопки шагов заявки. Кнопку «что случилось» из более раннего сообщения
 * принимаем: житель передумал — начинаем с неё, дальнейшие ответы сбрасываются.
 * Кнопка не к месту — повторяем текущий вопрос.
 */
async function handleTicketButton(target: SendTarget, userId: number | undefined, payload: string): Promise<void> {
  const draft = userId === undefined ? undefined : reportDraft.get(userId);
  if (userId === undefined || !draft) {
    await showMenu(target, userId, messages.draftExpired);
    return;
  }

  if (payload === Action.cancelTicket) {
    reportDraft.delete(userId);
    await showMenu(target, userId, messages.ticketCancelled);
    return;
  }

  const [kind, value = ''] = payload.split(':');

  // «Что случилось?»
  if (kind === 'type' && isProblemType(value)) {
    if (value === 'gas') {
      await handleDangerButton(target, userId, 'gas_smell', draft.house);
      return;
    }
    const next: ReportDraft = { residentId: draft.residentId, house: draft.house, step: 'type', type: value };
    if (isClarifyType(value)) {
      await goTo(target, userId, next, 'clarify');
    } else {
      await toPlace(target, userId, next);
    }
    return;
  }

  // Уточнение: опасно? зона собственника? — только к своему типу.
  if (kind === 'clar' && isClarifyType(draft.type) && (CLARIFY_ANSWERS[draft.type] as readonly string[]).includes(value)) {
    switch (value) {
      case 'severe':
        await handleDangerButton(target, userId, 'flooding_threat', draft.house);
        return;
      case 'sparking':
        await handleDangerButton(target, userId, 'exposed_wiring', draft.house);
        return;
      case 'trapped':
        await handleDangerButton(target, userId, 'elevator_entrapment', draft.house);
        return;
      case 'one_socket':
        // Одна розетка при свете у соседей — внутриквартирная проводка.
        draft.place = 'in_apartment';
        await toOwnerZone(target, userId, draft, 'electricity');
        return;
      default: // moderate, outage, broken
        await toPlace(target, userId, draft);
        return;
    }
  }

  // «Где?» — только места, для которых у типа есть правило.
  if (kind === 'place' && isPlace(value) && draft.type && PLACES_BY_TYPE[draft.type].includes(value)) {
    draft.place = value;
    draft.ownerZone = undefined;
    await afterPlace(target, userId, draft);
    return;
  }

  // «Откуда течёт?» — протечка в квартире.
  if (kind === 'src' && draft.type === 'leak' && draft.place === 'in_apartment') {
    if (value === 'owner') {
      await toOwnerZone(target, userId, draft, 'leak');
      return;
    }
    if (value === 'riser' || value === 'valve' || value === 'unknown') {
      // «Не знаю / течёт с потолка» — в УК: по умолчанию в пользу жителя.
      await goTo(target, userId, draft, 'description');
      return;
    }
  }

  // Экран зоны собственника.
  if (kind === 'own' && draft.step === 'owner' && draft.ownerZone) {
    if (value === 'ok') {
      reportDraft.delete(userId);
      log.info('зона собственника — закрыто инструкцией', { resident_id: draft.residentId, zone: draft.ownerZone });
      await showMenu(target, userId);
      return;
    }
    if (value === 'send') {
      // Ответ о границе мог быть ошибочным — не оставляем в тупике: обычная
      // заявка с теми же типом и местом (решение 24.09.2026).
      log.info('зона собственника — всё равно в УК', { resident_id: draft.residentId, zone: draft.ownerZone });
      await goTo(target, userId, draft, 'description');
      return;
    }
    if (value === 'alt') {
      if (draft.ownerZone === 'electricity') {
        await handleDangerButton(target, userId, 'exposed_wiring', draft.house);
      } else {
        // Течёт сам кран или он не перекрывается — это уже общее имущество.
        draft.ownerZone = undefined;
        await goTo(target, userId, draft, 'description');
      }
      return;
    }
  }

  if (payload === Action.skipDescription && draft.step === 'description') {
    draft.description = null;
    await goTo(target, userId, draft, 'confirm');
    return;
  }

  if (payload === Action.sendTicket && draft.step === 'confirm') {
    await submitTicket(target, userId, draft);
    return;
  }

  // Кнопка не к месту (например, «Отправить» из старого сообщения) — повторяем вопрос.
  reportDraft.set(userId, draft);
  await askStep(target, draft, messages.chooseButton);
}

// ── дом жителя ────────────────────────────────────────────────────────────

/**
 * Код дома из QR. Дом жителя заполняется, только если он неизвестен: данные УК
 * главнее. При расхождении api вернёт дом по данным УК и mismatch=true — жителю
 * об этом не говорим, только пишем в лог (решение 24.09.2026).
 */
async function applyInvite(target: SendTarget, resident: Resident, code: string, lead: string): Promise<void> {
  try {
    const result = await apiClient.assignHouseByInvite(resident.id, code, shutdown.signal);

    if (result.kind === 'unknown_code') {
      log.warn('код дома из QR не найден', { resident_id: resident.id });
      await sendMenu(target, `${lead}\n${messages.inviteUnknown}`);
      return;
    }

    if (result.mismatch) {
      log.warn('QR другого дома — показан дом по данным УК', { resident_id: resident.id, house_id: result.house.id });
    }
    await sendHouseChat(target, result.house, lead);
  } catch (error) {
    await serviceUnavailable(target, 'при коде дома из QR', { resident_id: resident.id }, error);
  }
}

/** Кнопка «Чат дома»: дом известен — ссылка; нет — просим адрес. */
async function handleHouseChat(target: SendTarget, userId: number | undefined): Promise<void> {
  if (userId === undefined) {
    await askContact(target);
    return;
  }

  const resident = await findResident(target, userId, 'при «Чат дома»');
  if (resident === undefined) return;
  if (resident === null) {
    await askContact(target);
    return;
  }

  // Другой сценарий — черновик заявки больше не актуален: иначе адрес дома
  // ушёл бы в описание заявки.
  reportDraft.delete(userId);

  let house: House | null;
  try {
    house = await apiClient.getHouse(resident.id, shutdown.signal);
  } catch (error) {
    await serviceUnavailable(target, 'при «Чат дома»', { resident_id: resident.id }, error);
    return;
  }

  if (house) {
    awaitingAddress.delete(userId);
    await sendHouseChat(target, house);
    return;
  }

  awaitingAddress.set(userId, resident.id);
  log.info('ждём адрес дома', { resident_id: resident.id });
  await send(target, messages.askAddress, cancelAddressKeyboard);
}

/** Текст в состоянии «ждём адрес». Сам адрес в лог не пишем — это адрес жительства. */
async function handleAddress(target: SendTarget, userId: number, resident: Resident, text: string): Promise<void> {
  try {
    const result = await apiClient.assignHouseByAddress(resident.id, text, shutdown.signal);

    if (result.kind === 'ok') {
      awaitingAddress.delete(userId);
      log.info('дом найден по адресу', { resident_id: resident.id, house_id: result.house.id });
      await sendHouseChat(target, result.house);
      return;
    }

    // Неверный адрес — остаёмся в ожидании; таймаут отсчитывается заново.
    awaitingAddress.set(userId, resident.id);
    log.info('адрес не принят', { resident_id: resident.id, reason: result.kind });
    const reply = result.kind === 'not_found' ? messages.addressNotFound : messages.addressUnrecognized;
    await send(target, reply, cancelAddressKeyboard);
  } catch (error) {
    await serviceUnavailable(target, 'при вводе адреса', { resident_id: resident.id }, error);
  }
}

// ── вход ──────────────────────────────────────────────────────────────────

/** Параметр диплинка ?start=… — код дома. Формат — как у invite_code в api. */
function readInvite(payload: unknown): string | undefined {
  if (typeof payload !== 'string') return undefined;
  const code = payload.trim();
  if (!code) return undefined;
  if (code.length > 128 || !/^[A-Za-z0-9_-]+$/.test(code)) {
    log.warn('параметр диплинка не похож на код дома — игнорируем', { length: code.length });
    return undefined;
  }
  return code;
}

/**
 * /start и кнопка «Старт» (в т.ч. по QR с кодом дома). Вошёл — приветствие и
 * меню (или сразу чат дома по QR); не вошёл — кнопка контакта, код из QR
 * запоминается до завершения входа.
 */
async function handleStart(target: SendTarget, userId: number | undefined, invite?: string): Promise<void> {
  if (userId === undefined) {
    log.warn('в событии нет user_id — просим контакт');
    await askContact(target);
    return;
  }

  // /start — выход из ожидания адреса и из черновика заявки.
  awaitingAddress.delete(userId);
  reportDraft.delete(userId);

  const resident = await findResident(target, userId, 'при /start');
  if (resident === undefined) return;

  if (resident === null) {
    if (invite) {
      pendingInvite.set(userId, invite);
      log.info('код дома из QR запомнен до входа', { user_id: userId });
    }
    await askContact(target);
    return;
  }

  if (invite) {
    await applyInvite(target, resident, invite, messages.welcomeBack(resident.id));
    return;
  }

  await sendMenu(target, messages.welcomeBack(resident.id));
}

type Contact = NonNullable<ReturnType<typeof findContact>>;

async function handleContact(target: SendTarget, senderId: number | undefined, contact: Contact): Promise<void> {
  const check = verifyContact(contact, senderId, config.token);

  if (!check.ok) {
    // Номер в лог не пишем ни в каком виде: это персональные данные.
    log.warn('контакт не принят', { user_id: senderId, reason: check.reason });

    if (check.reason === 'unsupported_phone') {
      await send(target, messages.unsupportedPhone);
      return;
    }

    const text = check.reason === 'foreign_contact' ? messages.foreignContact : messages.badContact;
    await send(target, text, requestContactKeyboard);
    return;
  }

  // В личном диалоге chat_id есть всегда (docs/max-notes.md, message_created);
  // проверка — чтобы не записать в БД пустую привязку.
  if (senderId === undefined || target.chatId === undefined) {
    log.error('контакт без chat_id или user_id — привязать не к чему', { target });
    await send(target, messages.serviceUnavailable);
    return;
  }

  let resident: Resident;
  try {
    const result = await apiClient.linkByPhone(check.phone, target.chatId, senderId, shutdown.signal);

    if (result.kind === 'not_registered') {
      log.info('номер не найден у УК', { user_id: senderId });
      await send(target, messages.phoneNotRegistered);
      return;
    }

    resident = result.resident;
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'conflict') {
      log.warn('аккаунт MAX уже привязан к другой квартире', { user_id: senderId });
      await send(target, messages.accountLinkedElsewhere);
      return;
    }
    await serviceUnavailable(target, 'при входе', { user_id: senderId }, error);
    return;
  }

  log.info('житель вошёл', { resident_id: resident.id, user_id: senderId });

  // Пришёл по QR до входа — сразу показываем чат дома.
  const invite = pendingInvite.get(senderId);
  if (invite) {
    pendingInvite.delete(senderId);
    await applyInvite(target, resident, invite, messages.loggedIn(resident.id));
    return;
  }

  await sendMenu(target, messages.loggedIn(resident.id));
}

/**
 * Обычный текст. Сначала — страховка по словам: огонь и дым (101/112), затем
 * опасность; они важнее любого шага сценария и не требуют входа. Дальше:
 * черновик заявки ждёт описание — это описание; ждём адрес — это адрес;
 * иначе меню (или кнопка контакта, если не вошёл).
 */
async function handleText(target: SendTarget, userId: number | undefined, text: string): Promise<void> {
  if (detectFire(text)) {
    await handleFire(target, userId);
    return;
  }

  const danger = detectDanger(text);
  if (danger) {
    await handleDangerText(target, userId, text, danger);
    return;
  }

  const draft = userId === undefined ? undefined : reportDraft.get(userId);
  if (userId !== undefined && draft) {
    if (draft.step === 'description') {
      // Лимит api — 4000; длиннее MAX и не пришлёт, но обрезаем на всякий случай.
      draft.description = text.slice(0, 4000);
      await goTo(target, userId, draft, 'confirm');
      return;
    }
    // Ждём кнопку, а пришёл текст — напоминаем и повторяем вопрос.
    reportDraft.set(userId, draft);
    await askStep(target, draft, messages.chooseButton);
    return;
  }

  if (userId === undefined || awaitingAddress.get(userId) === undefined) {
    await showMenu(target, userId);
    return;
  }

  const resident = await findResident(target, userId, 'при вводе адреса');
  if (resident === undefined) return;
  if (resident === null) {
    awaitingAddress.delete(userId);
    await askContact(target);
    return;
  }

  await handleAddress(target, userId, resident, text);
}

/** Нажатие inline-кнопки. Сначала отвечаем на нажатие, потом делаем дело. */
async function handleCallback(target: SendTarget, update: MaxUpdate): Promise<void> {
  const callback = update.callback;
  if (!callback) return;

  const userId = callback.user?.user_id;

  const answer = async (notification: string): Promise<void> => {
    try {
      await api.answerCallback(callback.callback_id, notification, shutdown.signal);
    } catch (error) {
      if (isAbort(error)) throw error;
      // Без ответа на нажатие дело всё равно делаем — это важнее индикатора.
      log.warn('ответ на нажатие не отправлен', { error: errorText(error) });
    }
  };

  const payload = callback.payload ?? '';

  // «Да, это авария» после подозрения по словам: danger_confirm:<тип>.
  const [prefix, type] = payload.split(':');
  if (prefix === 'danger_confirm' && type && isDangerType(type)) {
    await answer('Принято');
    const text = userId === undefined ? undefined : pendingDangerText.get(userId);
    if (userId !== undefined) {
      pendingDangerText.delete(userId);
      // Авария вместо обычной заявки: черновик больше не нужен.
      reportDraft.delete(userId);
    }
    await registerEmergency(target, userId, type, text ?? null);
    return;
  }

  if (
    /^(type|clar|place|src|own):/.test(payload) ||
    payload === Action.skipDescription ||
    payload === Action.sendTicket ||
    payload === Action.cancelTicket
  ) {
    await answer(payload === Action.cancelTicket ? 'Отменено' : 'Принято');
    await handleTicketButton(target, userId, payload);
    return;
  }

  switch (payload) {
    case Action.report: {
      await answer('Сообщить о проблеме');
      await startReport(target, userId);
      return;
    }

    case Action.gasCalled: {
      await answer('Спасибо');
      await showMenu(target, userId, messages.gasCalled);
      return;
    }

    case Action.dismissDanger: {
      await answer('Хорошо');
      const text = userId === undefined ? undefined : pendingDangerText.get(userId);
      const draft = userId === undefined ? undefined : reportDraft.get(userId);
      if (userId !== undefined) pendingDangerText.delete(userId);

      // Слово-признак попалось посреди заявки — не авария, продолжаем её. Если
      // это было описание, оно и становится описанием заявки.
      if (userId !== undefined && draft) {
        if (draft.step === 'description' && text) {
          draft.description = text.slice(0, 4000);
          await goTo(target, userId, draft, 'confirm');
        } else {
          reportDraft.set(userId, draft);
          await askStep(target, draft, 'Хорошо, продолжим заявку.');
        }
        return;
      }

      await showMenu(target, userId, messages.dangerDismissed);
      return;
    }

    case Action.houseChat: {
      await answer('Чат дома');
      await handleHouseChat(target, userId);
      return;
    }

    case Action.cancelAddress: {
      if (userId !== undefined) awaitingAddress.delete(userId);
      await answer('Отменено');
      await sendMenu(target, messages.addressCancelled);
      return;
    }

    default: {
      // Кнопка из старого сообщения, чей payload мы больше не знаем.
      log.debug('неизвестная кнопка', { payload: callback.payload });
      await answer('Кнопка устарела');
      await showMenu(target, userId);
    }
  }
}

async function handleUpdate(update: MaxUpdate): Promise<void> {
  const target = resolveTarget(update);

  if (!target) {
    // Не ошибка: часть событий (например, bot_removed) отвечать и не предполагает.
    log.debug('событие без адресата — пропускаем', { update_type: update.update_type });
    return;
  }

  switch (update.update_type) {
    // Нажата кнопка «Старт» — в новом диалоге или по диплинку ?start=код_дома.
    // message_created при этом НЕ приходит, поэтому без этой ветки бот молчит.
    case 'bot_started': {
      const invite = readInvite(update.payload);
      log.info('диалог начат', { target, by_qr: invite !== undefined });
      await handleStart(target, update.user?.user_id, invite);
      return;
    }

    case 'message_callback': {
      log.info('нажата кнопка', { target, payload: update.callback?.payload });
      await handleCallback(target, update);
      return;
    }

    case 'message_created': {
      const sender = update.message?.sender;

      // Иначе два бота в одном чате уйдут в бесконечный диалог друг с другом.
      if (sender?.is_bot) {
        log.debug('сообщение от бота — игнорируем', { user_id: sender.user_id });
        return;
      }

      // Контакт приходит сообщением без текста — ловим его до проверки текста,
      // иначе ответом было бы «понимаю только текст».
      const contact = findContact(update.message);
      if (contact) {
        await handleContact(target, sender?.user_id, contact);
        return;
      }

      const text = update.message?.body?.text?.trim();

      if (!text) {
        await send(target, messages.nonText);
        return;
      }

      if (text.startsWith('/start')) {
        log.info('команда /start', { target });
        await handleStart(target, sender?.user_id);
        return;
      }

      await handleText(target, sender?.user_id, text);
      return;
    }

    default: {
      log.debug('тип события не обрабатывается', { update_type: update.update_type });
    }
  }
}

async function pollLoop(): Promise<void> {
  // null на первом запросе: MAX отдаст только свежие события, а не весь бэклог,
  // иначе при рестарте бот заспамит всех, кто писал, пока он лежал.
  let marker: number | null = null;
  let failures = 0;

  while (running) {
    try {
      const response = await api.getUpdates(marker, shutdown.signal);
      failures = 0;

      const updates = response.updates ?? [];
      if (updates.length > 0) {
        log.debug('получены события', { count: updates.length });
      }

      for (const update of updates) {
        if (!running) break;
        try {
          await handleUpdate(update);
        } catch (error) {
          if (isAbort(error)) break;
          // Одно упавшее событие не должно валить цикл: остальные обработаем.
          if (error instanceof MaxApiError && error.isFatal) throw error;
          log.error('ошибка обработки события', {
            update_type: update.update_type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Маркер двигаем только после успешного ответа. Если MAX его не прислал,
      // оставляем прежний, иначе следующий запрос снова сползёт на «только свежие».
      if (typeof response.marker === 'number') marker = response.marker;
    } catch (error) {
      if (isAbort(error) || !running) break;

      if (error instanceof MaxApiError && error.isFatal) {
        log.error('токен отклонён MAX — работать дальше нельзя', {
          status: error.status,
          hint: 'проверь MAX_BOT_TOKEN в .env; токен мог быть отозван или перевыпущен',
        });
        process.exitCode = 1;
        return;
      }

      failures += 1;
      // Экспоненциальный backoff с потолком: сеть или MAX могут лежать,
      // долбить их в упор смысла нет.
      const delayMs = Math.min(1000 * 2 ** (failures - 1), 30_000);
      log.warn('ошибка опроса — повтор', {
        attempt: failures,
        delay_ms: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs);
    }
  }
}

function installSignalHandlers(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (!running) return;
      log.info('остановка', { signal });
      running = false;
      shutdown.abort();
    });
  }
}

export async function run(): Promise<void> {
  installSignalHandlers();

  log.info('бот запускается', {
    api: config.baseUrl,
    transport: 'long polling',
    poll_timeout_sec: config.pollTimeoutSec,
    // Длину токена логируем, сам токен — никогда.
    token_length: config.token.length,
  });

  // Заранее, чтобы первое же меню пришло с кнопкой заявки и проблема с
  // username была видна в логе сразу, а не при первом нажатии.
  await getBotUsername();

  await pollLoop();
  log.info('бот остановлен');
}
