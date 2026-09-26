import { useState, type ReactNode } from 'react';
import { Button, CellList, CellSimple, Container, Panel, Typography } from '@maxhub/max-ui';
import { StatusBadge } from '../components/TicketCard';
import { Description } from '../components/Description';
import type { Ticket } from '../types/domain';
import { formatCreated, isActive, isEmergency, placeLabel, problemLabel } from '../types/domain';

/** «Осталось»: часы до двух суток, дальше — сутки (как у бота). */
function timeLeft(deadlineIso: string): string {
  const hours = Math.ceil((Date.parse(deadlineIso) - Date.now()) / 3_600_000);
  if (hours <= 0) return 'срок истёк';
  return hours < 48 ? `${hours} ч` : `${Math.floor(hours / 24)} дн.`;
}

interface TicketScreenProps {
  ticket: Ticket;
  onBack: () => void;
  /** Отменить заявку в api; ошибка — сообщение api. */
  onCancel: () => Promise<void>;
}

/** Подробности заявки — те же строки, что бот отвечает на «статус N». */
export function TicketScreen({ ticket, onBack, onCancel }: TicketScreenProps) {
  // Отмена в два нажатия: «Отменить заявку» → «Да, отменить».
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await onCancel();
      setConfirming(false);
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : 'Не удалось отменить заявку');
    } finally {
      setCancelling(false);
    }
  }

  const rows: [string, ReactNode][] = [['Статус', <StatusBadge status={ticket.status} />]];

  if (isEmergency(ticket.problem_type)) rows.push(['Приоритет', 'экстренная']);
  if (ticket.responsible_name) rows.push(['Ответственный', ticket.responsible_name]);
  // Срок — только сверенный с первоисточником, у решённой уже не важен (решение 24.09.2026).
  if (ticket.deadline_verified && ticket.deadline_at && isActive(ticket.status)) {
    rows.push(['Осталось по нормативному сроку', timeLeft(ticket.deadline_at)]);
  }
  rows.push(['Что', problemLabel(ticket.problem_type)]);
  const place = placeLabel(ticket.place);
  if (place) rows.push(['Где', place]);
  rows.push(['Подана', formatCreated(ticket.created_at)]);

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
        {/* Описание — отдельной карточкой: в ячейку длинный текст не помещается. */}
        {ticket.description && <Description text={ticket.description} />}
        {confirming && (
          <div className="notice multiline">
            Отменить заявку № {ticket.id}? Она останется в истории со статусом «отменена».
          </div>
        )}
        {cancelError && <div className="notice notice--danger multiline">{cancelError}</div>}
      </div>

      <div className="page__footer">
        {/* Отменить можно только «принятую» (решение 26.09.2026). */}
        {ticket.status === 'new' &&
          (confirming ? (
            <>
              <Button variant="destructive" size="large" stretched disabled={cancelling} onClick={() => void cancel()}>
                {cancelling ? 'Отменяем…' : 'Да, отменить'}
              </Button>
              <Button variant="secondary" size="large" stretched onClick={() => setConfirming(false)}>
                Нет, оставить
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="large" stretched onClick={() => setConfirming(true)}>
              Отменить заявку
            </Button>
          ))}
        <Button variant="secondary" size="large" stretched onClick={onBack}>
          Назад к заявкам
        </Button>
      </div>
    </Panel>
  );
}
