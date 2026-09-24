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

export interface House {
  id: number;
  address: string;
  chat_link: string | null;
  /** Телефон АДС дома; null — называем 112. */
  emergency_phone: string | null;
  has_gas: boolean;
  uk_name: string | null;
}

/** Заявка — только поля, которые нужны боту. Полный объект — docs/api.md. */
export interface Ticket {
  id: number;
  resident_id: number;
  problem_type: string;
  place: string | null;
  description: string | null;
  /** Правило config/rules.yaml, по которому api направил заявку. */
  rule_id: string | null;
  /** Кто отвечает — название организации или службы; null — назначить некого. */
  responsible_name: string | null;
  /** Нормативный срок, ISO 8601; null — в правиле нет числа. */
  deadline_at: string | null;
  /** Срок сверен с первоисточником — только тогда его можно показать жителю. */
  deadline_verified: boolean;
  status: 'new' | 'in_progress' | 'resolved';
  created_at: string;
}

export interface NewTicket {
  problemType: string;
  place?: string | null;
  description?: string | null;
  /** Ответ на уточнение — по нему api выбирает правило маршрутизации. */
  detailCode?: string | null;
}

/** Итог привязки: либо житель, либо «такого номера у УК нет». */
export type LinkResult =
  | { kind: 'linked'; resident: Resident }
  | { kind: 'not_registered' };

export type InviteResult =
  | { kind: 'ok'; house: House; mismatch: boolean }
  | { kind: 'unknown_code' };

export type AddressResult =
  | { kind: 'ok'; house: House }
  | { kind: 'not_found' }
  | { kind: 'unrecognized' };

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

  private static readHouse(parsed: unknown, path: string): House {
    const house = (parsed as { house?: House }).house;
    if (typeof house?.id !== 'number') {
      throw new ApiClientError(200, null, `В ответе ${path} нет house.id`);
    }
    return house;
  }

  /** Дом жителя; null — дом ещё неизвестен. */
  async getHouse(residentId: number, signal?: AbortSignal): Promise<House | null> {
    const path = `/residents/${residentId}/house`;
    const parsed = await this.request('GET', path, undefined, signal);
    return (parsed as { house?: House | null }).house === null ? null : ApiClient.readHouse(parsed, path);
  }

  /** Дом по коду из QR; дом жителя заполняется, только если был неизвестен. */
  async assignHouseByInvite(residentId: number, inviteCode: string, signal?: AbortSignal): Promise<InviteResult> {
    const path = `/residents/${residentId}/house-by-invite`;
    try {
      const parsed = await this.request('POST', path, { invite_code: inviteCode }, signal);
      const mismatch = (parsed as { mismatch?: unknown }).mismatch === true;
      return { kind: 'ok', house: ApiClient.readHouse(parsed, path), mismatch };
    } catch (error) {
      // validation_error — код в QR битый (не того формата): для жителя это то же
      // самое, что неизвестный код.
      if (error instanceof ApiClientError && (error.code === 'house_not_found' || error.code === 'validation_error')) {
        return { kind: 'unknown_code' };
      }
      throw error;
    }
  }

  /** Дом по адресу, введённому жителем; разбирает адрес api (src/address.ts). */
  async assignHouseByAddress(residentId: number, address: string, signal?: AbortSignal): Promise<AddressResult> {
    const path = `/residents/${residentId}/house-by-address`;
    try {
      const parsed = await this.request('POST', path, { address }, signal);
      return { kind: 'ok', house: ApiClient.readHouse(parsed, path) };
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'house_not_found') return { kind: 'not_found' };
      // validation_error — например, текст длиннее 200 символов: для жителя это
      // тоже «не понял адрес».
      if (
        error instanceof ApiClientError &&
        (error.code === 'address_unrecognized' || error.code === 'validation_error')
      ) {
        return { kind: 'unrecognized' };
      }
      throw error;
    }
  }

  /** Завести заявку от имени жителя; номер заявки — ticket.id. */
  async createTicket(residentId: number, ticket: NewTicket, signal?: AbortSignal): Promise<Ticket> {
    const path = '/tickets';
    const parsed = await this.request(
      'POST',
      path,
      {
        resident_id: residentId,
        problem_type: ticket.problemType,
        place: ticket.place ?? null,
        description: ticket.description ?? null,
        detail_code: ticket.detailCode ?? null,
      },
      signal,
    );
    const created = (parsed as { ticket?: Ticket }).ticket;
    if (typeof created?.id !== 'number') {
      throw new ApiClientError(201, null, `В ответе ${path} нет ticket.id`);
    }
    return created;
  }

  /** Заявки жителя, новые сверху; activeOnly — только незакрытые. */
  async listTickets(residentId: number, activeOnly: boolean, signal?: AbortSignal): Promise<Ticket[]> {
    const path = `/residents/${residentId}/tickets${activeOnly ? '?active=true' : ''}`;
    const tickets = (await this.request('GET', path, undefined, signal) as { tickets?: Ticket[] }).tickets;
    if (!Array.isArray(tickets)) {
      throw new ApiClientError(200, null, `В ответе ${path} нет tickets`);
    }
    return tickets;
  }

  /** Заявка по номеру; null — такой нет. Чья она — проверяет вызывающий. */
  async getTicket(ticketId: number, signal?: AbortSignal): Promise<Ticket | null> {
    const path = `/tickets/${ticketId}`;
    try {
      const ticket = (await this.request('GET', path, undefined, signal) as { ticket?: Ticket }).ticket;
      if (typeof ticket?.id !== 'number') {
        throw new ApiClientError(200, null, `В ответе ${path} нет ticket.id`);
      }
      return ticket;
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404 && error.code === 'not_found') return null;
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
