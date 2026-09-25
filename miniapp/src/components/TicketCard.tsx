import { CellSimple } from '@maxhub/max-ui';
import type { Ticket } from '../types/domain';
import { TICKET_STATUS_LABEL, formatCreated, isEmergency, placeLabel, problemLabel } from '../types/domain';

interface TicketCardProps {
  ticket: Ticket;
  onOpen: () => void;
}

export function TicketCard({ ticket, onOpen }: TicketCardProps) {
  const overline = [`№ ${ticket.id}`, formatCreated(ticket.created_at), isEmergency(ticket.problem_type) ? 'экстренная' : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <CellSimple
      overline={overline}
      title={problemLabel(ticket.problem_type)}
      subtitle={ticket.description ?? placeLabel(ticket.place) ?? undefined}
      after={<StatusBadge status={ticket.status} />}
      onClick={onOpen}
    />
  );
}

export function StatusBadge({ status }: { status: Ticket['status'] }) {
  return <span className={`status status--${status}`}>{TICKET_STATUS_LABEL[status]}</span>;
}
