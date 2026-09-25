import { Button, CellHeader, CellList, Container, Panel, Typography } from '@maxhub/max-ui';
import { TicketCard } from '../components/TicketCard';
import type { House, Ticket } from '../types/domain';

interface TicketsScreenProps {
  tickets: Ticket[];
  house: House | null;
  onOpenTicket: (id: number) => void;
  onReport: () => void;
  onHouseChat: () => void;
}

export function TicketsScreen({ tickets, house, onOpenTicket, onReport, onHouseChat }: TicketsScreenProps) {
  const active = tickets.filter((ticket) => ticket.status !== 'resolved');
  const resolved = tickets.filter((ticket) => ticket.status === 'resolved');

  const section = (title: string, list: Ticket[]) =>
    list.length > 0 && (
      <div className="section">
        <CellHeader>{title}</CellHeader>
        <CellList mode="island">
          {list.map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} onOpen={() => onOpenTicket(ticket.id)} />
          ))}
        </CellList>
      </div>
    );

  return (
    <Panel mode="secondary" className="page">
      <div className="page__body">
        <Container>
          <Typography.Title>Мои заявки</Typography.Title>
          <Typography.Body className="muted">{house?.address ?? 'Дом не указан — УК уточнит'}</Typography.Body>
        </Container>

        {tickets.length === 0 ? (
          <Container>
            <Typography.Body className="muted">
              У вас нет заявок. Чтобы создать новую — нажмите «Сообщить о проблеме».
            </Typography.Body>
          </Container>
        ) : (
          <>
            {section('Активные', active)}
            {section('Решённые', resolved)}
          </>
        )}
      </div>

      <div className="page__footer">
        <Button variant="primary" size="large" stretched onClick={onReport}>
          Сообщить о проблеме
        </Button>
        <Button variant="secondary" size="large" stretched onClick={onHouseChat}>
          Чат дома
        </Button>
      </div>
    </Panel>
  );
}
