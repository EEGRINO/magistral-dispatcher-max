/**
 * Логика бота: цикл long polling + обработка /start и эха.
 *
 * Сегодняшняя задача узкая и намеренно такая: доказать, что бот РЕАЛЬНО отвечает
 * в MAX. FSM-сценарий жителя не трогаем — он согласуется с разработчиком отдельно
 * (см. CLAUDE.md, раздел про FSM и схему БД).
 *
 * Модуль импортируется динамически из index.ts, поэтому падение валидации
 * конфига долетает до обработчика как обычная ошибка, а не как стектрейс.
 */
import { ApiClient } from './api-client.js';
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

/**
 * Приветствие с подтверждением, что житель дошёл до БД.
 *
 * Временная проверочная логика для КТ-1: она доказывает, что цепочка
 * MAX → бот → api → БД → ответ работает целиком. Полноценный сценарий
 * диалога появится на Д-7 и это место заменит.
 *
 * Если api недоступен — здороваемся без ID, но НЕ молчим: «бот не отвечает»
 * для жителя гораздо хуже, чем «бот ответил без номера».
 */
async function buildGreeting(target: SendTarget): Promise<string> {
  // chat_id диалога — ключ связки с жителем. user_id как запасной вариант:
  // у события без chat_id других опознавательных знаков не остаётся.
  const maxChatId = target.chatId ?? target.userId;

  if (maxChatId === undefined) {
    log.warn('не удалось определить max_chat_id — приветствие без ID');
    return messages.greeting;
  }

  try {
    const resident = await apiClient.findOrCreateResident(maxChatId, shutdown.signal);
    log.info('житель сохранён', { resident_id: resident.id, max_chat_id: maxChatId });
    return messages.greetingWithId(resident.id);
  } catch (error) {
    log.error('api недоступен — приветствие без ID', {
      max_chat_id: maxChatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return messages.greeting;
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
    // Нажата кнопка «Старт» в новом диалоге. Отдельное событие: message_created
    // при этом НЕ приходит, поэтому без этой ветки бот молчит на первом экране.
    case 'bot_started': {
      log.info('диалог начат', { target });
      // Точная форма bot_started в доке описана нечётко (см. docs/max-notes.md).
      // При LOG_LEVEL=debug видно сырое событие — полезно, если resolveTarget
      // вдруг перестанет находить адресата после изменений в API.
      log.debug('bot_started raw', { update });
      await api.sendMessage(target, await buildGreeting(target), shutdown.signal);
      return;
    }

    case 'message_created': {
      const sender = update.message?.sender;

      // Иначе два бота в одном чате уйдут в бесконечное эхо друг с другом.
      if (sender?.is_bot) {
        log.debug('сообщение от бота — игнорируем', { user_id: sender.user_id });
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
        await api.sendMessage(target, await buildGreeting(target), shutdown.signal);
        return;
      }

      log.info('эхо', { target, length: text.length });
      await api.sendMessage(target, text, shutdown.signal);
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
