import { useRef, useState, type ReactNode } from 'react';
import { Button, CellHeader, CellList, CellSimple, Container, Panel, Textarea, Typography } from '@maxhub/max-ui';
import {
  CLARIFY,
  LEAK_SOURCES,
  OWNER_ALT_LABEL,
  dangerInstructions,
  isClarifyType,
  ownerZoneText,
  type ClarifyOutcome,
  type ClarifyType,
  type OwnerZone,
  type TicketDraft,
} from '../scenario';
import { Description } from '../components/Description';
import type { DangerType, House, Place, ProblemType, Ticket } from '../types/domain';
import { PLACES, PLACES_BY_TYPE, PROBLEM_TYPES, TICKET_STATUS_LABEL } from '../types/domain';

type Step =
  /** Первый шаг, только если у жителя квартиры в нескольких домах (кейс 10 чек-листа). */
  | { name: 'house' }
  | { name: 'type' }
  | { name: 'clarify'; type: ClarifyType }
  | { name: 'place'; type: Exclude<ProblemType, 'gas'> }
  | { name: 'leak_source' }
  | { name: 'owner'; zone: OwnerZone }
  | { name: 'description' }
  | { name: 'confirm' }
  /** ticket: null — заявка ещё создаётся (или не создалась, failed): инструкция видна сразу. */
  | { name: 'danger'; danger: DangerType; ticket: Ticket | null; failed: boolean }
  | { name: 'done'; ticket: Ticket; manual: boolean };

/** Ответы жителя по ходу сценария — как черновик заявки у бота. */
interface Answers {
  type?: Exclude<ProblemType, 'gas'>;
  place?: Place;
  detail?: string;
  description?: string | null;
}

interface NewTicketScreenProps {
  /** Дома жителя; несколько — сначала «В каком доме проблема?». */
  houses: House[];
  /** Регистрирует заявку в api и возвращает её с номером. */
  onCreate: (draft: TicketDraft) => Promise<Ticket>;
  onClose: () => void;
}

export function NewTicketScreen({ houses, onCreate, onClose }: NewTicketScreenProps) {
  const manyHouses = houses.length > 1;
  const [step, setStep] = useState<Step>(manyHouses ? { name: 'house' } : { name: 'type' });
  /** Дом заявки: единственный или выбранный на первом шаге; null — неизвестен. */
  const [house, setHouse] = useState<House | null>(manyHouses ? null : (houses[0] ?? null));
  const [answers, setAnswers] = useState<Answers>({});
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Состояние React обновится только после перерисовки — два касания в одно
  // мгновение увидели бы sending = false оба. Ref меняется сразу (кейс N04).
  const sendingNow = useRef(false);
  const dangerStarted = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** Пройденные шаги с ответами на тот момент — для «Назад» (решение 26.09.2026). */
  const [history, setHistory] = useState<{ step: Step; answers: Answers }[]>([]);

  /** Шаг вперёд: текущий шаг и ответы — в историю, «Назад» вернёт их как были. */
  function go(next: Step, nextAnswers: Answers = answers) {
    setHistory((current) => [...current, { step, answers }]);
    setAnswers(nextAnswers);
    setStep(next);
  }

  /** «Назад»: предыдущий шаг; с первого шага — закрыть форму. */
  function back() {
    const previous = history[history.length - 1];
    if (!previous) {
      onClose();
      return;
    }
    setHistory((current) => current.slice(0, -1));
    setAnswers(previous.answers);
    setStep(previous.step);
  }

  // Авария: инструкция — сразу, не дожидаясь api (как у бота: что делать при
  // газе, человек должен узнать, даже если сервер не ответил). Заявка
  // создаётся параллельно; номер появится, когда api ответит.
  function toDanger(danger: DangerType) {
    // Двойное касание кнопки опасности — одна аварийная заявка.
    if (dangerStarted.current) return;
    dangerStarted.current = true;
    setStep({ name: 'danger', danger, ticket: null, failed: false });
    const sameDanger = (current: Step) => current.name === 'danger' && current.danger === danger;
    onCreate({
      problem_type: danger,
      place: null,
      detail_code: null,
      description: null,
      ...(house ? { house_id: house.id } : {}),
    })
      .then((ticket) => setStep((current) => (sameDanger(current) ? { ...current, ticket } as Step : current)))
      .catch(() => setStep((current) => (sameDanger(current) ? { ...current, failed: true } as Step : current)));
  }

  function afterPlace(next: Answers) {
    go(next.type === 'leak' && next.place === 'in_apartment' ? { name: 'leak_source' } : { name: 'description' }, next);
  }

  /** К «где?»; если место у типа одно (лифт — подъезд), не спрашиваем. */
  function toPlace(next: Answers & { type: Exclude<ProblemType, 'gas'> }) {
    const places = PLACES_BY_TYPE[next.type];
    if (places.length === 1) {
      afterPlace({ ...next, place: places[0] });
      return;
    }
    go({ name: 'place', type: next.type }, next);
  }

  function chooseType(type: ProblemType) {
    if (type === 'gas') {
      toDanger('gas_smell');
      return;
    }
    // Житель передумал с типом — прежние ответы сбрасываются.
    const next = { type };
    if (isClarifyType(type)) {
      go({ name: 'clarify', type }, next);
    } else {
      toPlace(next);
    }
  }

  function chooseClarify(outcome: ClarifyOutcome) {
    const type = answers.type!;
    switch (outcome.kind) {
      case 'danger':
        toDanger(outcome.danger);
        return;
      case 'place':
        toPlace({ type, detail: outcome.detail });
        return;
      case 'owner':
        go({ name: 'owner', zone: 'electricity' }, { type, detail: outcome.detail, place: outcome.place });
        return;
      case 'fixed_place':
        afterPlace({ type, detail: outcome.detail, place: outcome.place });
        return;
    }
  }

  function chooseOwner(action: 'ok' | 'send' | 'alt', zone: OwnerZone) {
    if (action === 'ok') {
      onClose();
      return;
    }
    if (action === 'send') {
      // Ответ о границе мог быть ошибочным — не оставляем в тупике (решение 24.09.2026).
      go({ name: 'description' }, { ...answers, detail: 'owner_override' });
      return;
    }
    if (zone === 'electricity') {
      toDanger('exposed_wiring');
    } else {
      // Течёт сам кран или он не перекрывается — это уже общее имущество.
      go({ name: 'description' }, { ...answers, detail: 'valve' });
    }
  }

  function toConfirm(description: string | null) {
    go({ name: 'confirm' }, { ...answers, description });
  }

  async function submit() {
    // Повторное нажатие, пока ждём api, второй заявки не создаёт.
    if (sendingNow.current) return;
    sendingNow.current = true;
    setSending(true);
    setSendError(null);
    try {
      const ticket = await onCreate({
        problem_type: answers.type!,
        place: answers.place ?? null,
        detail_code: answers.detail ?? null,
        description: answers.description ?? null,
        ...(house ? { house_id: house.id } : {}),
      });
      // «Другое / не уверен» — заявку классифицирует диспетчер, об этом говорим жителю.
      setStep({ name: 'done', ticket, manual: answers.type === 'other' });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Не удалось отправить заявку');
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  }

  switch (step.name) {
    case 'house':
      return (
        // Первый шаг — только «Отмена».
        <Question title="В каком доме проблема?" onCancel={onClose}>
          {houses.map((option) => (
            <Option
              key={option.id}
              label={option.address}
              onClick={() => {
                setHouse(option);
                go({ name: 'type' });
              }}
            />
          ))}
        </Question>
      );

    case 'type': {
      // Дому без газа кнопку «Запах газа» не показываем; дом неизвестен — показываем.
      const types = (Object.keys(PROBLEM_TYPES) as ProblemType[]).filter((type) => house?.has_gas !== false || type !== 'gas');
      return (
        // Первый шаг — только «Отмена» («Назад» закрыл бы форму так же); после выбора дома — и «Назад».
        <Question title="Выберите, что случилось:" onCancel={onClose} onBack={manyHouses ? back : undefined}>
          {types.map((type) => (
            <Option key={type} label={PROBLEM_TYPES[type]} onClick={() => chooseType(type)} />
          ))}
        </Question>
      );
    }

    case 'clarify':
      return (
        <Question title={CLARIFY[step.type].question} onCancel={onClose} onBack={back}>
          {CLARIFY[step.type].options.map((option) => (
            <Option key={option.label} label={option.label} onClick={() => chooseClarify(option.outcome)} />
          ))}
        </Question>
      );

    case 'place':
      return (
        <Question title="Уточните, где именно:" onCancel={onClose} onBack={back}>
          {PLACES_BY_TYPE[step.type].map((place) => (
            <Option key={place} label={PLACES[place]} onClick={() => afterPlace({ ...answers, place })} />
          ))}
        </Question>
      );

    case 'leak_source':
      return (
        <Question title="Откуда именно течёт?" onCancel={onClose} onBack={back}>
          {LEAK_SOURCES.map((source) => (
            <Option
              key={source.detail}
              label={source.label}
              onClick={() =>
                go(source.owner ? { name: 'owner', zone: 'leak' } : { name: 'description' }, {
                  ...answers,
                  detail: source.detail,
                })
              }
            />
          ))}
        </Question>
      );

    case 'owner':
      return (
        <Page
          footer={
            <>
              <Button variant="primary" size="large" stretched onClick={() => chooseOwner('ok', step.zone)}>
                ✅ Понятно, спасибо
              </Button>
              <Button variant="secondary" size="large" stretched onClick={() => chooseOwner('send', step.zone)}>
                📨 Всё равно передать в УК
              </Button>
              <Button variant="ghost" size="large" stretched onClick={back}>
                « Назад
              </Button>
            </>
          }
        >
          <Container>
            <Typography.Title>Это зона собственника</Typography.Title>
          </Container>
          <div className="notice multiline">{ownerZoneText(step.zone, house)}</div>
          {/* Пунктом списка, а не кнопкой: кнопки однострочные, длинная подпись обрезалась. */}
          <div className="section">
            <CellHeader>Если всё иначе</CellHeader>
            <CellList mode="island">
              <Option label={OWNER_ALT_LABEL[step.zone]} onClick={() => chooseOwner('alt', step.zone)} />
            </CellList>
          </div>
        </Page>
      );

    case 'description':
      return (
        <Page
          footer={
            <>
              <Button
                variant="primary"
                size="large"
                stretched
                disabled={text.trim().length === 0}
                onClick={() => toConfirm(text.trim())}
              >
                Далее
              </Button>
              <Button variant="secondary" size="large" stretched onClick={() => toConfirm(null)}>
                Без описания
              </Button>
              <Button variant="ghost" size="large" stretched onClick={back}>
                « Назад
              </Button>
            </>
          }
        >
          <Container>
            <Typography.Title>Опишите проблему</Typography.Title>
            <Typography.Body className="muted">
              Например: «Не работает кран горячей воды на кухне». Можно и без описания.
            </Typography.Body>
          </Container>
          <Container>
            <Textarea rows={5} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} />
          </Container>
        </Page>
      );

    case 'confirm':
      return (
        <Page
          footer={
            <>
              <Button variant="primary" size="large" stretched disabled={sending} onClick={() => void submit()}>
                {sending ? 'Отправляем…' : 'Отправить'}
              </Button>
              <Button variant="secondary" size="large" stretched disabled={sending} onClick={back}>
                « Назад
              </Button>
              <Button variant="ghost" size="large" stretched disabled={sending} onClick={onClose}>
                Отмена
              </Button>
            </>
          }
        >
          <Container>
            <Typography.Title>Проверьте заявку</Typography.Title>
          </Container>
          {sendError && <div className="notice notice--danger multiline">{sendError}. Попробуйте ещё раз.</div>}
          <CellList mode="island">
            <CellSimple overline="Что" title={PROBLEM_TYPES[answers.type!]} />
            {answers.place && <CellSimple overline="Где" title={PLACES[answers.place]} />}
            <CellSimple overline="Адрес" title={house?.address ?? 'дом не указан — УК уточнит'} />
            {!answers.description && <CellSimple overline="Описание" title="—" />}
          </CellList>
          {answers.description && <Description text={answers.description} />}
        </Page>
      );

    case 'danger': {
      const { text: instructions, phones } = dangerInstructions(step.danger, house);
      return (
        <Page
          footer={
            <Button variant="primary" size="large" stretched onClick={onClose}>
              {step.danger === 'gas_smell' ? 'Я позвонил(а)' : 'Готово'}
            </Button>
          }
        >
          <div className="notice notice--danger multiline">{instructions}</div>
          <Container className="phones">
            {phones.map((phone) => (
              <Button key={phone.label} asChild variant="destructive" size="large" stretched>
                <a href={`tel:${phone.number.replace(/[^\d+]/g, '')}`}>
                  📞 {phone.number} — {phone.label}
                </a>
              </Button>
            ))}
          </Container>
          {step.ticket ? (
            <TicketSummary ticket={step.ticket} emergency />
          ) : step.failed ? (
            <div className="notice notice--danger multiline">
              Не получилось передать заявку диспетчеру. Обязательно позвоните по телефонам выше.
            </div>
          ) : (
            <Container>
              <Typography.Body className="muted">Передаём заявку диспетчеру…</Typography.Body>
            </Container>
          )}
        </Page>
      );
    }

    case 'done':
      return (
        <Page
          footer={
            <Button variant="primary" size="large" stretched onClick={onClose}>
              К моим заявкам
            </Button>
          }
        >
          {step.manual && (
            <Container>
              <Typography.Body className="muted">
                Такой тип обращения нельзя маршрутизировать автоматически — заявка передана
                диспетчеру на ручную классификацию.
              </Typography.Body>
            </Container>
          )}
          <TicketSummary ticket={step.ticket} emergency={false} />
        </Page>
      );
  }
}

function Page({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <Panel mode="secondary" className="page">
      <div className="page__body">{children}</div>
      <div className="page__footer">{footer}</div>
    </Panel>
  );
}

/** Шаг-вопрос: заголовок, варианты списком, «Отмена» — на каждом шаге, как у бота. */
function Question({
  title,
  children,
  onCancel,
  onBack,
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
  /** Нет — первый шаг: там только «Отмена». */
  onBack?: () => void;
}) {
  return (
    <Page
      footer={
        <>
          {onBack && (
            <Button variant="secondary" size="large" stretched onClick={onBack}>
              « Назад
            </Button>
          )}
          <Button variant={onBack ? 'ghost' : 'secondary'} size="large" stretched onClick={onCancel}>
            Отмена
          </Button>
        </>
      }
    >
      <Container>
        <Typography.Title>{title}</Typography.Title>
      </Container>
      <CellList mode="island">{children}</CellList>
    </Page>
  );
}

function Option({ label, onClick }: { label: string; onClick: () => void }) {
  return <CellSimple title={label} showChevron onClick={onClick} />;
}

/** «Заявка зарегистрирована» — номер, статус, приоритет и ответственный, если он уже есть. */
function TicketSummary({ ticket, emergency }: { ticket: Ticket; emergency: boolean }) {
  return (
    <div className="section">
      <Container>
        <Typography.Title>Заявка зарегистрирована</Typography.Title>
      </Container>
      <CellList mode="island">
        <CellSimple overline="Номер заявки" title={String(ticket.id)} />
        <CellSimple overline="Статус" title={TICKET_STATUS_LABEL[ticket.status]} />
        {emergency && <CellSimple overline="Приоритет" title="экстренная" />}
        {ticket.responsible_name && <CellSimple overline="Ответственный" title={ticket.responsible_name} />}
      </CellList>
    </div>
  );
}
