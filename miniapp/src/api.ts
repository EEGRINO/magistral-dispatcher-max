import type { CreateTicketInput, Ticket } from './types/domain';
import { formatAddress } from './types/domain';
import { KNOWN_CONTRACTS, MOCK_TICKETS } from './mocks/data';

/**
 * Типизированный клиент API.
 *
 * Сигнатуры функций — это и есть контракт с бэкендом: когда он появится,
 * меняются только тела, экраны не трогаем. Сеть в проекте должна появляться
 * только здесь.
 *
 * Кто именно спрашивает — бэкенд определит по initData из MAX Bridge,
 * передавать идентификатор жителя с фронта не нужно.
 */

let tickets: Ticket[] = [...MOCK_TICKETS];
let nextTicketId = 102;

export class ApiError extends Error {}

/** Все заявки жителя — по всем его квартирам. */
export async function fetchTickets(): Promise<Ticket[]> {
  // TODO: GET /api/tickets
  return tickets;
}

export async function createTicket(input: CreateTicketInput): Promise<Ticket> {
  // TODO: POST /api/tickets
  const number = input.contractNumber.trim();
  const contract = KNOWN_CONTRACTS.find((known) => known.id === number);

  if (!contract) {
    throw new ApiError('Договор не найден. Проверьте номер в квитанции');
  }

  const ticket: Ticket = {
    id: nextTicketId,
    contractId: contract.id,
    address: formatAddress(contract),
    type: input.type,
    description: input.description,
    createdAt: new Date().toISOString(),
    status: 'review',
  };

  nextTicketId += 1;
  tickets = [ticket, ...tickets];
  return ticket;
}
