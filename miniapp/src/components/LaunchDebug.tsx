/**
 * ВРЕМЕННО, до одобрения мини-аппа: экран «что MAX передал странице».
 * Открывается по ?debug в адресе или по ?startapp=debug в диплинке бота.
 * Показывает только названия полей initData и id — ни подпись (hash),
 * ни сырую строку на экран не выводим: скриншот уйдёт в чат команды.
 */
import { useState, type ReactNode } from 'react';
import { Button, CellList, CellSimple, Container, Panel, Typography } from '@maxhub/max-ui';

function field(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null && key in source
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '—';
  }
  return String(value);
}

export function isDebugLaunch(): boolean {
  return (
    new URLSearchParams(window.location.search).has('debug') ||
    field(window.WebApp?.initDataUnsafe, 'start_param') === 'debug'
  );
}

export function LaunchDebug({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  if (open) {
    return <>{children}</>;
  }

  const webApp = window.WebApp;
  const raw = webApp?.initData ?? '';
  const unsafe = webApp?.initDataUnsafe;
  const keys = [...new URLSearchParams(raw).keys()];

  const rows: [string, string][] = [
    ['window.WebApp (Bridge MAX)', webApp ? 'есть' : 'нет'],
    ['Платформа / версия', webApp ? `${show(webApp.platform)} / ${show(webApp.version)}` : '—'],
    ['initData', raw ? `${raw.length} символов` : 'пусто'],
    ['Поля initData', keys.length > 0 ? keys.join(', ') : '—'],
    ['user.id', show(field(field(unsafe, 'user'), 'id'))],
    ['chat.type', show(field(field(unsafe, 'chat'), 'type'))],
    ['start_param', show(field(unsafe, 'start_param'))],
    ['Адрес', window.location.host + window.location.pathname + window.location.search],
    ['User-Agent', navigator.userAgent],
  ];

  return (
    <Panel mode="secondary" className="page">
      <div className="page__body">
        <Container>
          <Typography.Title>Проверка запуска</Typography.Title>
          <Typography.Body className="muted">
            Внутри MAX, открыто кнопкой бота: initData не пуст, есть user.id.
            Открыто обычной ссылкой или в браузере: initData пуст.
          </Typography.Body>
        </Container>
        <CellList mode="island">
          {rows.map(([title, value]) => (
            <CellSimple key={title} title={title} subtitle={value} />
          ))}
        </CellList>
      </div>
      <div className="page__footer">
        <Button variant="primary" size="large" stretched onClick={() => setOpen(true)}>
          Открыть приложение
        </Button>
      </div>
    </Panel>
  );
}
