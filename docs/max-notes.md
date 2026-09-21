# MAX Bot API, Bridge, UI — рабочие заметки (источник правды)

> Этот файл — **единственный** источник правды по MAX Bot API, Bridge и UI в проекте.
> Сторонние туториалы, статьи и SDK устарели после миграции июля 2026 — не доверять им.
> Проверено по официальной доке <https://dev.max.ru/docs-api> — 20.09.2026.
> Разделы Bridge и UI проверены по <https://dev.max.ru/docs/webapps/bridge> и
> <https://dev.max.ru/ui> — 20.09.2026.

## ⚠️ Что сломалось в июле 2026 (почему нельзя гуглить примеры)

| | Было (до 19.07.2026) | Стало (сейчас) |
|---|---|---|
| База | `https://botapi.max.ru`, затем `https://platform-api.max.ru` | **`https://platform-api2.max.ru`** |
| Токен | `?access_token=TOKEN` в query | **заголовок `Authorization: <token>`** |
| Query-auth | работал | **401 Unauthorized** |
| `GET /chats` | работал | удалён (deprecated с 06.2026) |

Практические следствия:

- Любой пример с `?access_token=` — **нерабочий**, вернёт 401.
- В заголовке **нет префикса `Bearer`**. Просто `Authorization: <токен>`.
- npm-пакет `max-bot-ts` на момент проверки всё ещё ходил в старый `platform-api.max.ru`.
  Поэтому в проекте **свой тонкий клиент на `fetch`**, без SDK — см. `bot/src/max-api.ts`.

## ⚠️ TLS: Node.js не доверяет сертификату platform-api2.max.ru «из коробки»

`platform-api2.max.ru` подписан цепочкой **Russian Trusted Root/Sub CA**
(Минцифры России). Windows и браузеры этому CA доверяют, а встроенный
список доверенных CA у Node.js (из Mozilla) — нет. Итог:

```
TypeError: fetch failed
  cause: Error: unable to get local issuer certificate
  code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
```

При этом `curl` тот же запрос выполняет без единой жалобы (использует
системное хранилище сертификатов Windows) — из-за этого расхождения
можно долго думать на сеть или файрвол, хотя дело в CA Node.js.

**Решение:** `NODE_EXTRA_CA_CERTS`, указывающий на связку Root+Sub CA,
вшитую в репозиторий — [`bot/certs/russian-trusted-ca-chain.pem`](../bot/certs/russian-trusted-ca-chain.pem)
(подробности добычи — там же, в `bot/certs/README.md`). Переменная задана
в `.env.example` и прокинута в `docker-compose.yml`, поэтому и `npm run dev`,
и `docker compose up` получают её одинаково.

Альтернатива — флаг `node --use-system-ca`: работает локально на машине,
где Windows уже доверяет этому CA, но бесполезен в чистом Alpine-образе
(там этого CA просто нет), поэтому для проекта выбран переносимый вариант
через `NODE_EXTRA_CA_CERTS`.

Если после `docker compose up` бот снова падает на этой ошибке — проверить,
что `certs/` действительно попал в образ (`docker compose exec bot ls certs/`)
и что `NODE_EXTRA_CA_CERTS` виден процессу (`docker compose exec bot env | grep CA_CERTS`).

**Ловушка:** `node --env-file=.env` для этой переменной не работает, хотя для
остальных (`MAX_BOT_TOKEN` и т.д.) — работает. `NODE_EXTRA_CA_CERTS` читается
нативным TLS-слоем на старте процесса, раньше, чем `--env-file` успевает
положить её в `process.env`. `process.env.NODE_EXTRA_CA_CERTS` внутри кода
покажет правильное значение, а `fetch` всё равно упадёт с той же ошибкой —
переменная должна быть в окружении ДО запуска `node`. Поэтому в
`bot/package.json` она передана через `cross-env`, а не через `--env-file`.
В Docker эта ловушка не встречается: `docker-compose` кладёт переменные
в окружение контейнера до старта процесса, ровно как нужно.

## Транспорт: long polling (выбран для MVP)

Одновременно может быть активен **только один** способ доставки — webhook **или** long polling.
Если раньше на этом токене регистрировали webhook — polling работать не будет, пока webhook не снят.

Для MVP выбран long polling: не нужен публичный HTTPS-домен и туннель, бот поднимается
из docker-compose где угодно. Дока помечает polling как «для разработки и тестирования»
(ограничения по скорости и сроку хранения событий); для прода рекомендуется webhook —
это задача после хакатона, не сейчас.

Webhook, если понадобится: обязателен HTTPS на порту **443**, самоподписанные сертификаты
больше не принимаются.

## `GET /updates` — приём событий

```http
GET https://platform-api2.max.ru/updates?limit=100&timeout=90&marker=<int64>
Authorization: <MAX_BOT_TOKEN>
```

| Параметр | Тип | По умолчанию | Смысл |
|---|---|---|---|
| `limit` | int 1..1000 | 100 | сколько событий вернуть за раз |
| `timeout` | int 0..90 | 30 | сколько секунд держать соединение открытым |
| `marker` | int64, nullable | — | **опустить** → отдаст только свежие события; передать `marker` из прошлого ответа → отдаст всё с того места |
| `types` | string[] | — | фильтр, напр. `message_created,message_callback` |

Ответ:

```json
{
  "updates": [ { "update_type": "message_created", "timestamp": 1758300000000, "message": { ... } } ],
  "marker": 123456789
}
```

**Протокол маркера:** первый запрос — без `marker` (иначе бот на старте разгребёт весь
накопившийся бэклог). Дальше в каждый следующий запрос кладём `marker` из предыдущего ответа.
Маркер двигается вперёд, даже если событие нам неинтересно, поэтому неизвестные
`update_type` просто игнорируем, а не роняем цикл.

Коды: `200` ок, `401` плохой/протухший токен, `405` не тот метод, `500` ошибка сервера.
**401 — это фатально**, ретраить бессмысленно: бот должен упасть с внятным сообщением.

## Структура `message_created`

```json
{
  "update_type": "message_created",
  "timestamp": 1758300000000,
  "message": {
    "sender":    { "user_id": 123, "first_name": "Иван", "username": "ivan", "is_bot": false },
    "recipient": { "chat_id": 456, "chat_type": "dialog", "user_id": 123 },
    "body":      { "mid": "mid.abc", "seq": 7, "text": "течёт труба в подвале" },
    "link":      null
  }
}
```

- Текст живёт в `message.body.text`. У сообщения без текста (стикер, фото) `text` может отсутствовать.
- Отвечать нужно в `message.recipient.chat_id`. Если `chat_id` нет — фолбэк на
  `message.sender.user_id`.
- `sender.is_bot` — обязательно проверять и игнорировать ботов, иначе два бота в одном
  чате уйдут в бесконечное эхо.

## Типы событий

Набор событий заметно меньше телеграмного: нет отдельных событий на реакции и вход в чат.

| `update_type` | Когда |
|---|---|
| `bot_started` | пользователь начал диалог / нажал «Старт» |
| `message_created` | новое сообщение |
| `message_edited` | сообщение отредактировали |
| `message_removed` | сообщение удалили |
| `message_callback` | нажата кнопка inline-клавиатуры |
| `bot_added` / `bot_removed` | бота добавили в чат / убрали |

**Про `/start` — важный нюанс.** Это два разных события:

1. Нажатие кнопки «Старт» в новом диалоге → `bot_started` (события `message_created` при этом нет).
2. Пользователь руками напечатал `/start` → обычный `message_created` с `body.text == "/start"`.

Обрабатывать нужно **оба**, иначе у части жюри бот промолчит на первом же экране.
Проверка делается через `startsWith('/start')`, чтобы пережить deep-link вида `/start ref=qr123`.

## `POST /messages` — отправка

```http
POST https://platform-api2.max.ru/messages?chat_id=456
Authorization: <MAX_BOT_TOKEN>
Content-Type: application/json

{ "text": "Бот на связи.", "notify": true }
```

- Адресат задаётся **query-параметром**: `chat_id` (чат/канал) или `user_id` (личка) — не телом.
- Тело: `text` (до **4000** символов), `attachments`, `link`, `notify` (по умолчанию `true`),
  `format` (`"markdown"` | `"html"`).
- `disable_link_preview` — тоже query-параметр.
- Лимит: **не больше 2 сообщений в секунду в один диалог/чат/канал.**
  Для эха это некритично, но для будущих рассылок по подъезду — узкое место, закладываем очередь.
- Ответ: объект `Message`.

## MAX Bridge — JS-мост для мини-приложений

> Подключён в `miniapp/` — пока только определение платформы запуска
> (`miniapp/src/bridge.ts`). Валидация `initData` не сделана: авторизация жителя
> запланирована на Д-8/Д-9. В `prototype/` Bridge намеренно не используется —
> там обычный HTML/JS без зависимостей.

MAX Bridge — JS-библиотека, через которую мини-приложение (веб-страница, открытая
внутри MAX) получает доступ к API мессенджера и части API устройства. После подключения
скрипта сразу, без отдельной инициализации, доступен глобальный объект `window.WebApp`.

Подключение:

```html
<script src="https://st.max.ru/js/max-web-app.js"></script>
```

### Инициализационные данные

| Свойство | Смысл |
|---|---|
| `initData` | сырые стартовые параметры, урл-энкоженная строка |
| `initDataUnsafe` | те же данные, уже разобранные в JSON — **не для проверки подлинности** |
| `platform` | `ios` / `android` / `desktop` / `web` |
| `version` | версия клиента, напр. `"25.9.16"` |
| `deviceName` | идентификатор устройства с ОС |

Проверка подлинности `initData` — отдельная страница доки, «Data Validation»
(<https://dev.max.ru/docs/webapps/validation>); `initDataUnsafe` для этого не годится.

### Методы и объекты API (по категориям)

| Категория | Методы/объекты |
|---|---|
| Контекст запуска | `getLaunchContext()` — источник запуска (tabbar/default) |
| Экран | `getViewportSize()`, `requestScreenMaxBrightness()` / `restoreScreenBrightness()` (макс. яркость на 30 сек) |
| Навигация | `BackButton.show()` / `hide()` / `onClick(callback)` |
| Шаринг | `shareContent(params)` (нативный, только iOS/Android), `shareMaxContent(params)` (внутри MAX, с форвардом сообщений) |
| Файлы/ссылки | `downloadFile(url, file_name)` (только HTTPS), `openLink(url)` (внешний браузер), `openMaxLink(url)` (deep link внутри MAX) |
| Хранилище | `DeviceStorage` (`setItem`/`getItem`/`removeItem`/`clear`), `SecureStorage` (шифрованное, максимум 10 ключей на пользователя) |
| Биометрия | `BiometricManager.init()` (обязателен перед использованием), `.authenticate(reason)`, `.updateBiometricToken(token, reason)`, `.openSettings()` |
| Тактильный отклик | `HapticFeedback.impactOccurred()` / `.notificationOccurred()` / `.selectionChanged()` |
| Контакты | `requestContact()` — запрос номера телефона, с возможностью проверки через HMAC_SHA256 |
| QR/NFC | `openCodeReader(fileSelect)` (сканер QR), `NfcManager` — **только Android** (`init()`, `emulateNfcTag()`, `openSystemSettings()`) |
| Экран/скриншоты | `ScreenCapture.enableScreenCapture()` / `.disableScreenCapture()` |
| Закрытие | `enableClosingConfirmation()` / `disableClosingConfirmation()` — предупреждение о потере данных при закрытии |

### Обработка ошибок

Промисы отклоняются объектом вида:

```json
{ "error": { "code": "..." } }
```

### Ограничения по платформам

- **Desktop и web-клиент** не поддерживают: `DeviceStorage`, `SecureStorage`,
  `BiometricManager`, `HapticFeedback`, `NfcManager`.
- **Web (браузер)** дополнительно не поддерживает: `shareContent`, выбор файлов, NFC.
- `NfcManager` — эксклюзивно для Android.

### Смежные страницы доки (для дальнейшего погружения)

- Мини-приложения, введение — <https://dev.max.ru/docs/webapps/introduction>
- Проверка `initData` — <https://dev.max.ru/docs/webapps/validation>
- MAX Bot API (справочник) — <https://dev.max.ru/docs-api>

## MAX UI — React UI-кит для мини-приложений

> Интерфейс `miniapp/` собран на этих компонентах. Заметки ниже — результат
> реальной проверки пакета, а не чтения сайта: расхождения перечислены отдельно.

`@maxhub/max-ui` — библиотека React-компонентов для мини-приложений в MAX, сторонних
суперприложений и standalone-приложений. Компоненты сами адаптируются под платформу
(iOS/Android) и тему, чтобы интерфейс выглядел «нативно» для MAX.

Установка:

```bash
npm i @maxhub/max-ui
```

Подключение провайдера и стилей (из README библиотеки):

```tsx
import { createRoot } from 'react-dom/client';
import { MaxUI } from '@maxhub/max-ui';
import '@maxhub/max-ui/dist/styles.css';

createRoot(document.getElementById('root')).render(
  <MaxUI><App /></MaxUI>
);
```

### ⚠️ Версия React: README врёт, peerDependencies — нет

README библиотеки заявляет «React 18+», но в `package.json` опубликованного
`@maxhub/max-ui@0.5.0` стоит **точная** привязка (проверено по
<https://registry.npmjs.org/@maxhub/max-ui/latest> — 20.09.2026):

```json
"peerDependencies": { "react": "19.2.8", "react-dom": "19.2.8" }
```

Не диапазон, а ровно одна версия. На React 18 `npm install` упадёт с `ERESOLVE`,
на 19.3 — тоже. Значит React и React-DOM надо закреплять как `19.2.8` **без каретки**:
каретка (`^19.2.8`) разрешила бы 19.3 и сломала бы установку. Проверено на живой
установке 20.09.2026.

Следствие на будущее: при обновлении `@maxhub/max-ui` первым делом смотреть его
`peerDependencies`, а не README — версия React поедет вместе с библиотекой.

### ⚠️ Сайт доки описывает НЕ ту версию, что лежит в npm

Проверено на установленном `@maxhub/max-ui@0.5.0` по его же `dist/*.d.ts` — 20.09.2026.
Два расхождения, каждое ломает сборку:

1. **`Dot` не экспортируется.** На dev.max.ru компонент задокументирован, в пакете есть
   `dist/components/Dot/`, но barrel-файл `dist/components/index.d.ts` его не
   реэкспортирует. `import { Dot } from '@maxhub/max-ui'` → `TS2305: has no exported
   member 'Dot'`. Обойти глубоким импортом нельзя: в `exports` пакета разрешены только
   `.`, `./styles.css`, `./package.json`, `./dist/styles.css`. То же самое с `ToolButton`.
   Замена для индикатора-точки — `Counter`, он экспортируется.
2. **У `Counter` проп называется `variant`, а не `appearance`,** и набор значений другой,
   чем на сайте.

Вывод: единственный надёжный источник по пропсам — `node_modules/@maxhub/max-ui/dist/*.d.ts`
установленной версии. Сайт доки годится, чтобы узнать о существовании компонента.

### Что реально экспортируется из корня пакета в 0.5.0

`Avatar`, `Button`, `CellAction`, `CellHeader`, `CellInput`, `CellList`, `CellSimple`,
`Counter`, `IconButton`, `Input`, `MaxUI`, `Radio`, `Spinner`, `Switch`, `Textarea`,
`Typography` — плюс из `internal`: `Container`, `Flex`, `Grid`, `Panel`, `EllipsisText`,
`Ripple`, `Tappable`, `ClearableInput`, `SvgButton`.

| Компонент | Пропсы (из `.d.ts`, а не с сайта) |
|---|---|
| `Panel` | `mode: "primary" \| "secondary"`, `centeredX`, `centeredY` |
| `Container` | `fullWidth`, `asChild` |
| `CellList` | `mode: "full-width" \| "island"`, `filled`, `header` |
| `CellSimple` | `title`, `subtitle`, `overline`, `before`, `after`, `showChevron`, `height: "compact" \| "normal"`, `surface: "default" \| "island"`, `subtitleMode`, `separator`, `link`, `disabled` |
| `Counter` | `value` (обязателен), `variant: "primary" \| "primary-contrast" \| "attention" \| "attention-contrast" \| "promo" \| "static" \| "static-contrast" \| "default" \| "mute" \| "menu"`, `rounded` |
| `Typography` | `.Display` `.Headline` `.Title` `.Body` `.Label` `.Text` `.Action`, у каждого свой `variant` |

Состав библиотеки:

- **Базовые компоненты** — Avatar, Button, Panel, Input и т.д.
- **Typography** — заголовки, текст, лейблы разных уровней.
- **Layout** — Flex, Grid, контейнеры для вёрстки.
- **Forms** — Input, Textarea, Switch и другие элементы ввода.
- **Helpers** — вспомогательные утилиты, напр. `EllipsisText`, `Ripple`.

Компоненты поддерживают полиморфизм через `asChild`-проп и кастомизацию через
CSS-переменные.

### Смежные страницы доки

- Документация платформы — <https://dev.max.ru/docs>
- Справочник Bot API — <https://dev.max.ru/docs-api>
- MAX UI (эта страница) — <https://dev.max.ru/ui>
- Changelog — <https://dev.max.ru/changelog-docs>

## Открытые вопросы (проверить на живом боте)

- Точная форма `bot_started`: где лежит адресат — `chat_id` на верхнем уровне, `user.user_id`
  или `user_id`. В коде сделан устойчивый резолвер, перебирающий все три варианта;
  после первого живого `/start` посмотреть лог `update_type=bot_started` и зафиксировать здесь.
- Регистрация списка команд бота (меню) — через @MasterBot или через API, не проверено.
