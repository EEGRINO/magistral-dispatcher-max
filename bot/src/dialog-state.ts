/**
 * Временные состояния диалога — в памяти бота, без таблицы в БД (решения
 * 24.09.2026). Перезапуск бота их стирает сознательно: житель просто повторит
 * шаг — введёт адрес заново или ещё раз отсканирует QR.
 *
 * Ключ — user_id пользователя MAX: он один и тот же во всех событиях
 * (sender у сообщения, user у bot_started и у нажатия кнопки).
 */

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
