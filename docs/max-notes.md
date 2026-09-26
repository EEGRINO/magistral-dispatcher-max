# MAX Bot API, Bridge, UI — рабочие заметки (источник правды)

> Этот файл — **единственный** источник правды по MAX Bot API, Bridge и UI в проекте.
> Сторонние туториалы, статьи и SDK устарели после миграции июля 2026 — не доверять им.
> Проверено по официальной доке <https://dev.max.ru/docs-api> — 20.09.2026.
> Разделы Bridge и UI проверены по <https://dev.max.ru/docs/webapps/bridge> и
> <https://dev.max.ru/ui> — 20.09.2026.
> Клавиатура, контакт, диплинки, подключение мини-приложения и `initData` — 24.09.2026
> по dev.max.ru и по официальной OpenAPI-спецификации
> [max-messenger/api-schema](https://github.com/max-messenger/api-schema) (`schema.yaml`,
> коммит `1a4a502` от 18.09.2026). Где сайт и спецификация расходятся — сказано явно.

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

## Inline-клавиатура

Проверено 24.09.2026: <https://dev.max.ru/docs-api/use-cases/sending-messages/keyboard>,
схемы `Button*` в `schema.yaml`.

Клавиатура — это **вложение** сообщения, а не отдельное поле:

```json
{
  "text": "Главное меню",
  "attachments": [
    {
      "type": "inline_keyboard",
      "payload": {
        "buttons": [
          [ { "type": "callback", "text": "Чат дома", "payload": "menu:house_chat" } ],
          [ { "type": "open_app", "text": "Отправить заявку ЖКХ", "web_app": "<username_бота>" } ]
        ]
      }
    }
  ]
}
```

`buttons` — массив рядов, ряд — массив кнопок. У каждой кнопки обязательны `type` и `text`
(1–128 символов). Типы:

| `type` | Поля кроме `text` | Что происходит при нажатии |
|---|---|---|
| `callback` | `payload` — строка до 1024, **обязателен** | боту приходит `message_callback` |
| `link` | `url` — до 2048, обязателен | открывается ссылка |
| `request_contact` | — | клиент отправляет **новое сообщение** с вложением-контактом пользователя |
| `request_geo_location` | `quick` (bool) | новое сообщение с геолокацией |
| `open_app` | `web_app` (обязателен), `payload`, `contact_id` | открывается мини-приложение, см. ниже |
| `message` | — | от имени пользователя уходит сообщение с текстом кнопки |
| `clipboard` | `payload` | `payload` копируется в буфер |

Лимиты: до 30 рядов и 210 кнопок; в ряду до 7 кнопок, но кнопок `link`, `open_app`,
`request_contact`, `request_geo_location` — **не больше 3 в ряду**.

**Проверено на живом боте 24.09.2026:** кнопка `link` открывает адрес **во внешнем браузере**,
а не внутри MAX, и Bridge-данных (`initData`) странице не передаёт. Открыть страницу внутри
клиента — только `open_app` мини-приложения, привязанного к боту.

## Нажатие кнопки: `message_callback` и `POST /answers`

Схемы `MessageCallbackUpdate`, `Callback`, `CallbackAnswer` в `schema.yaml`.

```json
{
  "update_type": "message_callback",
  "timestamp": 1758300000000,
  "callback": {
    "timestamp": 1758300000000,
    "callback_id": "<строка>",
    "payload": "menu:house_chat",
    "user": { "user_id": 123, "first_name": "Иван", "is_bot": false }
  },
  "message": { "...": "исходное сообщение с клавиатурой; может быть null, если его удалили" },
  "user_locale": "ru"
}
```

- Кто нажал — `callback.user.user_id`. Куда отвечать — `message.recipient.chat_id`
  (у `message` та же форма, что в `message_created`).
- Ответ на нажатие — `POST /answers?callback_id=<callback_id>` с телом `CallbackAnswer`:
  `message` (новое тело **заменяет** сообщение с клавиатурой) или `notification`
  (строка — одноразовое уведомление пользователю). Лимит тот же: 2 ответа в секунду на диалог.
- Что будет, если на нажатие не ответить, дока **не говорит** — см. «Открытые вопросы».

**Замена и удаление сообщений** (schema.yaml, 26.09.2026): `CallbackAnswer.message` — тело
`NewMessageBody`, «fill this if you want to modify current message»; `attachments: []` убирает
клавиатуру, `null` — оставляет прежнюю (так описано у `PUT /messages`, для ответа на нажатие
предполагаем то же). `PUT /messages?message_id=` — правка, `DELETE /messages?message_id=` — удаление
(«if bot has permission»). `POST /messages` возвращает `SendMessageResult { message }` — `mid` в
`message.body.mid`. Бот этим заменяет сообщение с нажатой кнопкой следующим шагом и удаляет свой
вопрос после ответа текстом. **На живом боте не проверено** — есть ли у бота право удалять свои
сообщения в диалоге и убирает ли `attachments: []` клавиатуру при ответе на нажатие. Не вышло —
бот шлёт новое сообщение, ответ жителю не теряется.

## Контакт жителя: кнопка `request_contact`

Схемы `RequestContactButton`, `ContactAttachmentPayload` в `schema.yaml`; пример `vcf_info` и
проверка `hash` — на странице «Клавиатура».

Кнопка `request_contact` есть **у бота** (не только у мини-приложения). По нажатию клиент
отправляет от имени пользователя **обычное новое сообщение** — боту приходит
`message_created`, а контакт лежит во вложении:

```json
"attachments": [
  {
    "type": "contact",
    "payload": {
      "vcf_info": "BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:ez-vcard 0.10.3\r\nTEL;TYPE=cell:79990000000\r\nFN:Ivan Ivanov\r\nEND:VCARD\r\n",
      "max_info": { "user_id": 123, "first_name": "Ivan", "...": "объект User" },
      "hash": "<строка>"
    }
  }
]
```

- Номер — в строке `TEL` внутри vCard, **без `+`**: `79990000000`.
- Подлинность: `hash` сравнивается с `HMAC-SHA256(access_token, vcf_info)`, где ключ —
  токен бота. Совпало — номер действительно принадлежит аккаунту MAX.

**Проверено на живом боте 24.09.2026** (клиент MAX на компьютере): кнопка
отображается и работает; клиент показывает отправленный контакт карточкой «Это вы»;
`hash` — 64 символа, то есть **hex** (у base64 было бы 44); `max_info.user_id`
совпадает с `sender.user_id`. Реализация — `bot/src/auth.ts`.
- Контакт можно и просто переслать чужой (вложение того же типа). Поэтому нужны обе
  проверки: `hash` и `max_info.user_id == message.sender.user_id` — «это контакт отправителя».

## Диплинки: `?start=` для бота и `?startapp=` для мини-приложения

Это **два разных механизма** — не путать.

**Бот** — раздел «Deep linking» в описании `schema.yaml`:

```
https://max.ru/<botName>?start=<payload>
```

Открывает диалог с ботом, и `payload` приходит в событии `bot_started`:

```json
{
  "update_type": "bot_started",
  "timestamp": 1573226679188,
  "chat_id": 1234567890,
  "user": { "user_id": 1234567890, "username": "borisd84" },
  "payload": "any data meaningful to bot"
}
```

- Лимит: текст спецификации говорит **128 символов** (длиннее — «omitted and not passed»),
  а схема `BotStartedUpdate.payload` — `maxLength: 512`. Закладываемся на **128**.
- Клиенты: iOS от 2.7.0, Android от 2.9.0.
- `chat_id` и `user` у `bot_started` лежат **на верхнем уровне** события — это закрывает
  прежний открытый вопрос о форме `bot_started`.

**Мини-приложение** — <https://dev.max.ru/docs/webapps/introduction>:

```
https://max.ru/<botName>?startapp=<payload>
```

Открывает мини-приложение бота; `payload` доступен в нём как `WebApp.initDataUnsafe.start_param`.
До 512 символов, только `A-Z a-z 0-9 _ -`, иначе параметр молча удаляется.

## MAX Bridge — JS-мост для мини-приложений

> Подключён в `miniapp/` — пока только определение платформы запуска
> (`miniapp/src/bridge.ts`). Проверка `initData` на сервере пока не сделана — алгоритм
> описан ниже. В `prototype/` Bridge намеренно не используется — там обычный HTML/JS
> без зависимостей.

MAX Bridge — JS-библиотека, через которую мини-приложение (веб-страница, открытая
внутри MAX) получает доступ к API мессенджера и части API устройства. После подключения
скрипта сразу, без отдельной инициализации, доступен глобальный объект `window.WebApp`.

Подключение:

```html
<script src="https://st.max.ru/js/max-web-app.js"></script>
```

### Подключение мини-приложения к боту — вручную, в кабинете

Проверено 24.09.2026: <https://dev.max.ru/docs/webapps/introduction>.

Мини-приложение **привязывается к конкретному боту** в кабинете, а не через API:
<https://business.max.ru/self> → «Чат-боты» → бот → ⋮ → «Настройки» → вставить URL →
выбрать тип кнопки («Открыть», «Старт», «Играть» или без подписи) → «Сохранить».

Требования к URL: только `https://`, до 1024 символов, без пробелов. После привязки в чате
с ботом появляется постоянная кнопка запуска мини-приложения.

### Кнопка `open_app` — открыть мини-приложение из сообщения бота

Схема `OpenAppButton` в `schema.yaml`:

| Поле | Обязательно | Смысл |
|---|---|---|
| `web_app` | да | **публичное имя (username) бота**, к которому привязано мини-приложение — **не URL** |
| `contact_id` | нет | числовой id того же бота — альтернатива имени |
| `payload` | нет | до 512 символов, только `[A-Za-z0-9_-]`; видимо, доходит до мини-приложения как `start_param` — проверить |

Ключевое: адрес мини-приложения в кнопке **не указывается**. Кнопка говорит «открой
мини-приложение бота X», а какой URL за ним стоит — берётся из настроек бота в кабинете.
Поэтому без привязки URL в кабинете кнопка открывать нечего.

**Проверено на живом боте 24.09.2026** (клиент MAX на компьютере), URL мини-аппа ещё не
привязан: сообщение с `open_app` MAX **принимает** (не 400), кнопка отображается со значком
мини-приложения, но по нажатию ничего не открывается. То есть отсутствие привязки не ломает
отправку меню — проявляется только при нажатии.

### Инициализационные данные

| Свойство | Смысл |
|---|---|
| `initData` | сырые стартовые параметры, урл-энкоженная строка — **её** проверяем на сервере |
| `initDataUnsafe` | те же данные, уже разобранные в JSON — **не для проверки подлинности** |
| `platform` | `ios` / `android` / `desktop` / `web` |
| `version` | версия клиента, напр. `"25.9.16"` |
| `deviceName` | идентификатор устройства с ОС |

Состав (<https://dev.max.ru/docs/webapps/bridge>, проверено 24.09.2026):

```ts
interface InitData {
  query_id: string;
  ip?: string;
  auth_date: number;          // Unix-время, секунды
  hash: string;
  user: { id: number; first_name: string; last_name: string;
          username: string; language_code: string; photo_url: string };
  chat: { id: number; type: 'DIALOG' | 'CHAT' | 'CHANNEL' };
  start_param: string;        // из ?startapp=
}
```

**`user.id` — это id пользователя MAX** (тот же, что `sender.user_id` в событиях бота), а не
`chat_id` диалога. Чтобы узнать жителя в мини-приложении, при авторизации в боте нужно
сохранить его `user_id`.

### Проверка `initData` на сервере

<https://dev.max.ru/docs/webapps/validation>, проверено 24.09.2026. Схема та же, что у
Telegram, но сверять надо именно по этой странице:

1. Разобрать строку `initData` на пары `key=value`; каждый ключ — ровно один раз.
2. Достать `hash` (ровно один) и исключить его из набора.
3. URL-декодировать значения, отсортировать пары по ключу (a → z).
4. Склеить в `launch_params`: `key1=value1\nkey2=value2…`.
5. Вычислить `secret_key` как `HMAC-SHA256` с ключом `"WebAppData"` по данным `BOT_TOKEN`.
6. Вычислить `signature` как hex от `HMAC-SHA256` с ключом `secret_key` по данным `launch_params`.
7. `signature == hash` → данные подлинные.

Порядок аргументов в строке 5 («ключ — строка `WebAppData`») записан так, как в доке; на
живом токене проверить, что подпись сходится. Максимальный возраст `auth_date` дока
не задаёт — выбираем сами.

### `requestContact()` в мини-приложении

Возвращает `Promise<{ phone: string; authDate: string; hash: string }>`. Проверка:
`hash == HMAC_SHA256(<строка>, botToken)`, где строка — пары `authDate`, `phone`, `userId`
в алфавитном порядке, `key=value` через `\n`; `phone` **без `+`**.

Отправить данные боту (аналог `sendData`) на странице Bridge **нет** — мини-приложение
общается с нашим api напрямую.

**Закрыть мини-приложение — `WebApp.close()`.** На странице документации метода нет, но он
есть в самом `https://st.max.ru/js/max-web-app.js` (проверено 26.09.2026): `close()` шлёт
в MAX событие `WebAppClose`; рядом `ready()` → `WebAppReady`. Кнопка «Отмена» на главном
экране мини-аппа вызывает его; вне MAX (нет `WebApp.close`) кнопка не показывается. Что
MAX действительно закрывает окно — проверить на живом клиенте.

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

- ~~Точная форма `bot_started`~~ — закрыто 24.09.2026 по `schema.yaml`: `chat_id` и `user`
  на верхнем уровне, плюс `payload` из диплинка.
- Регистрация списка команд бота (меню) — через @MasterBot или через API, не проверено.
- ~~Кодировка и порядок аргументов `hash` у контакта~~ — закрыто 24.09.2026 на живом
  боте: пересчёт подписи для 3 контактов в 2 разных диалогах совпал только с вариантом
  «ключ — токен бота, данные — `vcf_info`, результат — hex». Остальные варианты
  (ключ — `vcf_info`; base64) не совпали ни разу.
- Нужно ли отвечать на каждый `message_callback` (`POST /answers`) и что видит пользователь,
  если не ответить, — не указано. Отвечаем всегда.
- Доходит ли `payload` кнопки `open_app` до мини-приложения как `start_param`.
- Доступно ли мини-приложение при «белых списках» мобильного интернета. Внутри MAX страница
  всё равно грузится с нашего домена — проксирует ли MAX трафик мини-аппов или их домены
  попадают в списки, в доке не нашли. Спросить организаторов.
- Приходит ли `bot_started` с `payload`, если диалог с ботом **уже существует** и житель
  переходит по диплинку повторно (например, сканирует QR другого дома).
- ~~Работает ли `request_contact` на компьютере~~ — закрыто 24.09.2026: работает.
