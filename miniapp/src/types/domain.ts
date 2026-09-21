/** Договор — он же объект обслуживания: номер из квитанции задаёт адрес квартиры. */
export interface Contract {
  id: string;
  street: string;
  house: string;
  block?: string;
  flat: string;
}

export type TicketType = 'pipe' | 'electricity' | 'heating' | 'internet' | 'other';

export type TicketStatus = 'review' | 'work' | 'done';

export interface Ticket {
  id: number;
  contractId: string;
  /** Адрес на момент подачи: заявка остаётся читаемой, даже если договор изменят. */
  address: string;
  type: TicketType;
  description: string;
  createdAt: string;
  status: TicketStatus;
}

export interface CreateTicketInput {
  contractNumber: string;
  type: TicketType;
  description: string;
}

export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  pipe: 'Прорыв трубы',
  electricity: 'Электричество',
  heating: 'Отопление',
  internet: 'Интернет',
  other: 'Другое',
};

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  review: 'В рассмотрении',
  work: 'В работе',
  done: 'Решено',
};

export const TICKET_TYPES: TicketType[] = ['pipe', 'electricity', 'heating', 'internet', 'other'];

export function formatAddress(contract: Contract): string {
  const parts = [`ул. ${contract.street}`, `д. ${contract.house}`];

  if (contract.block) {
    parts.push(`корп. ${contract.block}`);
  }

  parts.push(`кв. ${contract.flat}`);
  return parts.join(', ');
}
