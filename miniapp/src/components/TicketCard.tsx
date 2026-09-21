import { CellSimple } from '@maxhub/max-ui';
import type { Ticket } from '../types/domain';
import { TICKET_STATUS_LABEL, TICKET_TYPE_LABEL } from '../types/domain';

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });

interface TicketCardProps {
  ticket: Ticket;
}

export function TicketCard({ ticket }: TicketCardProps) {
  return (
    <CellSimple
      overline={`№ ${ticket.id} · ${dateFormat.format(new Date(ticket.createdAt))} · ${ticket.address}`}
      title={TICKET_TYPE_LABEL[ticket.type]}
      subtitle={ticket.description}
      after={
        <span className={`status status--${ticket.status}`}>
          {TICKET_STATUS_LABEL[ticket.status]}
        </span>
      }
    />
  );
}
