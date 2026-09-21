import { useState } from 'react';
import {
  Button,
  CellHeader,
  CellList,
  CellSimple,
  Container,
  Input,
  Panel,
  Radio,
  Textarea,
  Typography,
} from '@maxhub/max-ui';
import type { CreateTicketInput, TicketType } from '../types/domain';
import { TICKET_TYPES, TICKET_TYPE_LABEL } from '../types/domain';

interface NewTicketScreenProps {
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: CreateTicketInput) => Promise<void>;
}

export function NewTicketScreen({ error, onCancel, onSubmit }: NewTicketScreenProps) {
  const [contractNumber, setContractNumber] = useState('');
  const [type, setType] = useState<TicketType>('pipe');
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);

  const filled = contractNumber.trim().length > 0 && description.trim().length > 0;

  async function handleSubmit() {
    setSending(true);
    await onSubmit({ contractNumber, type, description: description.trim() });
    setSending(false);
  }

  return (
    <Panel mode="secondary" className="page">
      <div className="page__body">
        <Container>
          <Typography.Title>Новая заявка</Typography.Title>
          <Typography.Body className="muted">
            Номер договора указан в квитанции — по нему определится адрес квартиры.
          </Typography.Body>
        </Container>

        <Container>
          <Input
            size="large"
            inputMode="numeric"
            value={contractNumber}
            placeholder="Номер договора, например 77012"
            hint={error ?? undefined}
            onChange={(event) => setContractNumber(event.target.value)}
          />
        </Container>

        {/* Заголовок вынесен из CellList: у встроенного header отступ до списка
            слишком мал, а его внутренние классы захешированы и не настраиваются. */}
        <div className="section">
          <CellHeader>Проблема</CellHeader>
          <CellList mode="island">
            {TICKET_TYPES.map((value) => (
              <CellSimple
                key={value}
                title={TICKET_TYPE_LABEL[value]}
                onClick={() => setType(value)}
                after={<Radio checked={type === value} readOnly />}
              />
            ))}
          </CellList>
        </div>

        <Container>
          <Textarea
            rows={5}
            value={description}
            placeholder="Опишите проблему: где, с какого времени, есть ли угроза"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Container>
      </div>

      <div className="page__footer">
        <Button
          variant="primary"
          size="large"
          stretched
          loading={sending}
          disabled={!filled}
          onClick={handleSubmit}
        >
          Отправить
        </Button>
        <Button variant="secondary" size="large" stretched onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </Panel>
  );
}
