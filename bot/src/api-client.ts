/**
 * Клиент внутреннего api (сервис `api` в docker-compose).
 *
 * Отдельно от max-api.ts намеренно: это два разных внешних мира с разными
 * контрактами и разной политикой ошибок. MAX — чужой API, который мы
 * не контролируем; api — наш, и его контракт зафиксирован в docs/api.md.
 */
import { config } from './config.js';

export interface Resident {
  id: number;
  house_id: number | null;
  max_chat_id: number | null;
  max_user_id: number | null;
  created_at: string;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number | null,
    /** Код из конверта ошибки api (docs/api.md) — по нему и ветвимся. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/** Итог привязки: либо житель, либо «такого номера у УК нет». */
export type LinkResult =
  | { kind: 'linked'; resident: Resident }
  | { kind: 'not_registered' };

export class ApiClient {
  constructor(
    private readonly baseUrl: string = config.apiBaseUrl,
    private readonly timeoutMs: number = config.apiTimeoutMs,
  ) {}

  /**
   * Свой таймаут поверх внешнего сигнала: без него зависший api подвесил бы
   * обработку события, а следом и весь цикл long polling — бот перестал бы
   * отвечать вообще всем, а не только этому человеку.
   */
  private signalWithTimeout(external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: body === undefined
          ? { Accept: 'application/json' }
          : { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.signalWithTimeout(signal),
      });
    } catch (error) {
      // Сеть/таймаут/недоступный хост — статуса нет.
      throw new ApiClientError(null, null, error instanceof Error ? error.message : String(error));
    }

    const raw = await response.text();
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ApiClientError(response.status, null, `Ответ api не является JSON: ${raw.slice(0, 200)}`);
    }

    if (!response.ok) {
      const code = (parsed as { error?: { code?: unknown } }).error?.code;
      throw new ApiClientError(
        response.status,
        typeof code === 'string' ? code : null,
        `${method} ${path} → ${response.status}: ${raw.slice(0, 200)}`,
      );
    }

    return parsed;
  }

  /** Контракт мог измениться — лучше упасть здесь с внятным текстом, чем дальше по коду. */
  private static readResident(parsed: unknown, path: string): Resident {
    const resident = (parsed as { resident?: Resident }).resident;
    if (typeof resident?.id !== 'number') {
      throw new ApiClientError(200, null, `В ответе ${path} нет resident.id`);
    }
    return resident;
  }

  /** Привязать диалог и пользователя MAX к жителю по подтверждённому номеру. */
  async linkByPhone(
    phone: string,
    maxChatId: number,
    maxUserId: number,
    signal?: AbortSignal,
  ): Promise<LinkResult> {
    const path = '/residents/link-by-phone';

    try {
      const parsed = await this.request(
        'POST',
        path,
        { phone, max_chat_id: maxChatId, max_user_id: maxUserId },
        signal,
      );
      return { kind: 'linked', resident: ApiClient.readResident(parsed, path) };
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'phone_not_registered') {
        return { kind: 'not_registered' };
      }
      throw error;
    }
  }

  /** Житель, к которому уже привязан этот пользователь MAX; null — ещё не входил. */
  async findByMaxUser(maxUserId: number, signal?: AbortSignal): Promise<Resident | null> {
    const path = `/residents/by-max-user/${maxUserId}`;

    try {
      return ApiClient.readResident(await this.request('GET', path, undefined, signal), path);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404 && error.code === 'not_found') {
        return null;
      }
      throw error;
    }
  }
}
