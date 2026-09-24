/**
 * Логика бота: цикл long polling + вход жителя по контакту.
 *
 * Сценарий согласован 24.09.2026 (docs/Решения_проекта.md):
 *   - не вошёл → кнопка «Поделиться контактом»;
 *   - прислал контакт → проверка подписи MAX → привязка к жителю, заведённому УК;
 *   - вошёл → пока эхо; меню («Чат дома», «Отправить заявку») — следующий шаг.
 * Отдельного состояния «ждём номер» нет: контакт сам говорит, кто пришёл,
 * а «вошёл ли» видно по БД. Поэтому перезапуск бота ничего не теряет.
 *
 * Модуль импортируется динамически из index.ts, поэтому падение валидации
 * конфига долетает до обработчика как обычная ошибка, а не как стектрейс.
 */
import { ApiClient, ApiClientError } from './api-client.js';
import { findContact, requestContactKeyboard, verifyContact } from './auth.js';
import { config, messages } from './config.js';
import { log } from './logger.js';
import { MaxApi, MaxApiError, type MaxUpdate, type SendTarget } from './max-api.js';

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

/**
 * Куда отправлять ответ.
 *
 * У message_created адресат лежит в message.recipient.chat_id. У bot_started
 * форма в доке описана нечётко, поэтому перебираем известные варианты
 * сверху вниз. chat_id приоритетнее user_id: он работает и в личке, и в группе.
 */
function resolveTarget(update: MaxUpdate): SendTarget | null {
  const chatId = update.message?.recipient?.chat_id ?? update.chat_id;
  if (typeof chatId === 'number') return { chatId };

  const userId =
    update.message?.sender?.user_id ?? update.user?.user_id ?? update.user_id;
  if (typeof userId === 'number') return { userId };

  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function askContact(target: SendTarget): Promise<void> {
  return api.sendMessage(target, messages.askContact, shutdown.signal, requestContactKeyboard);
}

/**
 * /start и кнопка «Старт»: вошёл — приветствие, нет — кнопка контакта.
 *
 * Если api недоступен — говорим об этом, но НЕ молчим: «бот не отвечает» для
 * жителя хуже, чем «сервис временно недоступен».
 */
async function handleStart(target: SendTarget, userId: number | undefined): Promise<void> {
  if (userId === undefined) {
    log.warn('в событии нет user_id — просим контакт');
    await askContact(target);
    return;
  }

  let resident;
  try {
    resident = await apiClient.findByMaxUser(userId, shutdown.signal);
  } catch (error) {
    log.error('api недоступен при /start', { user_id: userId, error: errorText(error) });
    await api.sendMessage(target, messages.serviceUnavailable, shutdown.signal);
    return;
  }

  if (resident) {
    await api.sendMessage(target, messages.welcomeBack(resident.id), shutdown.signal);
  } else {
    await askContact(target);
  }
}

type Contact = NonNullable<ReturnType<typeof findContact>>;

async function handleContact(
  target: SendTarget,
  senderId: number | undefined,
  contact: Contact,
): Promise<void> {
  const check = verifyContact(contact, senderId, config.token);

  if (!check.ok) {
    // Номер в лог не пишем ни в каком виде: это персональные данные.
    log.warn('контакт не принят', { user_id: senderId, reason: check.reason });

    if (check.reason === 'unsupported_phone') {
      await api.sendMessage(target, messages.unsupportedPhone, shutdown.signal);
      return;
    }

    const text = check.reason === 'foreign_contact' ? messages.foreignContact : messages.badContact;
    await api.sendMessage(target, text, shutdown.signal, requestContactKeyboard);
    return;
  }

  // В личном диалоге chat_id есть всегда (docs/max-notes.md, message_created);
  // проверка — чтобы не записать в БД пустую привязку.
  if (senderId === undefined || target.chatId === undefined) {
    log.error('контакт без chat_id или user_id — привязать не к чему', { target });
    await api.sendMessage(target, messages.serviceUnavailable, shutdown.signal);
    return;
  }

  try {
    const result = await apiClient.linkByPhone(check.phone, target.chatId, senderId, shutdown.signal);

    if (result.kind === 'not_registered') {
      log.info('номер не найден у УК', { user_id: senderId });
      await api.sendMessage(target, messages.phoneNotRegistered, shutdown.signal);
      return;
    }

    log.info('житель вошёл', { resident_id: result.resident.id, user_id: senderId });
    await api.sendMessage(target, messages.loggedIn(result.resident.id), shutdown.signal);
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'conflict') {
      log.warn('аккаунт MAX уже привязан к другой квартире', { user_id: senderId });
      await api.sendMessage(target, messages.accountLinkedElsewhere, shutdown.signal);
      return;
    }

    log.error('api недоступен при входе', { user_id: senderId, error: errorText(error) });
    await api.sendMessage(target, messages.serviceUnavailable, shutdown.signal);
  }
}

/** Обычный текст: не вошёл — снова кнопка контакта; вошёл — пока эхо до появления меню. */
async function handleText(target: SendTarget, userId: number | undefined, text: string): Promise<void> {
  let resident = null;

  if (userId !== undefined) {
    try {
      resident = await apiClient.findByMaxUser(userId, shutdown.signal);
    } catch (error) {
      log.error('api недоступен при сообщении', { user_id: userId, error: errorText(error) });
      await api.sendMessage(target, messages.serviceUnavailable, shutdown.signal);
      return;
    }
  }

  if (!resident) {
    await askContact(target);
    return;
  }

  log.info('эхо', { target, length: text.length });
  await api.sendMessage(target, text, shutdown.signal);
}

async function handleUpdate(update: MaxUpdate): Promise<void> {
  const target = resolveTarget(update);

  if (!target) {
    // Не ошибка: часть событий (например, bot_removed) отвечать и не предполагает.
    log.debug('событие без адресата — пропускаем', { update_type: update.update_type });
    return;
  }

  switch (update.update_type) {
    // Нажата кнопка «Старт» в новом диалоге. Отдельное событие: message_created
    // при этом НЕ приходит, поэтому без этой ветки бот молчит на первом экране.
    case 'bot_started': {
      log.info('диалог начат', { target });
      // Форма по schema.yaml: user на верхнем уровне (docs/max-notes.md).
      // payload из диплинка (?start=код_дома) обработаем на шаге «чат дома».
      await handleStart(target, update.user?.user_id);
      return;
    }

    case 'message_created': {
      const sender = update.message?.sender;

      // Иначе два бота в одном чате уйдут в бесконечное эхо друг с другом.
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
        await api.sendMessage(target, messages.nonText, shutdown.signal);
        return;
      }

      // startsWith, а не ===: MAX умеет deep-link вида "/start ref=qr_подъезд3".
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

  await pollLoop();
  log.info('бот остановлен');
}
