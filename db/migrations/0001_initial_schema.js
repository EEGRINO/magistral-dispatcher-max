/**
 * Начальная схема: организации, дома, правила маршрутизации, жители,
 * заявки и история событий по заявке.
 *
 * Тело миграции — сырой SQL внутри pgm.sql(). Так схема читается как схема,
 * а не как вызовы JS-API, и её можно скопировать в psql при разборе проблемы.
 *
 * Миграция выполняется в транзакции (поведение node-pg-migrate по умолчанию):
 * либо применяется целиком, либо не применяется вовсе.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- ── Справочники ──────────────────────────────────────────────────────

    -- УК  — управляющая компания
    -- АДС — аварийно-диспетчерская служба
    -- РСО — ресурсоснабжающая организация
    CREATE TYPE organization_type AS ENUM ('УК', 'АДС', 'РСО');

    CREATE TABLE organizations (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      type        organization_type NOT NULL,
      phone       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

      -- Справочник организаций: дубли по имени — это почти наверняка ошибка
      -- импорта. Заодно делает seed идемпотентным (ON CONFLICT DO NOTHING).
      CONSTRAINT organizations_name_key UNIQUE (name)
    );

    CREATE TABLE houses (
      id               BIGSERIAL PRIMARY KEY,
      address          TEXT NOT NULL,
      -- УК, обслуживающая дом. ON DELETE SET NULL, а не CASCADE: удаление
      -- организации не должно уносить за собой дома.
      organization_id  BIGINT REFERENCES organizations (id) ON DELETE SET NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT houses_address_key UNIQUE (address)
    );

    CREATE INDEX houses_organization_id_idx ON houses (organization_id);

    -- ── Правила маршрутизации ────────────────────────────────────────────
    -- Форма таблицы под config/rules.yaml. Состав значений problem_type/place
    -- и содержимое regulation_reference — зона Павла, здесь только контейнер.

    CREATE TABLE routing_rules (
      id                     BIGSERIAL PRIMARY KEY,
      problem_type           TEXT NOT NULL,
      -- NULL = правило применимо к любому месту.
      place                  TEXT,
      organization_id        BIGINT NOT NULL REFERENCES organizations (id),
      deadline_hours         INTEGER NOT NULL,
      -- Ссылка на пункт постановления правительства, по которому взят срок.
      regulation_reference   TEXT,
      -- Когда норматив последний раз сверяли с действующей редакцией.
      verified_at            DATE,
      is_emergency           BOOLEAN NOT NULL DEFAULT false,
      is_owner_zone          BOOLEAN NOT NULL DEFAULT false,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT routing_rules_deadline_hours_check CHECK (deadline_hours > 0)
    );

    -- Индекс, а не UNIQUE: допустимо ли несколько правил на одну пару
    -- (problem_type, place) — решает Павел, когда сложится rules.yaml.
    CREATE INDEX routing_rules_lookup_idx ON routing_rules (problem_type, place);

    -- ── Жители ───────────────────────────────────────────────────────────

    CREATE TABLE residents (
      id           BIGSERIAL PRIMARY KEY,
      -- chat_id диалога с ботом в MAX. Ключ связки «человек ↔ переписка».
      max_chat_id  BIGINT NOT NULL,
      house_id     BIGINT REFERENCES houses (id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

      -- На этот UNIQUE опирается ON CONFLICT в POST /residents/find-or-create.
      CONSTRAINT residents_max_chat_id_key UNIQUE (max_chat_id)
    );

    CREATE INDEX residents_house_id_idx ON residents (house_id);

    -- ── Заявки ───────────────────────────────────────────────────────────

    CREATE TYPE ticket_status AS ENUM ('new', 'in_progress', 'resolved');

    CREATE TABLE tickets (
      id                        BIGSERIAL PRIMARY KEY,
      resident_id               BIGINT NOT NULL REFERENCES residents (id),
      -- Копия дома на момент создания заявки, а не только ссылка через жителя:
      -- житель может переехать, заявка должна остаться привязанной к адресу.
      house_id                  BIGINT REFERENCES houses (id) ON DELETE SET NULL,
      problem_type              TEXT NOT NULL,
      place                     TEXT,
      status                    ticket_status NOT NULL DEFAULT 'new',
      -- Заполняется маршрутизацией (Д-8), поэтому пока nullable.
      assigned_organization_id  BIGINT REFERENCES organizations (id) ON DELETE SET NULL,
      deadline_at               TIMESTAMPTZ,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX tickets_resident_id_idx ON tickets (resident_id);
    CREATE INDEX tickets_house_id_idx ON tickets (house_id);
    -- Под будущий экран диспетчера «открытые заявки по сроку».
    CREATE INDEX tickets_status_deadline_idx ON tickets (status, deadline_at);

    -- ── История по заявке ────────────────────────────────────────────────

    CREATE TYPE ticket_event_type AS ENUM ('created', 'status_changed', 'notified');

    CREATE TABLE ticket_events (
      id          BIGSERIAL PRIMARY KEY,
      -- CASCADE: история без заявки смысла не имеет.
      ticket_id   BIGINT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
      event_type  ticket_event_type NOT NULL,
      old_status  ticket_status,
      new_status  ticket_status,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX ticket_events_ticket_id_idx ON ticket_events (ticket_id, created_at);

    -- ── updated_at ───────────────────────────────────────────────────────
    -- Триггером, а не из кода: так поле не забудут обновить в новом месте,
    -- и оно остаётся честным при правке строки руками через psql.

    CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER tickets_set_updated_at
      BEFORE UPDATE ON tickets
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS tickets_set_updated_at ON tickets;
    DROP FUNCTION IF EXISTS set_updated_at();

    DROP TABLE IF EXISTS ticket_events;
    DROP TABLE IF EXISTS tickets;
    DROP TABLE IF EXISTS residents;
    DROP TABLE IF EXISTS routing_rules;
    DROP TABLE IF EXISTS houses;
    DROP TABLE IF EXISTS organizations;

    DROP TYPE IF EXISTS ticket_event_type;
    DROP TYPE IF EXISTS ticket_status;
    DROP TYPE IF EXISTS organization_type;
  `);
};
