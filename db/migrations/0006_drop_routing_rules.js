/**
 * Удалить routing_rules. Согласовано 24.09.2026.
 *
 * Таблица из 0001 задумывалась контейнером под config/rules.yaml, но правила
 * маршрутизации api читает прямо из YAML (api/src/routing.ts, миграция 0005),
 * а таблица так и осталась пустой. Две точки правды о правилах путали бы при
 * сверке схемы — оставляем одну, YAML.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`DROP TABLE routing_rules;`);
};

/** Откат возвращает таблицу ровно в том виде, как её создала 0001 (пустой). */
exports.down = (pgm) => {
  pgm.sql(`
    CREATE TABLE routing_rules (
      id                     BIGSERIAL PRIMARY KEY,
      problem_type           TEXT NOT NULL,
      place                  TEXT,
      organization_id        BIGINT NOT NULL REFERENCES organizations (id),
      deadline_hours         INTEGER NOT NULL,
      regulation_reference   TEXT,
      verified_at            DATE,
      is_emergency           BOOLEAN NOT NULL DEFAULT false,
      is_owner_zone          BOOLEAN NOT NULL DEFAULT false,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT routing_rules_deadline_hours_check CHECK (deadline_hours > 0)
    );

    CREATE INDEX routing_rules_lookup_idx ON routing_rules (problem_type, place);
  `);
};
