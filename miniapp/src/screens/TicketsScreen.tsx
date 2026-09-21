import { Button, CellList, Container, Panel, Typography } from '@maxhub/max-ui';
import { TicketCard } from '../components/TicketCard';
import type { LaunchInfo } from '../bridge';
import type { Ticket } from '../types/domain';

interface TicketsScreenProps {
  tickets: Ticket[];
  launch: LaunchInfo | null;
  onCreateTicket: () => void;
}

export function TicketsScreen({ tickets, launch, onCreateTicket }: TicketsScreenProps) {
  return (
    <Panel mode="secondary" className="page">
      <div className="page__body">
        <Container>
          <Typography.Title>Мои заявки</Typography.Title>
          <Typography.Body className="muted">
            {launch
              ? `Вход по аккаунту MAX${launch.userName ? `, ${launch.userName}` : ''}`
              : 'Открыто вне MAX — вход не подтверждён'}
          </Typography.Body>
        </Container>

        {tickets.length === 0 ? (
          <Container>
            <Typography.Body className="muted">
              Заявок пока нет. Создайте первую — понадобится номер договора из квитанции.
            </Typography.Body>
          </Container>
        ) : (
          <CellList mode="island">
            {tickets.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} />
            ))}
          </CellList>
        )}
      </div>

      <div className="page__footer">
        <Button variant="primary" size="large" stretched onClick={onCreateTicket}>
          Создать заявку
        </Button>
      </div>
    </Panel>
  );
}
