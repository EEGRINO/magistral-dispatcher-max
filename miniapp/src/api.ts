/**
 * Клиент api мини-приложения — маршруты /app/* (docs/api.md, «Мини-приложение»).
 * Тот же домен, что и мини-апп: nginx отдаёт /api/app/* в api, CORS не нужен.
 *
 * Кто спрашивает, api узнаёт по подписанному initData MAX — он уходит в
 * заголовке X-Max-Init-Data. id жителя мини-апп не знает и не передаёт.
 */
import type { TicketDraft } from './scenario';
import type { House, Ticket } from './types/domain';

const BASE = '/api/app';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Код из конверта ошибки api: init_data_invalid, not_linked… network — нет связи. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Открыто внутри MAX кнопкой бота — есть подписанные данные запуска. */
export const hasInitData = (): boolean => Boolean(window.WebApp?.initData);

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'X-Max-Init-Data': window.WebApp?.initData ?? '',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Нет связи с сервером');
  }

  const json = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    throw new ApiError(response.status, json?.error?.code ?? null, json?.error?.message ?? `Ошибка ${response.status}`);
  }
  return json as T;
}

/** Дом жителя: адрес, чат, телефон АДС, газ, УК; null — дом неизвестен. */
export async function loadHouse(): Promise<House | null> {
  return (await call<{ house: House | null }>('GET', '/me')).house;
}

/** Мои заявки, новые сверху. */
export async function loadTickets(): Promise<Ticket[]> {
  return (await call<{ tickets: Ticket[] }>('GET', '/tickets')).tickets;
}

/** Отменить свою заявку — только «принятую» (иначе ApiError с кодом not_cancellable). */
export async function cancelTicket(id: number): Promise<Ticket> {
  return (await call<{ ticket: Ticket }>('POST', `/tickets/${id}/cancel`)).ticket;
}

/** Подать заявку — api маршрутизирует её так же, как заявку из бота. */
export async function createTicket(draft: TicketDraft): Promise<Ticket> {
  return (await call<{ ticket: Ticket }>('POST', '/tickets', draft)).ticket;
}
