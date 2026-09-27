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
import { ApiClient, ApiClientError, type House, type Resident, type Ticket } from './api-client.js';
import { findContact, verifyContact } from './auth.js';
import { cutText, DESCRIPTION_LIMIT } from './text.js';
import { config, messages } from './config.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  awaitingAddress,
  liveMessage,
  pendingDangerText,
  pendingInvite,
  recentEmergency,
  pendingEmergencyHouse,
  recentSubmit,
  reportDraft,
} from './dialog-state.js';
import { detectDanger, detectFire, isDangerType, type DangerType } from './emergency.js';
import { parseStatusCommand, parseTicketNumber } from './status.js';
import {
  Action,
  cancelAddressKeyboard,
  clarifyKeyboard,
  confirmCancelKeyboard,
  ticketDetailsKeyboard,
  confirmDangerKeyboard,
  confirmTicketKeyboard,
  descriptionKeyboard,
  gasCalledKeyboard,
  houseChatKeyboard,
  leakSourceKeyboard,
  menuKeyboard,
  notificationKeyboard,
  ownerZoneKeyboard,
  placeKeyboard,
  requestContactKeyboard,
  resumeDraftKeyboard,
  emergencyHouseKeyboard,
  houseChatChoiceKeyboard,
  reportHouseKeyboard,
  typeKeyboard,
  roomKeyboard,
  roomsCountKeyboard,
  serviceKeyboard,
  waterKeyboard,
} from './keyboards.js';
import { log } from './logger.js';
import { MaxApi, MaxApiError, type MaxAttachment, type MaxUpdate, type SendTarget } from './max-api.js';
import {
  PLACES_BY_TYPE,
  ROOMS_BY_TYPE,
  ROOM_COUNTS,
  isMeterType,
  isPlace,
  isProblemType,
  isServiceType,
  type DraftHouse,
  type OwnerZone,
  type ReportDraft,
  type Room,
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

/**
 * Нажатие кнопки, которое сейчас обрабатывается. Первый ответ бота ЗАМЕНЯЕТ
 * сообщение с нажатой кнопкой (ответ на нажатие с полем message, docs/max-notes.md)
 * — в чате остаётся одно «живое» сообщение, а не лента устаревших вопросов
 * (решение 26.09.2026). Остальные ответы на то же нажатие — новыми сообщениями.
 */
interface CallbackScope {
  callbackId: string;
  /** Короткое уведомление на нажатие — уходит вместе с первым ответом. */
  notification: string | null;
  answered: boolean;
  /** mid сообщения с нажатой кнопкой — после замены оно «живое». */
  pressedMid: string | null;
}
const callbackScope = new AsyncLocalStorage<CallbackScope>();

interface SendOptions {
  /**
   * Сообщение, которое бот не трогает: номер заявки, инструкция при аварии,
   * уведомление. Его не удаляют и не заменяют следующим шагом.
   */
  persistent?: boolean;
}

async function send(
  target: SendTarget,
  text: string,
  attachments: MaxAttachment[] = [],
  options: SendOptions = {},
): Promise<void> {
  const chatId = target.chatId;
  const scope = callbackScope.getStore();

  // Заменять можно только текущее «живое» сообщение. Кнопка из старого или уже
  // превращённого сообщения (второе быстрое нажатие «Отправить» — то сообщение
  // стало номером заявки) — отвечаем новым сообщением, историю не трогаем.
  const live = chatId !== undefined ? liveMessage.get(chatId) : undefined;
  const canReplace = scope?.pressedMid != null && (live === undefined || live === scope.pressedMid);
  if (scope && !scope.answered && !canReplace) {
    scope.answered = true;
    await api
      .answerCallback(scope.callbackId, { notification: scope.notification ?? 'Готово' }, shutdown.signal)
      .catch((error: unknown) => {
        if (isAbort(error)) throw error;
        log.warn('ответ на нажатие не отправлен', { error: errorText(error) });
      });
  }

  if (scope && !scope.answered) {
    scope.answered = true;
    try {
      await api.answerCallback(
        scope.callbackId,
        { notification: scope.notification ?? undefined, message: { text, attachments } },
        shutdown.signal,
      );
      if (chatId !== undefined) {
        if (!options.persistent && scope.pressedMid) liveMessage.set(chatId, scope.pressedMid);
        else liveMessage.delete(chatId);
      }
      return;
    } catch (error) {
      if (isAbort(error)) throw error;
      // Заменить не вышло — ответ жителю важнее: отправим новым сообщением.
      log.warn('замена сообщения не удалась — отправляем новым', { error: errorText(error) });
    }
  }

  const mid = await api.sendMessage(target, text, shutdown.signal, attachments);
  if (chatId !== undefined && !options.persistent && mid) liveMessage.set(chatId, mid);
}

/**
 * Житель ответил текстом (или контактом) — прежний вопрос бота больше не нужен:
 * удаляем его, следующий шаг придёт новым сообщением. Не вышло (нет прав,
 * уже удалено) — не беда: ответ жителю важнее.
 */
async function dropLiveMessage(target: SendTarget): Promise<void> {
  if (target.chatId === undefined) return;
  const mid = liveMessage.get(target.chatId);
  if (!mid) return;
  liveMessage.delete(target.chatId);
  try {
    await api.deleteMessage(mid, shutdown.signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    log.debug('старое сообщение бота не удалено', { error: errorText(error) });
  }
}

/** Сообщение, которое остаётся в чате (номер заявки, уведомление), и под ним — меню. */
async function sendKeptThenMenu(target: SendTarget, text: string): Promise<void> {
  await send(target, text, [], { persistent: true });
  await sendMenu(target);
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
  // С меню: если это ответ на кнопку, он заменит меню — без кнопок житель
  // не смог бы даже повторить.
  await send(target, messages.serviceUnavailable, menuKeyboard(await getBotUsername()));
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
    ? {
        id: house.id,
        address: house.address,
        emergency_phone: house.emergency_phone,
        has_gas: house.has_gas,
        uk_name: house.uk_name,
      }
    : null;

/**
 * Дом жителя для экстренного текста; null — не вошёл, дома нет, api не успел
 * или домов несколько и какой — ещё неизвестно (тогда в тексте 112).
 */
async function houseForEmergency(userId: number | undefined): Promise<DraftHouse | null> {
  if (userId === undefined) return null;
  const draft = reportDraft.get(userId);
  if (draft) return draft.house;

  try {
    const resident = await quickApiClient.findByMaxUser(userId, shutdown.signal);
    if (!resident) return null;
    const houses = await quickApiClient.getHouses(resident.id, shutdown.signal);
    return houses.length === 1 ? toDraftHouse(houses[0]!) : null;
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
  houseId?: number,
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

    // Дом неизвестен, а квартир в нескольких домах — спрашиваем, в каком авария:
    // заявка должна уйти в УК того дома (кейс 10 чек-листа). Инструкция уже у жителя.
    if (houseId === undefined) {
      const houses = await apiClient.getHouses(resident.id, shutdown.signal);
      if (houses.length > 1) {
        pendingEmergencyHouse.set(userId, { type, description });
        await send(target, messages.askEmergencyHouse, emergencyHouseKeyboard(houses));
        return;
      }
    }

    const ticket = await apiClient.createTicket(
      resident.id,
      { problemType: type, description, ...(houseId !== undefined ? { houseId } : {}) },
      shutdown.signal,
    );
    recentEmergency.set(userId, { ...recentEmergency.get(userId), [type]: ticket.id });
    // warn, а не info: аварийную заявку в логе должно быть видно сразу.
    log.warn('аварийная заявка', { resident_id: resident.id, ticket_id: ticket.id, type });
    await send(
      target,
      messages.emergencyTicketCreated(ticket),
      type === 'gas_smell' ? gasCalledKeyboard : [],
      { persistent: true },
    );
    // Меню — отдельным сообщением: номер аварийной заявки из чата не уходит.
    await sendMenu(target);
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
  await send(target, messages.dangerInstructions(type, house, 'button'), [], { persistent: true });
  await registerEmergency(target, userId, type, null, house?.id);
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
    pendingDangerText.set(userId, cutText(text, DESCRIPTION_LIMIT).text);
  }
  await send(target, messages.dangerInstructions(type, house, 'confirm'), confirmDangerKeyboard(type), {
    persistent: true,
  });
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
  await send(target, messages.fire, [], { persistent: true });
}

// ── обычная заявка ────────────────────────────────────────────────────────

/** Ответы уточняющего вопроса — по типу. Кнопка от другого типа не принимается. */
const CLARIFY_ANSWERS = {
  leak: ['severe', 'moderate'],
  electricity: ['sparking', 'outage', 'one_socket'],
  elevator: ['trapped', 'broken'],
  blockage: ['sewage', 'chute'],
} as const;
type ClarifyType = keyof typeof CLARIFY_ANSWERS;
const isClarifyType = (type: string | undefined): type is ClarifyType => type !== undefined && type in CLARIFY_ANSWERS;

/** Вопрос текущего шага черновика — после перехода и когда житель пишет вместо кнопки. */
async function askStep(target: SendTarget, draft: ReportDraft, lead?: string): Promise<void> {
  const withLead = (text: string): string => (lead ? `${lead}\n${text}` : text);

  switch (draft.step) {
    case 'house':
      if (draft.houses && draft.houses.length > 0) {
        await send(target, withLead(messages.askHouse), reportHouseKeyboard(draft.houses));
        return;
      }
      break;
    case 'type': {
      const withBack = (draft.history?.length ?? 0) > 0;
      if (draft.mode === 'service') {
        await send(target, withLead(messages.askService), serviceKeyboard(withBack));
        return;
      }
      const hasGas = draft.house?.has_gas ?? true;
      await send(target, withLead(messages.askType(hasGas)), typeKeyboard(hasGas, withBack));
      return;
    }
    case 'room':
      if (draft.type && ROOMS_BY_TYPE[draft.type]) {
        await send(target, withLead(messages.askRoom(draft.type)), roomKeyboard(draft.type));
        return;
      }
      break;
    case 'water':
      await send(target, withLead(messages.askWater), waterKeyboard);
      return;
    case 'rooms_count':
      await send(target, withLead(messages.askRoomsCount), roomsCountKeyboard);
      return;
    case 'clarify':
      if (isClarifyType(draft.type)) {
        await send(target, withLead(messages.askClarify(draft.type)), clarifyKeyboard(draft.type));
        return;
      }
      break;
    case 'place':
      if (draft.type && !isServiceType(draft.type)) {
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
    case 'description': {
      const ask = draft.type && isServiceType(draft.type) ? messages.askServiceComment : messages.askDescription;
      await send(target, withLead(ask), descriptionKeyboard);
      return;
    }
    case 'confirm':
      if (draft.type) {
        const summary = messages.confirmTicket({
          type: draft.type,
          place: draft.place,
          detail: draft.detail,
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

/**
 * Состояние черновика ДО текущего нажатия — для «Назад». Запоминается в начале
 * обработки кнопки или текста, в историю попадает при переходе на новый шаг.
 * Обработка событий строго по одному (pollLoop), поэтому хватает одной переменной.
 */
let stepBefore: { userId: number; snapshot: ReportDraft; history: ReportDraft[] } | null = null;

function rememberStepBefore(userId: number, draft: ReportDraft): void {
  const { history = [], ...snapshot } = draft;
  stepBefore = { userId, snapshot: { ...snapshot }, history };
}

/** Перейти к шагу и задать его вопрос. Черновик пересохраняется — таймаут заново. */
async function goTo(
  target: SendTarget,
  userId: number,
  draft: ReportDraft,
  step: ReportDraft['step'],
  lead?: string,
): Promise<void> {
  if (stepBefore?.userId === userId) {
    draft.history = [...stepBefore.history, stepBefore.snapshot];
    stepBefore = null;
  }
  draft.step = step;
  reportDraft.set(userId, draft);
  await askStep(target, draft, lead);
}

/**
 * «Назад»: вернуть черновик в состояние до последнего шага. На первом шаге
 * кнопки нет (там «Отмена»), но старая кнопка из прежнего сообщения — в меню.
 */
async function goBack(target: SendTarget, userId: number, draft: ReportDraft): Promise<void> {
  const history = [...(draft.history ?? [])];
  const previous = history.pop();
  if (!previous) {
    reportDraft.delete(userId);
    await showMenu(target, userId);
    return;
  }
  const restored: ReportDraft = { ...previous, history };
  reportDraft.set(userId, restored);
  await askStep(target, restored);
}

/** После места: протечка в квартире — «откуда течёт?» (граница собственника), иначе описание. */
async function afterPlace(target: SendTarget, userId: number, draft: ReportDraft): Promise<void> {
  await goTo(target, userId, draft, draft.type === 'leak' && draft.place === 'in_apartment' ? 'leak_source' : 'description');
}

/** К вопросу «где?». Если место у типа одно (лифт — подъезд), не спрашиваем. */
async function toPlace(target: SendTarget, userId: number, draft: ReportDraft): Promise<void> {
  const places = draft.type && !isServiceType(draft.type) ? PLACES_BY_TYPE[draft.type] : [];
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
async function startReport(
  target: SendTarget,
  userId: number | undefined,
  options: { resume?: boolean; service?: boolean } = {},
): Promise<void> {
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

  // Заявка брошена на середине — не выбрасываем молча: продолжить или заново
  // (кейс 7 чек-листа). На первом шаге терять нечего — просто начинаем.
  const unfinished = reportDraft.get(userId);
  if (options.resume !== false && unfinished && unfinished.step !== 'type' && unfinished.residentId === resident.id) {
    await send(target, messages.draftResume(unfinished.type), resumeDraftKeyboard);
    return;
  }

  let houses: House[];
  try {
    houses = await apiClient.getHouses(resident.id, shutdown.signal);
  } catch (error) {
    await serviceUnavailable(target, 'при «Сообщить о проблеме»', { resident_id: resident.id }, error);
    return;
  }

  // Новый сценарий — ожидание адреса больше не актуально.
  awaitingAddress.delete(userId);
  const mode = options.service ? { mode: 'service' as const } : {};
  if (houses.length > 1) {
    // Квартиры в нескольких домах — сначала «В каком доме?» (кейс 10 чек-листа).
    const options = houses.map((house) => toDraftHouse(house)!);
    await goTo(target, userId, { residentId: resident.id, house: null, houses: options, step: 'house', ...mode }, 'house');
    return;
  }
  await goTo(target, userId, { residentId: resident.id, house: toDraftHouse(houses[0] ?? null), step: 'type', ...mode }, 'type');
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
      {
        problemType: draft.type,
        place: draft.place ?? null,
        description: draft.description ?? null,
        detailCode: draft.detail ?? null,
        ...(draft.house ? { houseId: draft.house.id } : {}),
      },
      shutdown.signal,
    );
    recentSubmit.set(userId, ticket.id);
    log.info('заявка создана', {
      resident_id: draft.residentId,
      ticket_id: ticket.id,
      type: draft.type,
      place: draft.place ?? null,
      detail: draft.detail ?? null,
      rule: ticket.rule_id,
      // Метрика пилота: «всё равно передать в УК» из зоны собственника.
      owner_zone_override: draft.ownerZone !== undefined,
    });
    await sendKeptThenMenu(target, messages.ticketCreated(ticket, draft.type === 'other'));
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
    // Второе быстрое нажатие «Отправить»: заявка уже создана — одна, с одним
    // номером (кейс N04). Только уведомление на нажатие, без новых сообщений.
    const sentId = userId === undefined ? undefined : recentSubmit.get(userId);
    if (payload === Action.sendTicket && sentId !== undefined) {
      const scope = callbackScope.getStore();
      if (scope) scope.notification = `Заявка №${sentId} уже отправлена`;
      log.info('повторное «Отправить» — заявка уже создана', { user_id: userId, ticket_id: sentId });
      return;
    }
    await showMenu(target, userId, messages.draftExpired);
    return;
  }

  if (payload === Action.cancelTicket) {
    reportDraft.delete(userId);
    await showMenu(target, userId, messages.ticketCancelled);
    return;
  }

  if (payload === Action.back) {
    await goBack(target, userId, draft);
    return;
  }

  // Шаг вперёд — запоминаем, куда вернёт «Назад».
  rememberStepBefore(userId, draft);

  const [kind, value = ''] = payload.split(':');

  // «В каком доме проблема?»
  if (kind === 'rh') {
    const chosen = draft.step === 'house' ? draft.houses?.find((house) => house.id === Number(value)) : undefined;
    if (!chosen) {
      reportDraft.set(userId, draft);
      await askStep(target, draft, messages.chooseButton);
      return;
    }
    await goTo(target, userId, { residentId: draft.residentId, house: chosen, step: 'type', mode: draft.mode }, 'type');
    return;
  }

  // Дом ещё не выбран — кнопки дальних шагов из старых сообщений не принимаем.
  if (draft.step === 'house') {
    reportDraft.set(userId, draft);
    await askStep(target, draft, messages.chooseButton);
    return;
  }

  // «Что случилось?» / «Какая услуга нужна?»
  if (kind === 'type' && (isProblemType(value) || isServiceType(value))) {
    if (value === 'gas') {
      await handleDangerButton(target, userId, 'gas_smell', draft.house);
      return;
    }
    const next: ReportDraft = { residentId: draft.residentId, house: draft.house, step: 'type', type: value, mode: draft.mode };
    // Счётчики и батареи — в квартире: место не спрашиваем, дальше «где в квартире?».
    if (ROOMS_BY_TYPE[value]) {
      next.place = 'in_apartment';
      await goTo(target, userId, next, 'room');
      return;
    }
    if (isServiceType(value)) return; // у каждой услуги есть шаг «где», сюда не попасть
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
        draft.detail = 'one_socket';
        await toOwnerZone(target, userId, draft, 'electricity');
        return;
      case 'chute':
        // Мусоропровод — всегда в подъезде, место не спрашиваем.
        draft.detail = 'chute';
        draft.place = 'entrance';
        await afterPlace(target, userId, draft);
        return;
      default: // moderate, outage, broken, sewage
        draft.detail = value;
        await toPlace(target, userId, draft);
        return;
    }
  }

  // «Где в квартире?» — счётчики: дальше ГВС/ХВС; батареи: кухня — к описанию, комната — «сколько?».
  if (kind === 'room' && draft.step === 'room' && draft.type && ROOMS_BY_TYPE[draft.type]?.includes(value as Room)) {
    const room = value as Room;
    draft.room = room;
    if (isMeterType(draft.type)) {
      await goTo(target, userId, draft, 'water');
    } else if (room === 'room') {
      await goTo(target, userId, draft, 'rooms_count');
    } else {
      draft.detail = room;
      await goTo(target, userId, draft, 'description');
    }
    return;
  }

  // «Какой счётчик?» — detail_code: помещение + вода, kitchen_hot…
  if (kind === 'water' && draft.step === 'water' && draft.room && (value === 'hot' || value === 'cold')) {
    draft.detail = `${draft.room}_${value}`;
    await goTo(target, userId, draft, 'description');
    return;
  }

  // «Сколько комнат?» — rooms_one … rooms_five_plus.
  if (kind === 'rooms' && draft.step === 'rooms_count' && value in ROOM_COUNTS) {
    draft.detail = `rooms_${value}`;
    await goTo(target, userId, draft, 'description');
    return;
  }

  // «Где?» — только места, для которых у типа есть правило.
  if (
    kind === 'place' &&
    isPlace(value) &&
    draft.type &&
    !isServiceType(draft.type) &&
    PLACES_BY_TYPE[draft.type].includes(value)
  ) {
    draft.place = value;
    draft.ownerZone = undefined;
    await afterPlace(target, userId, draft);
    return;
  }

  // «Откуда течёт?» — протечка в квартире.
  if (kind === 'src' && draft.type === 'leak' && draft.place === 'in_apartment') {
    if (value === 'owner') {
      draft.detail = 'owner';
      await toOwnerZone(target, userId, draft, 'leak');
      return;
    }
    if (value === 'riser' || value === 'valve' || value === 'unknown') {
      // «Не знаю / течёт с потолка» — в УК: по умолчанию в пользу жителя.
      draft.detail = value;
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
      // Правило — ручная классификация (routing.ts, OWNER_OVERRIDE).
      draft.detail = 'owner_override';
      await goTo(target, userId, draft, 'description');
      return;
    }
    if (value === 'alt') {
      if (draft.ownerZone === 'electricity') {
        await handleDangerButton(target, userId, 'exposed_wiring', draft.house);
      } else {
        // Течёт сам кран или он не перекрывается — это уже общее имущество.
        draft.ownerZone = undefined;
        draft.detail = 'valve';
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

// ── «Статус»: свои заявки ─────────────────────────────────────────────────

/** Вошедший житель или null, если ответ уже отправлен (не вошёл, api недоступен). */
async function requireResident(target: SendTarget, userId: number | undefined, where: string): Promise<Resident | null> {
  if (userId === undefined) {
    await askContact(target);
    return null;
  }
  const resident = await findResident(target, userId, where);
  if (resident === undefined) return null;
  if (resident === null) {
    await askContact(target);
    return null;
  }
  return resident;
}

/**
 * «Мои заявки» / «Статус»: незакрытые заявки. Одна — сразу подробности,
 * несколько — список и «отправьте номер», ни одной — как создать новую.
 */
async function showTickets(target: SendTarget, userId: number | undefined): Promise<void> {
  const resident = await requireResident(target, userId, 'при «Мои заявки»');
  if (!resident) return;

  try {
    const tickets = await apiClient.listTickets(resident.id, true, shutdown.signal);
    log.info('мои заявки', { resident_id: resident.id, active: tickets.length });

    if (tickets.length === 0) await sendMenu(target, messages.noActiveTickets);
    else if (tickets.length === 1) await sendTicketDetails(target, tickets[0]!);
    else await sendMenu(target, messages.ticketList(tickets));
  } catch (error) {
    await serviceUnavailable(target, 'при «Мои заявки»', { resident_id: resident.id }, error);
  }
}

/**
 * Одна заявка по номеру — только своя. Чужую отвечаем так же, как
 * несуществующую: иначе перебором номеров можно узнать, какие заявки есть.
 */
async function showTicket(target: SendTarget, userId: number | undefined, ticketId: number): Promise<void> {
  const resident = await requireResident(target, userId, 'при «статус N»');
  if (!resident) return;

  try {
    const ticket = await apiClient.getTicket(ticketId, shutdown.signal);
    if (!ticket || ticket.resident_id !== resident.id) {
      log.info('статус: заявка не найдена среди своих', { resident_id: resident.id, ticket_id: ticketId });
      await sendMenu(target, messages.ticketNotFound(ticketId));
      return;
    }
    await sendTicketDetails(target, ticket);
  } catch (error) {
    await serviceUnavailable(target, 'при «статус N»', { resident_id: resident.id, ticket_id: ticketId }, error);
  }
}

/** Подробности заявки с кнопкой «Отменить заявку» (если можно) и меню. */
async function sendTicketDetails(target: SendTarget, ticket: Ticket): Promise<void> {
  await send(target, messages.ticketDetails(ticket), ticketDetailsKeyboard(ticket, await getBotUsername()));
}

/**
 * Отмена заявки жителем: tc:ask — «точно?», tc:yes — отменить, tc:no — вернуть
 * подробности. Только своя и только «принятая» — проверяет api.
 */
async function handleCancelButton(target: SendTarget, userId: number | undefined, payload: string): Promise<void> {
  const [, step, rawId] = payload.split(':');
  const ticketId = Number(rawId);
  if (!Number.isSafeInteger(ticketId) || ticketId < 1) {
    await showMenu(target, userId);
    return;
  }

  if (step === 'ask') {
    await send(target, messages.confirmCancel(ticketId), confirmCancelKeyboard(ticketId));
    return;
  }
  if (step === 'no') {
    await showTicket(target, userId, ticketId);
    return;
  }

  const resident = await requireResident(target, userId, 'при отмене заявки');
  if (!resident) return;
  try {
    const result = await apiClient.cancelTicket(resident.id, ticketId, shutdown.signal);
    if (result.kind === 'ok') {
      log.info('заявка отменена жителем', { resident_id: resident.id, ticket_id: ticketId });
      await sendKeptThenMenu(target, messages.ticketCancelledByResident(ticketId));
    } else if (result.kind === 'not_cancellable') {
      await sendMenu(target, messages.notCancellable(ticketId));
    } else {
      await sendMenu(target, messages.ticketNotFound(ticketId));
    }
  } catch (error) {
    await serviceUnavailable(target, 'при отмене заявки', { resident_id: resident.id, ticket_id: ticketId }, error);
  }
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

/**
 * Кнопка «Чат дома»: дом известен — ссылка; нет — просим адрес. Домов
 * несколько — сначала выбор дома (кейс 10 чек-листа); houseId — уже выбран.
 */
async function handleHouseChat(target: SendTarget, userId: number | undefined, houseId?: number): Promise<void> {
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

  let houses: House[];
  try {
    houses = await apiClient.getHouses(resident.id, shutdown.signal);
  } catch (error) {
    await serviceUnavailable(target, 'при «Чат дома»', { resident_id: resident.id }, error);
    return;
  }

  if (houses.length > 1 && houseId === undefined) {
    awaitingAddress.delete(userId);
    await send(target, messages.chooseHouseChat, houseChatChoiceKeyboard(houses));
    return;
  }

  // Выбранного дома у жителя уже нет (УК убрала квартиру) — первый из его домов.
  const house = houses.find((h) => h.id === houseId) ?? houses[0];
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
/**
 * Фото, стикер, голосовое, файл без текста. Посреди сценария — повторяем текущий
 * вопрос с просьбой ответить кнопкой или текстом: сценарий продолжается с того
 * же шага (кейс 5 чек-листа). Вне сценария — меню.
 */
async function handleNonText(target: SendTarget, userId: number | undefined): Promise<void> {
  const draft = userId === undefined ? undefined : reportDraft.get(userId);
  if (userId !== undefined && draft) {
    reportDraft.set(userId, draft);
    await askStep(target, draft, draft.step === 'description' ? messages.nonTextDescription : messages.nonTextChooseButton);
    return;
  }

  const addressFor = userId === undefined ? undefined : awaitingAddress.get(userId);
  if (userId !== undefined && addressFor !== undefined) {
    awaitingAddress.set(userId, addressFor);
    await send(target, messages.nonTextAddress, cancelAddressKeyboard);
    return;
  }

  await showMenu(target, userId, messages.nonText);
}

/** withMedia — к тексту приложено фото или файл (текст — подпись к нему). */
async function handleText(target: SendTarget, userId: number | undefined, text: string, withMedia = false): Promise<void> {
  if (detectFire(text)) {
    await handleFire(target, userId);
    return;
  }

  const danger = detectDanger(text);
  if (danger) {
    await handleDangerText(target, userId, text, danger);
    return;
  }

  // «Статус» — «в любой момент» (тексты Павла): черновик заявки не трогаем,
  // после ответа житель может продолжить её с того же шага.
  const command = parseStatusCommand(text);
  if (command) {
    await (command.kind === 'list' ? showTickets(target, userId) : showTicket(target, userId, command.ticketId));
    return;
  }

  const draft = userId === undefined ? undefined : reportDraft.get(userId);
  if (userId !== undefined && draft) {
    if (draft.step === 'description') {
      rememberStepBefore(userId, draft);
      // Лимит api — 4000 символов; длиннее MAX и не пришлёт, но обрезаем на всякий
      // случай — по символам, эмодзи не разрезается (кейс 6 чек-листа).
      draft.description = cutText(text, DESCRIPTION_LIMIT).text;
      await goTo(target, userId, draft, 'confirm', withMedia ? messages.photoNotAttached : undefined);
      return;
    }
    // Ждём кнопку, а пришёл текст — напоминаем и повторяем вопрос.
    reportDraft.set(userId, draft);
    await askStep(target, draft, messages.chooseButton);
    return;
  }

  if (userId === undefined || awaitingAddress.get(userId) === undefined) {
    // Голый номер — ответ на «отправьте номер заявки». Только вне сценариев:
    // в описании заявки или в адресе «12» — это описание или адрес.
    const ticketId = parseTicketNumber(text);
    if (ticketId !== null) {
      await showTicket(target, userId, ticketId);
      return;
    }
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

/**
 * «Понятно» / «Подробнее» под уведомлением о смене статуса. Уведомление
 * удаляется, прежнее меню тоже, а меню или карточка заявки приходят новым
 * сообщением внизу чата: сколько бы уведомлений ни пришло, кнопки — под рукой
 * (решение 27.09.2026). Не удалось удалить — не беда, ответ всё равно придёт.
 */
async function closeNotification(target: SendTarget, userId: number | undefined, ticketId: number | null): Promise<void> {
  const scope = callbackScope.getStore();
  if (scope && !scope.answered) {
    // Отвечаем на нажатие сразу и без замены: заменять нечего — уведомление удаляем.
    scope.answered = true;
    const notification = ticketId === null ? 'Уведомление закрыто' : 'Открываю заявку';
    await api
      .answerCallback(scope.callbackId, { notification }, shutdown.signal)
      .catch((error: unknown) => {
        if (isAbort(error)) throw error;
        log.warn('ответ на нажатие не отправлен', { error: errorText(error) });
      });
  }
  if (scope?.pressedMid) {
    await api.deleteMessage(scope.pressedMid, shutdown.signal).catch((error: unknown) => {
      if (isAbort(error)) throw error;
      log.debug('уведомление не удалено', { error: errorText(error) });
    });
  }
  await dropLiveMessage(target);
  if (ticketId !== null && Number.isSafeInteger(ticketId) && ticketId > 0) {
    await showTicket(target, userId, ticketId);
  } else {
    await showMenu(target, userId);
  }
}

/** Нажатие inline-кнопки. Сначала отвечаем на нажатие, потом делаем дело. */
async function handleCallback(target: SendTarget, update: MaxUpdate): Promise<void> {
  const callback = update.callback;
  if (!callback) return;

  const userId = callback.user?.user_id;

  const payload = callback.payload ?? '';
  const scope: CallbackScope = {
    callbackId: callback.callback_id,
    notification: null,
    answered: false,
    pressedMid: update.message?.body?.mid ?? null,
  };

  await callbackScope.run(scope, async () => {
    try {
      // Кнопки под инструкцией при аварии и под номером аварийной заявки: само
      // сообщение остаётся — снимаем с него только кнопки, ответ — новым сообщением.
      const keep = payload.startsWith('danger_confirm:') || payload === Action.dismissDanger || payload === Action.gasCalled;
      const pressedText = update.message?.body?.text;
      if (keep) {
        scope.answered = true;
        await api
          .answerCallback(
            scope.callbackId,
            { notification: 'Принято', message: pressedText ? { text: pressedText, attachments: [] } : undefined },
            shutdown.signal,
          )
          .catch((error: unknown) => {
            if (isAbort(error)) throw error;
            log.warn('ответ на нажатие не отправлен', { error: errorText(error) });
          });
      }
      await dispatchCallback(target, userId, payload);
    } finally {
      // Ничего не ответили (например, api недоступен и упало раньше) — хотя бы уведомление.
      if (!scope.answered) {
        scope.answered = true;
        await api
          .answerCallback(scope.callbackId, { notification: scope.notification ?? 'Готово' }, shutdown.signal)
          .catch((error: unknown) => log.warn('ответ на нажатие не отправлен', { error: errorText(error) }));
      }
    }
  });
}

/** Что делает кнопка. answer — текст короткого уведомления на нажатие. */
async function dispatchCallback(target: SendTarget, userId: number | undefined, payload: string): Promise<void> {
  const answer = async (notification: string): Promise<void> => {
    const scope = callbackScope.getStore();
    if (scope) scope.notification = notification;
  };

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

  if (payload.startsWith('tc:')) {
    await answer('Принято');
    await handleCancelButton(target, userId, payload);
    return;
  }

  // Кнопки уведомления о смене статуса: nt:open:<id> / nt:ok:<id>.
  if (prefix === 'nt') {
    await closeNotification(target, userId, type === 'open' ? Number(payload.split(':')[2]) : null);
    return;
  }

  // Выбор дома — «Чат дома» (hc:<id>) и аварийная заявка (eh:<id>), кейс 10.
  if (prefix === 'hc' && type) {
    await answer('Чат дома');
    await handleHouseChat(target, userId, Number(type));
    return;
  }
  if (prefix === 'eh' && type && type !== 'cancel') {
    await answer('Принято');
    const pending = userId === undefined ? undefined : pendingEmergencyHouse.get(userId);
    if (userId === undefined || !pending) {
      await showMenu(target, userId, messages.draftExpired);
      return;
    }
    pendingEmergencyHouse.delete(userId);
    await registerEmergency(target, userId, pending.type, pending.description, Number(type));
    return;
  }

  if (
    /^(rh|type|clar|place|src|own|room|water|rooms):/.test(payload) ||
    payload === Action.skipDescription ||
    payload === Action.sendTicket ||
    payload === Action.cancelTicket ||
    payload === Action.back
  ) {
    await answer(payload === Action.cancelTicket ? 'Отменено' : 'Принято');
    try {
      await handleTicketButton(target, userId, payload);
    } finally {
      // Нажатие не привело к новому шагу (повтор вопроса, выход из заявки) —
      // запомненное «до» не должно попасть в историю следующего шага.
      stepBefore = null;
    }
    return;
  }

  switch (payload) {
    case Action.report: {
      await answer('Сообщить о проблеме');
      await startReport(target, userId);
      return;
    }

    case Action.service: {
      await answer('Заказать услугу');
      await startReport(target, userId, { service: true });
      return;
    }

    case Action.resumeDraft: {
      await answer('Продолжаем');
      const draft = userId === undefined ? undefined : reportDraft.get(userId);
      if (userId === undefined || !draft) {
        await startReport(target, userId);
        return;
      }
      reportDraft.set(userId, draft);
      await askStep(target, draft);
      return;
    }

    case Action.restartDraft: {
      await answer('Начинаем заново');
      if (userId !== undefined) reportDraft.delete(userId);
      await startReport(target, userId, { resume: false });
      return;
    }

    case Action.menu: {
      await answer('Меню');
      await showMenu(target, userId);
      return;
    }

    case Action.tickets: {
      await answer('Мои заявки');
      await showTickets(target, userId);
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
          draft.description = cutText(text, DESCRIPTION_LIMIT).text;
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

    case Action.cancelEmergencyHouse: {
      await answer('Отменено');
      if (userId !== undefined) pendingEmergencyHouse.delete(userId);
      await showMenu(target, userId, messages.emergencyHouseCancelled);
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
      log.debug('неизвестная кнопка', { payload });
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
      // Житель ответил — прежний вопрос бота с кнопками больше не нужен.
      await dropLiveMessage(target);

      const contact = findContact(update.message);
      if (contact) {
        await handleContact(target, sender?.user_id, contact);
        return;
      }

      const text = update.message?.body?.text?.trim();

      if (!text) {
        await handleNonText(target, sender?.user_id);
        return;
      }

      if (text.startsWith('/start')) {
        log.info('команда /start', { target });
        await handleStart(target, sender?.user_id);
        return;
      }

      const withMedia = (update.message?.body?.attachments ?? []).some((a) => a.type !== 'contact');
      await handleText(target, sender?.user_id, text, withMedia);
      return;
    }

    default: {
      log.debug('тип события не обрабатывается', { update_type: update.update_type });
    }
  }
}

// ── уведомления о смене статуса ───────────────────────────────────────────

/**
 * Петля «смена статуса → уведомление жителю»: раз в несколько секунд забираем
 * у api недоставленные уведомления, пишем жителю и отмечаем доставленным.
 *
 * Сначала отправка, потом отметка: сбой между ними даст повтор сообщения, а не
 * потерю — «решена» дважды лучше, чем ни разу. Ошибка MAX 4xx (кроме 429) —
 * написать этому жителю нельзя (например, бот заблокирован): отмечаем, иначе
 * бот ретраил бы его вечно. Сеть, 5xx, 429 — оставляем в очереди до следующего раза.
 */
async function notifyLoop(): Promise<void> {
  while (running) {
    try {
      const pending = await apiClient.pendingNotifications(shutdown.signal);
      for (const n of pending) {
        if (!running) break;
        try {
          // Уведомление не «живое»: нажатие в меню его не заменит. Свои кнопки
          // «Подробнее» / «Понятно» закрывают его и присылают ответ вниз чата.
          await send({ chatId: n.max_chat_id }, messages.statusChanged(n), notificationKeyboard(n.ticket_id), {
            persistent: true,
          });
          log.info('уведомление о статусе отправлено', { ticket_id: n.ticket_id, status: n.new_status });
        } catch (error) {
          if (isAbort(error)) throw error;
          const undeliverable =
            error instanceof MaxApiError && error.status >= 400 && error.status < 500 && error.status !== 429;
          if (!undeliverable) throw error;
          log.warn('уведомление не доставить — снимаем с очереди', {
            ticket_id: n.ticket_id,
            status: (error as MaxApiError).status,
          });
        }
        await apiClient.markDelivered(n.event_id, shutdown.signal);
      }
    } catch (error) {
      if (isAbort(error) || !running) break;
      log.warn('очередь уведомлений не обработана — повтор позже', { error: errorText(error) });
    }
    await sleep(config.notifyIntervalMs);
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

  // Два независимых цикла: приём сообщений и доставка уведомлений о статусе.
  // Уведомления не ждут long poll (до 90 с) и не мешают ему.
  // Приём закончился (остановка или отозванный токен) — гасим и доставку,
  // иначе процесс не завершится.
  await Promise.all([
    pollLoop().finally(() => {
      running = false;
      shutdown.abort();
    }),
    notifyLoop(),
  ]);
  log.info('бот остановлен');
}
