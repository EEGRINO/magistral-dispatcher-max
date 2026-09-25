import { Button, CellList, CellSimple, Container, Panel, Typography } from '@maxhub/max-ui';
import { openMaxLink } from '../bridge';
import type { House } from '../types/domain';

interface HouseChatScreenProps {
  house: House | null;
  onBack: () => void;
}

/** «Чат дома»: адрес и переход в групповой чат, если УК его завела. */
export function HouseChatScreen({ house, onBack }: HouseChatScreenProps) {
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
        <Button variant="secondary" size="large" stretched onClick={onBack}>
          Назад к заявкам
        </Button>
      </div>
    </Panel>
  );
}
