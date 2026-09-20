/**
 * Тонкий клиент MAX Bot API поверх нативного fetch (Node 22).
 *
 * Почему не SDK: после миграции июля 2026 сторонние обёртки ходят в мёртвый
 * platform-api.max.ru и передают токен query-параметром, который теперь даёт 401.
 * Здесь ровно два метода, которые нужны MVP. См. docs/max-notes.md.
 */
import { config } from './config.js';

// ── Формы данных MAX ────────────────────────────────────────────────────────

export interface MaxUser {
  user_id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

export interface MaxRecipient {
  chat_id?: number;
  chat_type?: string;
  user_id?: number;
}

export interface MaxMessageBody {
  mid: string;
  seq: number;
  text?: string;
}

export interface MaxMessage {
  sender?: MaxUser;
  recipient?: MaxRecipient;
  body?: MaxMessageBody;
  timestamp?: number;
}

/**
 * Поля адресата у bot_started в доке описаны нечётко, поэтому допускаем
 * несколько вариантов и разбираем их в resolveTarget(). Индексная сигнатура
 * нужна, чтобы неизвестные типы событий не ломали разбор.
 */
export interface MaxUpdate {
  update_type: string;
  timestamp?: number;
  message?: MaxMessage;
  user?: MaxUser;
  user_id?: number;
  chat_id?: number;
  payload?: string;
  [key: string]: unknown;
}

export interface UpdatesResponse {
  updates?: MaxUpdate[];
  marker?: number | null;
}

/** Куда отвечать: chat_id для чата, user_id для лички. */
export interface SendTarget {
  chatId?: number;
  userId?: number;
}

export class MaxApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'MaxApiError';
  }

  /** 401 означает битый или отозванный токен — ретраить бессмысленно. */
  get isFatal(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Лимит длины текста сообщения в MAX. */
const MAX_TEXT_LENGTH = 4000;

export class MaxApi {
  constructor(
    private readonly baseUrl: string = config.baseUrl,
    private readonly token: string = config.token,
  ) {}

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string | number | undefined>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      // Именно так: без префикса Bearer. Токен в query-параметре вернёт 401.
      Authorization: this.token,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new MaxApiError(
        response.status,
        raw,
        `${method} ${path} → HTTP ${response.status}: ${raw.slice(0, 300)}`,
      );
    }

    return (raw ? JSON.parse(raw) : {}) as T;
  }

  /**
   * Long polling. marker === null на первом запросе: так MAX отдаёт только
   * свежие события, а не весь накопившийся бэклог.
   */
  async getUpdates(marker: number | null, signal?: AbortSignal): Promise<UpdatesResponse> {
    return this.request<UpdatesResponse>(
      'GET',
      '/updates',
      {
        limit: 100,
        timeout: config.pollTimeoutSec,
        marker: marker ?? undefined,
      },
      undefined,
      signal,
    );
  }

  /** Адресат задаётся query-параметром, текст — телом запроса. */
  async sendMessage(target: SendTarget, text: string, signal?: AbortSignal): Promise<void> {
    const trimmed = text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;

    await this.request<unknown>(
      'POST',
      '/messages',
      { chat_id: target.chatId, user_id: target.userId },
      { text: trimmed, notify: true },
      signal,
    );
  }
}
