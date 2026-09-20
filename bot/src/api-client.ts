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
  max_chat_id: number;
  house_id: number | null;
  created_at: string;
}

interface FindOrCreateResponse {
  resident: Resident;
  created: boolean;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

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

  async findOrCreateResident(maxChatId: number, signal?: AbortSignal): Promise<Resident> {
    const url = `${this.baseUrl}/residents/find-or-create`;

    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ max_chat_id: maxChatId }),
        signal: this.signalWithTimeout(signal),
      });
    } catch (error) {
      // Сеть/таймаут/недоступный хост — статуса нет.
      throw new ApiClientError(null, error instanceof Error ? error.message : String(error));
    }

    const raw = await response.text();

    if (!response.ok) {
      throw new ApiClientError(response.status, `POST ${url} → ${response.status}: ${raw.slice(0, 200)}`);
    }

    let parsed: FindOrCreateResponse;

    try {
      parsed = JSON.parse(raw) as FindOrCreateResponse;
    } catch {
      throw new ApiClientError(response.status, `Ответ api не является JSON: ${raw.slice(0, 200)}`);
    }

    // Контракт мог измениться — лучше упасть здесь с внятным текстом,
    // чем отправить жителю "Ваш ID: undefined".
    if (typeof parsed.resident?.id !== 'number') {
      throw new ApiClientError(response.status, `В ответе api нет resident.id: ${raw.slice(0, 200)}`);
    }

    return parsed.resident;
  }
}
