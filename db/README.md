# db

Версионирование схемы PostgreSQL через [node-pg-migrate](https://github.com/salsita/node-pg-migrate)
и seed тестовых данных.

```
migrations/   миграции, применяются по порядку номеров
seed.js       ТЕСТОВЫЕ организации и дома для локальной проверки
```

## Почему node-pg-migrate, а не knex

Knex — это query builder, который тянет за собой целый слой доступа к данным.
Запросы мы пишем на SQL через `pg`, поэтому knex появился бы в проекте только
ради миграций — и создал бы вторую точку правды о схеме. `node-pg-migrate`
делает ровно одно: версионирует схему. Тело миграции — сырой SQL, его можно
прочитать без знания JS и скопировать в `psql` при разборе проблемы.

## Команды

Через Docker (обычный путь):

```bash
docker compose run --rm migrate                       # применить новые миграции
docker compose run --rm migrate npm run migrate:down  # откатить последнюю
docker compose run --rm migrate npm run seed          # тестовые данные
```

При `docker compose up` миграции применяются сами — сервис `migrate`
отрабатывает до старта `api`.

Локально (нужен `DATABASE_URL` в окружении):

```bash
npm install
npm run migrate:up
```

## Правила

- **Применённые миграции не редактируем.** Изменение схемы — всегда новый файл.
  Правка старого означает, что у тех, кто уже накатил схему, она разъедется
  с той, что в файле, и никто этого не заметит.
- Нумерация по порядку: `0001_`, `0002_`, … Файлы применяются в порядке имён.
- Каждая миграция должна иметь рабочий `down` — иначе откатить неудачный
  выкат можно будет только руками.
- Миграция выполняется в транзакции: применяется целиком или никак.

## Что учитывает схема

Таблицы: `organizations`, `houses`, `routing_rules`, `residents`, `tickets`,
`ticket_events`. Подробности — в комментариях внутри
[`migrations/0001_initial_schema.js`](migrations/0001_initial_schema.js).

`routing_rules` — контейнер под `config/rules.yaml`. Состав значений
`problem_type` / `place` и содержимое `regulation_reference` определяются там,
а не здесь.

## Seed

Данные в `seed.js` — **выдуманные**, для локальной проверки. Скрипт идемпотентен
(`ON CONFLICT DO NOTHING`) и отказывается работать при `NODE_ENV=production`
без явного `ALLOW_SEED_IN_PRODUCTION=1`.
