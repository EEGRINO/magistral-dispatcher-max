import type { ReactNode } from 'react';
import { Button, CellList, CellSimple, Container, Panel, Typography } from '@maxhub/max-ui';
import { StatusBadge } from '../components/TicketCard';
import type { Ticket } from '../types/domain';
import { formatCreated, isEmergency, placeLabel, problemLabel } from '../types/domain';

/** «Осталось»: часы до двух суток, дальше — сутки (как у бота). */
function timeLeft(deadlineIso: string): string {
  const hours = Math.ceil((Date.parse(deadlineIso) - Date.now()) / 3_600_000);
  if (hours <= 0) return 'срок истёк';
  return hours < 48 ? `${hours} ч` : `${Math.floor(hours / 24)} дн.`;
}

interface TicketScreenProps {
  ticket: Ticket;
  onBack: () => void;
}

/** Подробности заявки — те же строки, что бот отвечает на «статус N». */
export function TicketScreen({ ticket, onBack }: TicketScreenProps) {
  const rows: [string, ReactNode][] = [['Статус', <StatusBadge status={ticket.status} />]];

  if (isEmergency(ticket.problem_type)) rows.push(['Приоритет', 'экстренная']);
  if (ticket.responsible_name) rows.push(['Ответственный', ticket.responsible_name]);
  // Срок — только сверенный с первоисточником, у решённой уже не важен (решение 24.09.2026).
  if (ticket.deadline_verified && ticket.deadline_at && ticket.status !== 'resolved') {
    rows.push(['Осталось по нормативному сроку', timeLeft(ticket.deadline_at)]);
  }
  rows.push(['Что', problemLabel(ticket.problem_type)]);
  const place = placeLabel(ticket.place);
  if (place) rows.push(['Где', place]);
  rows.push(['Подана', formatCreated(ticket.created_at)]);
  if (ticket.description) rows.push(['Описание', ticket.description]);

  return (
    <Panel mode="secondary" className="page">
      <div className="page__body">
        <Container>
          <Typography.Title>Заявка № {ticket.id}</Typography.Title>
        </Container>
        <CellList mode="island">
          {rows.map(([label, value]) => (
            <CellSimple key={label} overline={label} title={value} />
          ))}
        </CellList>
      </div>

      <div className="page__footer">
        <Button variant="secondary" size="large" stretched onClick={onBack}>
          Назад к заявкам
        </Button>
      </div>
    </Panel>
  );
}
