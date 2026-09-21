import { useEffect, useState } from 'react';
import { Panel, Spinner } from '@maxhub/max-ui';
import { ApiError, createTicket, fetchTickets } from './api';
import { getLaunchInfo } from './bridge';
import { NewTicketScreen } from './screens/NewTicketScreen';
import { TicketsScreen } from './screens/TicketsScreen';
import type { CreateTicketInput, Ticket } from './types/domain';

const launch = getLaunchInfo();

export function App() {
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchTickets().then((loaded) => {
      setTickets(loaded);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <Panel mode="secondary" centeredX centeredY className="page">
        <Spinner />
      </Panel>
    );
  }

  if (creating) {
    return (
      <NewTicketScreen
        error={error}
        onCancel={() => {
          setError(null);
          setCreating(false);
        }}
        onSubmit={async (input: CreateTicketInput) => {
          try {
            await createTicket(input);
            setTickets(await fetchTickets());
            setError(null);
            setCreating(false);
          } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : 'Не удалось отправить заявку');
          }
        }}
      />
    );
  }

  return (
    <TicketsScreen
      tickets={tickets}
      launch={launch}
      onCreateTicket={() => setCreating(true)}
    />
  );
}
