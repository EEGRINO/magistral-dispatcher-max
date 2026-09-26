import { useCallback, useEffect, useState } from 'react';
import { Button, Container, Panel, Spinner, Typography } from '@maxhub/max-ui';
import { ApiError, cancelTicket, createTicket, hasInitData, loadHouse, loadTickets } from './api';
import type { TicketDraft } from './scenario';
import { HouseChatScreen } from './screens/HouseChatScreen';
import { NewTicketScreen } from './screens/NewTicketScreen';
import { TicketScreen } from './screens/TicketScreen';
import { TicketsScreen } from './screens/TicketsScreen';
import type { House, Ticket } from './types/domain';

type Screen = { name: 'tickets' } | { name: 'ticket'; id: number } | { name: 'report' } | { name: 'chat' };

type Load = { state: 'loading' } | { state: 'error'; error: ApiError } | { state: 'ready' };

/** Что сказать жителю, если данные не загрузились. */
function problemText(error: ApiError): string {
  switch (error.code) {
    case 'not_in_max':
      return 'Откройте приложение из бота в MAX — кнопкой «Отправить заявку ЖКХ».';
    case 'not_linked':
      return 'Сначала войдите в бота: напишите ему /start и нажмите «Поделиться контактом». Потом откройте приложение снова.';
    case 'init_data_invalid':
      return 'Не получилось подтвердить вход. Закройте приложение и откройте его заново из бота.';
    default:
      return 'Сервис временно недоступен — попробуйте через минуту.';
  }
}

/**
 * Жителя, дом и заявки определяет api по подписанному initData MAX (api.ts).
 * Списки перечитываются при возврате к ним: статус заявки мог сменить диспетчер.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'tickets' });
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [house, setHouse] = useState<House | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);

  const refresh = useCallback(async () => {
    if (!hasInitData()) {
      setLoad({ state: 'error', error: new ApiError(0, 'not_in_max', 'Открыто не из MAX') });
      return;
    }
    try {
      const [loadedHouse, loadedTickets] = await Promise.all([loadHouse(), loadTickets()]);
      setHouse(loadedHouse);
      setTickets(loadedTickets);
      setLoad({ state: 'ready' });
    } catch (error) {
      setLoad({ state: 'error', error: error instanceof ApiError ? error : new ApiError(0, null, String(error)) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toList = () => {
    setScreen({ name: 'tickets' });
    void refresh();
  };

  async function cancel(id: number): Promise<void> {
    const cancelled = await cancelTicket(id);
    setTickets((current) => current.map((t) => (t.id === id ? cancelled : t)));
  }

  async function submit(draft: TicketDraft): Promise<Ticket> {
    const ticket = await createTicket(draft);
    setTickets((current) => [ticket, ...current]);
    return ticket;
  }

  if (load.state === 'loading') {
    return (
      <Panel mode="secondary" centeredX centeredY className="page">
        <Spinner />
      </Panel>
    );
  }

  if (load.state === 'error') {
    return (
      <Panel mode="secondary" className="page">
        <div className="page__body">
          <Container>
            <Typography.Title>Заявки ЖКХ</Typography.Title>
            <Typography.Body className="muted">{problemText(load.error)}</Typography.Body>
          </Container>
        </div>
        {load.error.code !== 'not_in_max' && (
          <div className="page__footer">
            <Button
              variant="primary"
              size="large"
              stretched
              onClick={() => {
                setLoad({ state: 'loading' });
                void refresh();
              }}
            >
              Повторить
            </Button>
          </div>
        )}
      </Panel>
    );
  }

  switch (screen.name) {
    case 'report':
      return <NewTicketScreen house={house} onCreate={submit} onClose={toList} />;
    case 'chat':
      return <HouseChatScreen house={house} onBack={toList} />;
    case 'ticket': {
      const ticket = tickets.find((t) => t.id === screen.id);
      if (ticket) return <TicketScreen ticket={ticket} onBack={toList} onCancel={() => cancel(ticket.id)} />;
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
