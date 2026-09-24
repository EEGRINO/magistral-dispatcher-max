# Запуск проекта

Одна команда после однократной подготовки:

```bash
docker compose up --build
```

Поднимает все три сервиса — `bot`, `api`, `db` — с логами в консоль.
Если возвращать терминал сразу, а логи смотреть отдельно: `docker compose up --build -d`,
дальше `docker compose logs -f bot`.

Порядок запуска гарантирован и выглядит так:

```
db (healthy) → migrate (применил миграции, вышел с кодом 0) → api (healthy) → bot
```

Миграции применяются **автоматически**, отдельной команды не нужно.

## Перед первым запуском (один раз)

1. **Docker Desktop.** Нужен запущенным (не только установленным) — движок
   стартует не сразу после установки/перезагрузки, ему требуется время на
   инициализацию WSL2-бэкенда. Готовность проверяется командой `docker info` —
   если она отвечает без ошибок, можно запускать `docker compose up`.

2. **`.env`.** Скопировать шаблон и вписать токен бота:

   ```bash
   cp .env.example .env
   ```

   В `.env` заполнить `MAX_BOT_TOKEN` (взять у @MasterBot в MAX). Остальные
   переменные уже имеют рабочие значения по умолчанию — трогать не обязательно.
   `.env` в `.gitignore`, коммитить его нельзя ни при каких условиях.

3. **pre-commit хук секретов** (не влияет на запуск, но нужен перед первым коммитом):

   ```bash
   git config core.hooksPath .githooks
   ```

## Проверка, что всё живо

```bash
curl http://localhost:3000/health
```

Ожидается `{"status":"ok","service":"api","db":"ok",...}`. Если `db` вернулся
`"down"`, а статус `degraded` (HTTP 503) — сервис жив, но не видит базу.

В MAX — написать боту `/start` (или нажать кнопку «Старт» в новом диалоге).
Вход — по номеру телефона, который УК заранее завела в базу (для проверки —
`SEED_TEST_PHONES` в `.env` и `docker compose run --rm migrate npm run seed`,
см. [`db/README.md`](../db/README.md)):

1. бот просит поделиться контактом и показывает кнопку «Поделиться контактом»;
2. после нажатия отвечает «Готово, вы вошли. **Номер жителя: N**».

Номер жителя означает, что цепочка MAX → бот → api → БД прошла целиком. Вместе
с ним приходит меню: «Чат дома» и «Отправить заявку ЖКХ». Дальше на `/start` —
«С возвращением! Номер жителя: N» и меню, на любой текст — меню.

«Чат дома» показывает адрес дома и кнопку-ссылку на чат (`houses.chat_link`,
у seed — `SEED_HOUSE_CHAT_LINK` для первого дома). Если дом жителя неизвестен,
бот просит адрес («Примерная 3»). Вход по QR дома — ссылка
`https://max.ru/<username_бота>?start=<invite_code>`; коды домов:

```bash
docker compose exec db psql -U max -d max_dispatcher -c "SELECT id, address, invite_code FROM houses"
```

Кнопка «Отправить заявку ЖКХ» открывает мини-приложение внутри MAX, только если
его URL привязан к боту в `business.max.ru` (см. [`max-notes.md`](max-notes.md),
«Подключение мини-приложения к боту»).

Убедиться, что привязка действительно в базе:

```bash
docker compose exec db psql -U max -d max_dispatcher -c "SELECT id, house_id, max_chat_id, max_user_id FROM residents;"
```

Если бот отвечает «Сервис временно недоступен» — api не ответил. Бот в этом
случае намеренно не молчит; причина будет в `docker compose logs bot` строкой
«api недоступен при …».

## Журнал изменений

Список изменений по дням живёт в трёх местах, и все три обновляются вместе:

| Файл | Что это |
|---|---|
| [`changelog.html`](changelog.html) | **источник**, правится руками |
| [`CHANGELOG.pdf`](CHANGELOG.pdf) | производный артефакт для чтения с телефона |
| [`../README.md`](../README.md) | краткая версия на главной странице |

Пересобрать PDF после правки HTML:

```bash
node scripts/build-changelog-pdf.mjs
```

Скрипт использует уже установленный Chrome или Edge в headless-режиме — ничего
качать не нужно. Если браузер лежит в нетипичном месте:

```bash
CHROME_PATH=/path/to/chrome node scripts/build-changelog-pdf.mjs
```

## Работа с БД

```bash
# консоль psql
docker compose exec db psql -U max -d max_dispatcher

# применить новые миграции вручную
docker compose run --rm migrate

# откатить последнюю миграцию
docker compose run --rm migrate npm run migrate:down

# загрузить ТЕСТОВЫЕ организации и дома (не для продакшена)
docker compose run --rm migrate npm run seed
```

Подробности про миграции — [`db/README.md`](../db/README.md).

Если бот в MAX не отвечает, а `docker compose ps` показывает все три
контейнера `Up`/`healthy` — смотреть `docker compose logs bot`. Частая
причина ошибок — TLS/сертификат, см. «Проблемы» ниже.

## Дома и жители: команда УК

Заводить, править и убирать жителей и дома — командой в контейнере `api`, а не
SQL руками: она проверяет формат телефона, разбирает адрес так же, как бот, а
вместо удаления убирает жителя в архив — заявки остаются. Без аргументов
печатает справку.

```bash
alias uk='docker compose exec api node dist/cli.js'   # для краткости

uk houses list
uk houses add --address "ул. Новая, д. 7 к 2" --chat https://max.ru/join/…
uk houses edit 4 --chat -                              # «-» — убрать значение

uk residents list --house 4
uk residents add --phone "8 999 000-00-00" --address "Новая 7к2" \
                 --entrance 2 --floor 5 --apartment 45А --contract Д-123
uk residents edit 12 --apartment 46 --floor -
uk residents edit 12 --phone +79990000001    # снимает привязку к MAX
uk residents archive 12                      # вместо удаления
```

Список жителей из Excel: сохранить как CSV (подойдёт и «CSV UTF-8», и обычный —
Windows-1251), первая строка — заголовки `телефон;адрес;подъезд;этаж;квартира;договор`
(обязательны первые два). Сначала проверка, потом запись:

```bash
docker compose exec -T api node dist/cli.js residents import - --dry-run < жители.csv
docker compose exec -T api node dist/cli.js residents import - < жители.csv
```

`-T` обязателен: без него docker не передаст файл на вход команде. Дома из
файла должны быть заведены заранее. Ошибки выводятся по номеру строки файла —
номера телефонов в отчёт не попадают.

Сама команда ходит в маршруты `/admin/*` api — контракт в
[`api.md`](api.md), «Дома и жители — для УК». Снаружи они закрыты.

## Остановка

```bash
docker compose down        # остановить, данные БД сохраняются в volume
docker compose down -v     # остановить и стереть данные БД
```

## Запуск без Docker (для разработки)

У каждого сервиса свой `package.json` — их можно поднимать по отдельности,
Node.js 22+ должен быть установлен локально:

```bash
cd bot && npm install && npm run dev     # бот, читает переменные из ../.env
cd api && npm install && npm run dev     # api, читает переменные из ../.env
```

`db` без Docker поднять нечем — нужен Postgres 16 руками, либо оставить его
в Docker и поднимать только `bot`/`api` локально.

## Деплой на VPS

Кратко — в [README.md](../README.md), раздел «Деплой на VPS». Здесь —
то, что не поместилось туда без потери читаемости.

### Доступ с сервера к приватному репозиторию

Репозиторий приватный — серверу нужна авторизация. Стандартный способ для
такого сценария (неинтерактивный скрипт, доступ только на чтение) —
**deploy-key**, а не личный SSH-ключ и не голый PAT:

- **Личный SSH-ключ**, скопированный на VPS, — при компрометации сервера
  под угрозой весь аккаунт GitHub, а не только этот репозиторий.
- **PAT** через HTTPS работает, но токен легко случайно засветить
  (история шелла, вывод `ps`), и по умолчанию он не привязан к одному репо.
- **Deploy-key** — ключ для конкретного репозитория, можно ограничить
  только чтением (клонировать/`pull` можно, пушить нельзя). Утечёт — под
  угрозой ровно один репозиторий.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/max_deploy_key -N "" -C "vps-deploy"
cat ~/.ssh/max_deploy_key.pub
```

Публичный ключ → GitHub → репозиторий → **Settings → Deploy keys →
Add deploy key**, галочку «Allow write access» **не ставить**.

Затем указать git, каким ключом пользоваться для github.com, и заранее
принять ключ хоста (иначе первый `git clone` в неинтерактивном скрипте
упадёт на вопросе `Are you sure you want to continue connecting?`):

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/max_deploy_key
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts
```

После этого `git clone git@github.com:EEGRINO/magistral-dispatcher-max.git`
с сервера работает.

### Обновление после новых коммитов

Полный `deploy-vps.sh` для этого не нужен — он для первичной установки.
Рутинное обновление:

```bash
cd /opt/max-dispatcher
git pull origin main && docker compose up -d --build
```

Пересоберутся только изменившиеся образы; новые миграции применятся сами
(`migrate` перезапускается вместе с обновлённым образом `db`, см.
[`db/README.md`](../db/README.md)). Новая переменная в `.env.example` в уже
развёрнутый `.env` сама не попадёт — это осознанно (`.env` никогда не
затирается автоматически), добавлять руками.

### Домен и TLS: nginx + certbot

Два поддомена — один на `api`, второй на статику мини-аппа. Контейнеры
80/443 не публикуют вообще: `db` и `api` в `docker-compose.yml` привязаны
к `127.0.0.1`, наружу отдаёт только системный nginx.

> Было решение поднимать Caddy отдельным сервисом в compose — **отменено**.
> На сервере уже стоял системный nginx, и Caddy с ним боролся за 80/443:
> кто стартовал раньше после перезагрузки, тот и держал порт, второй падал
> с `Address already in use`. Решение задним числом не масштабировалось —
> проще держать один TLS-терминатор, чем гонять входной трафик через два.

**1. Собрать статику мини-аппа на хост** (Node на хосте не нужен — сборка
идёт в одноразовом контейнере):

```bash
sudo mkdir -p /var/www/magistralbot
docker compose --profile deploy run --rm miniapp-build
```

Повторять при каждом обновлении `miniapp/` — сервис не запускается сам по
себе с обычным `docker compose up` (см. комментарий `profiles` в
`docker-compose.yml`).

**2. Конфиги nginx.** Порт api берётся из `.env`, не хардкодится:

```bash
API_PORT="$(sed -n 's|^API_PORT=||p' /opt/max-dispatcher/.env | tail -n1)"
API_PORT="${API_PORT:-3000}"
```

> ⚠️ **Наружу — только явно перечисленные пути, всё остальное — `404`.**
> Не `location / { proxy_pass … }` на весь api: 24.09.2026 именно так наружу
> оказался открыт внутренний `POST /residents/link-by-phone`, через который можно
> было привязать к себе чужую квартиру. Эндпоинты для бота живут только в сети
> compose; api дополнительно сам отвечает 404 на `/residents/*` через прокси
> (`docs/api.md`), но это вторая линия, а не повод открывать всё.

`/etc/nginx/sites-available/api.ВАШ-ДОМЕН` — наружу только `/health`:

```nginx
server {
    listen 80;
    server_name api.ВАШ-ДОМЕН;

    location = /health {
        proxy_pass http://127.0.0.1:PORT;   # подставить $API_PORT
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        return 404;
    }
}
```

`/etc/nginx/sites-available/miniapp.ВАШ-ДОМЕН` — статика плюс те маршруты api,
которые нужны мини-аппу, под тем же origin (мини-апп ходит на `/api/...`
same-origin, поэтому CORS в `api` не заведён). Каждый маршрут — отдельным
`location`; сейчас это только `/api/health`:

```nginx
server {
    listen 80;
    server_name miniapp.ВАШ-ДОМЕН;
    root /var/www/magistralbot;

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
    # proxy_pass с путём заменяет совпавшую часть: /api/health → /health
    location = /api/health {
        proxy_pass http://127.0.0.1:PORT/health;   # подставить $API_PORT
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    # Отдельный блок: иначе try_files отдал бы на неизвестный /api/... index.html с 200
    location /api/ {
        return 404;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/api.ВАШ-ДОМЕН /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/miniapp.ВАШ-ДОМЕН /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**3. Сертификаты** (certbot сам допишет SSL-директивы и редирект с 80 на 443
в уже существующие server block — конфиги из шага 2 должны быть на месте
до этой команды):

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.ВАШ-ДОМЕН -d miniapp.ВАШ-ДОМЕН
sudo certbot renew --dry-run             # проверка автопродления
systemctl status certbot.timer           # таймер должен быть active
```

**4. Файрвол** — скрипты его не трогают:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

**5. Проверка:**

```bash
curl -I https://api.ВАШ-ДОМЕН/health        # HTTP/2 200
curl -I https://miniapp.ВАШ-ДОМЕН            # HTTP/2 200, отдаёт index.html
curl -I https://miniapp.ВАШ-ДОМЕН/api/health # HTTP/2 200 — прокси на api живой
```

`/health` через `/api/` отвечающий 503 — не проблема сертификата, это
`api` не видит БД (`docs/api.md`, раздел `GET /health`).

### Имя репозитория менялось — ловушка с именем каталога

Репозиторий переименовывали (`-MAX-` → `magistral-dispatcher-max`).
GitHub держит редирект со старого адреса какое-то время, но полагаться
на него не стоит — если `git remote -v` на сервере показывает старый
адрес, поправить: `git remote set-url origin git@github.com:EEGRINO/magistral-dispatcher-max.git`.

Отдельно: если репозиторий когда-то склонировали без явного `--dir` (в том
числе вручную, не через `deploy-vps.sh`), каталог получит имя со старого
клонирования — в частности, `-MAX-` начинается с дефиса, и относительные
команды вида `cd -MAX-` или `mv -MAX- куда-то` разбираются шеллом как
флаги, а не как имя каталога. Лечится либо полным путём (`cd /root/-MAX-`
работает нормально — дефис опасен только в начале relative-аргумента),
либо явным `--` (`mv -- -MAX- новое-имя`). `deploy-vps.sh` поэтому всегда
принимает `--dir` явно, а не полагается на то, как git назовёт каталог сам.

## Проблемы, с которыми реально столкнулись при первом запуске

Ничего из этого не баг в коде проекта — все три пункта воспроизводимы на
любой свежей машине и стоят внимания при подготовке следующего компьютера
к демо.

### `docker` / `node` не найдены сразу после установки

Установщики Node.js и Docker Desktop прописывают PATH в реестре Windows,
но уже открытый терминал его не подхватывает. **Открыть новый терминал**
(перезапуск текущего окна недостаточно, если это не полноценный новый
процесс) — после этого `node -v` и `docker --version` должны отвечать.

### `docker info` отвечает ошибкой про pipe / engine недоступен

Docker Desktop установлен, но само приложение не запущено — установка не
запускает его автоматически. Запустить Docker Desktop из меню Пуск (или
с рабочего стола) и подождать: значок в трее должен перестать «крутиться».
Если после запуска `docker info` минуту-другую отвечает `500 Internal
Server Error` — двигатель ещё поднимает WSL2-бэкенд, это нормально при
первом старте, достаточно подождать.

### Docker Desktop зависает на инициализации бэкенда надолго (не 1-2 минуты, а постоянно)

Значит на машине не установлен WSL2 — Docker Desktop на Windows требует
его по умолчанию. Проверяется командой `wsl --status`. Если WSL не
установлен — `wsl --install` **от администратора**, затем обязательная
**перезагрузка**. После перезагрузки заново запустить Docker Desktop
(автостарт после установки WSL не гарантирован).

### Бот падает с `fetch failed` / `unable to get local issuer certificate`

Это не сеть и не токен. `platform-api2.max.ru` подписан сертификатом
Russian Trusted CA (Минцифры РФ), которого нет во встроенном списке
доверенных CA у Node.js. Решение уже реализовано в проекте
(`NODE_EXTRA_CA_CERTS` → `bot/certs/`) и работает «из коробки» и в Docker,
и локально — если ошибка всё же появилась, разбор в
[`docs/max-notes.md`](max-notes.md#️-tls-nodejs-не-доверяет-сертификату-platform-api2maxru-из-коробки).

### `migrate` падает с `getaddrinfo ENOTFOUND db`, хотя `db` «healthy»

Проверено 24.09.2026 на сервере, где уже стоял системный PostgreSQL.

Симптом сбивает с толку: `db` в статусе `healthy`, в его логах
`ready to accept connections`, а `migrate` не находит имя `db`; `api` и
`bot` висят в `Created`. Настоящая причина — **порт 5432 на хосте занят**
(обычно системным Postgres, `systemctl is-active postgresql`). Docker не
может пробросить порт и оставляет контейнер `db` **без сети**. Healthcheck
при этом зелёный — `pg_isready` ходит через unix-сокет внутри контейнера,
сеть ему не нужна. Встроенный DNS сети compose про `db` не знает и пересылает
запрос во внешний DNS, отсюда именно `ENOTFOUND`, а не отказ соединения.

Диагностика:

```bash
docker inspect max-dispatcher-db-1 --format '{{json .NetworkSettings.Networks}}'  # {} — сети нет
sudo ss -ltnp 'sport = :5432'                                                      # кто держит порт
```

Явная ошибка `failed to bind host port 127.0.0.1:5432/tcp: address already in use`
видна не всегда — при перезапуске контейнера демоном она уходит в журнал
Docker, а не в вывод `compose`.

Лечение — перенести наружный порт `db`, чужой Postgres не трогать:

```bash
sed -i 's/^DB_PORT=.*/DB_PORT=5433/' .env      # DATABASE_URL НЕ менять: там внутренний db:5432
docker compose down --remove-orphans && docker compose up -d
```
