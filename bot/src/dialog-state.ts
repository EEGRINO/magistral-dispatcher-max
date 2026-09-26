/**
 * Временные состояния диалога — в памяти бота, без таблицы в БД (решения
 * 24.09.2026, подтверждено 26.09.2026 для кейса 15 чек-листа). Перезапуск бота
 * их стирает сознательно: житель просто повторит шаг — введёт адрес заново,
 * ещё раз отсканирует QR или начнёт заявку сначала.
 *
 * Ключ — user_id пользователя MAX: он один и тот же во всех событиях
 * (sender у сообщения, user у bot_started и у нажатия кнопки).
 */

import type { DangerType } from './emergency.js';
import type { ReportDraft } from './report.js';

class ExpiringMap<V> {
  private readonly items = new Map<number, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  /** Каждая запись заново отсчитывает таймаут — он считается от последнего действия. */
  set(key: number, value: V): void {
    this.prune();
    this.items.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get(key: number): V | undefined {
    const entry = this.items.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key: number): void {
    this.items.delete(key);
  }

  /** Без чистки записи тех, кто ушёл и не вернулся, копились бы вечно. */
  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.items) {
      if (entry.expiresAt <= now) this.items.delete(key);
    }
  }
}

/** «Ждём адрес дома»: user_id → id жителя. Таймаут — 15 минут бездействия. */
export const awaitingAddress = new ExpiringMap<number>(15 * 60 * 1000);

/**
 * Код дома из QR, пришедший ДО входа: user_id → invite_code. Применяется сразу
 * после входа по контакту. Час — с запасом на то, чтобы найти кнопку и
 * поделиться контактом; дольше держать незачем.
 */
export const pendingInvite = new ExpiringMap<string>(60 * 60 * 1000);

/**
 * Недавние аварийные заявки: user_id → номер заявки по типу опасности. Житель в
 * панике жмёт кнопку и пишет «газ!» несколько раз — вторая заявка диспетчеру
 * не нужна, достаточно напомнить номер первой. 30 минут.
 */
export const recentEmergency = new ExpiringMap<Partial<Record<DangerType, number>>>(30 * 60 * 1000);

/**
 * Текст, в котором бот заподозрил опасность, до нажатия «Да, это авария»:
 * user_id → текст. Уйдёт в описание аварийной заявки. 15 минут.
 */
export const pendingDangerText = new ExpiringMap<string>(15 * 60 * 1000);

/**
 * Аварийная заявка ждёт выбора дома: user_id → тип и описание. Только у жителя
 * с квартирами в нескольких домах (кейс 10 чек-листа). 15 минут.
 */
export const pendingEmergencyHouse = new ExpiringMap<{ type: DangerType; description: string | null }>(
  15 * 60 * 1000,
);

/**
 * «Живое» сообщение бота в диалоге — меню или вопрос с кнопками: chat_id → mid.
 * Нажатие кнопки меняет его на месте; ответ текстом — бот удаляет его и пишет
 * новый вопрос (решение 26.09.2026). Номера заявок, инструкции при аварии и
 * уведомления сюда не попадают — их бот не трогает. Сутки — дольше незачем.
 */
export const liveMessage = new ExpiringMap<string>(24 * 60 * 60 * 1000);

/**
 * Черновик обычной заявки: user_id → черновик. Сутки бездействия — забыт.
 * Житель, бросивший заявку на середине, может вернуться и продолжить с того же
 * шага (кейс 7 чек-листа, решение 26.09.2026; раньше было 15 минут).
 */
export const reportDraft = new ExpiringMap<ReportDraft>(24 * 60 * 60 * 1000);

/**
 * Только что отправленная заявка: user_id → её номер. Второе быстрое нажатие
 * «Отправить» (кейс N04 чек-листа) получает «заявка №N уже отправлена», а не
 * «черновик устарел». Минута — двойное нажатие быстрее.
 */
export const recentSubmit = new ExpiringMap<number>(60 * 1000);
