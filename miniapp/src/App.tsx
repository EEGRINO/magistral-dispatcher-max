import { useState } from 'react';
import { DEMO_HOUSE, DEMO_TICKETS } from './demo';
import type { TicketDraft } from './scenario';
import { HouseChatScreen } from './screens/HouseChatScreen';
import { NewTicketScreen } from './screens/NewTicketScreen';
import { TicketScreen } from './screens/TicketScreen';
import { TicketsScreen } from './screens/TicketsScreen';
import type { Ticket } from './types/domain';

type Screen = { name: 'tickets' } | { name: 'ticket'; id: number } | { name: 'report' } | { name: 'chat' };

/**
 * Пока мини-апп не подключён к api, заявки живут в памяти страницы: демо-заявки
 * плюс созданные в этой сессии. Жителя и маршрутизацию определит api —
 * поэтому у новой заявки ответственного здесь нет.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'tickets' });
  const [tickets, setTickets] = useState<Ticket[]>(DEMO_TICKETS);
  const house = DEMO_HOUSE;

  const toList = () => setScreen({ name: 'tickets' });

  function createTicket(draft: TicketDraft): Ticket {
    const ticket: Ticket = {
      id: Math.max(0, ...tickets.map((t) => t.id)) + 1,
      problem_type: draft.problem_type,
      place: draft.place,
      description: draft.description,
      status: 'new',
      created_at: new Date().toISOString(),
      responsible_name: null,
      deadline_at: null,
      deadline_verified: false,
    };
    setTickets((current) => [ticket, ...current]);
    return ticket;
  }

  switch (screen.name) {
    case 'report':
      return <NewTicketScreen house={house} onCreate={createTicket} onClose={toList} />;
    case 'chat':
      return <HouseChatScreen house={house} onBack={toList} />;
    case 'ticket': {
      const ticket = tickets.find((t) => t.id === screen.id);
      if (ticket) return <TicketScreen ticket={ticket} onBack={toList} />;
      break;
    }
  }

  return (
    <TicketsScreen
      tickets={tickets}
      house={house}
      onOpenTicket={(id) => setScreen({ name: 'ticket', id })}
      onReport={() => setScreen({ name: 'report' })}
      onHouseChat={() => setScreen({ name: 'chat' })}
    />
  );
}
