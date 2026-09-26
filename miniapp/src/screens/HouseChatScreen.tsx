import { useState } from 'react';
import { Button, CellList, CellSimple, Container, Panel, Typography } from '@maxhub/max-ui';
import { openMaxLink } from '../bridge';
import type { House } from '../types/domain';

interface HouseChatScreenProps {
  /** Дома жителя; несколько — сначала выбор дома (кейс 10 чек-листа). */
  houses: House[];
  onBack: () => void;
}

/** «Чат дома»: адрес и переход в групповой чат, если УК его завела. */
export function HouseChatScreen({ houses, onBack }: HouseChatScreenProps) {
  const manyHouses = houses.length > 1;
  const [chosen, setChosen] = useState<House | null>(null);
  const house = manyHouses ? chosen : (houses[0] ?? null);

  if (manyHouses && !house) {
    return (
      <Panel mode="secondary" className="page">
        <div className="page__body">
          <Container>
            <Typography.Title>Чат дома</Typography.Title>
            <Typography.Body className="muted">Выберите дом — откроем его чат.</Typography.Body>
          </Container>
          <CellList mode="island">
            {houses.map((option) => (
              <CellSimple key={option.id} title={option.address} showChevron onClick={() => setChosen(option)} />
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

  const chatLink = house?.chat_link ?? null;

  return (
    <Panel mode="secondary" className="page">
      <div className="page__body">
        <Container>
          <Typography.Title>Чат дома</Typography.Title>
          <Typography.Body className="muted">
            Общий чат жителей дома: объявления УК и соседей.
          </Typography.Body>
        </Container>

        <CellList mode="island">
          <CellSimple overline="Ваш дом" title={house?.address ?? 'пока неизвестен'} />
          {house?.uk_name && <CellSimple overline="Управляющая компания" title={house.uk_name} />}
        </CellList>

        {!chatLink && (
          <Container>
            <Typography.Body className="muted">
              {house
                ? 'Чат дома ещё не создан — обратитесь, пожалуйста, в УК.'
                : 'Дом пока не указан — обратитесь, пожалуйста, в УК.'}
            </Typography.Body>
          </Container>
        )}
      </div>

      <div className="page__footer">
        {chatLink && (
          <Button variant="primary" size="large" stretched onClick={() => openMaxLink(chatLink)}>
            Перейти в чат дома
          </Button>
        )}
        {manyHouses && (
          <Button variant="secondary" size="large" stretched onClick={() => setChosen(null)}>
            « Другой дом
          </Button>
        )}
        <Button variant={manyHouses ? 'ghost' : 'secondary'} size="large" stretched onClick={onBack}>
          Назад к заявкам
        </Button>
      </div>
    </Panel>
  );
}
