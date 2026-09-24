/**
 * Маршрутизация заявок по config/rules.yaml. Согласовано 24.09.2026.
 *
 * - tickets.detail_code — ответ жителя на уточнение после типа проблемы
 *   («стояк», «сам вентиль», «не знаю», «мусоропровод»…). Факт от жителя:
 *   «не знаю» и «стояк» ведут в одно правило, но для диспетчера это разное.
 * - tickets.rule_id — какое правило rules.yaml сработало. Снимок на момент
 *   создания: если правила потом поправят, у старой заявки останется то
 *   основание, по которому её направили. NULL — заявка создана до маршрутизации.
 *   Без FK: правила живут в YAML, а не в БД.
 * - house_organizations — ресурсоснабжающие организации дома по ролям (вода,
 *   тепло, электричество, газ), как в houses.json Павла. Таблица, а не колонки
 *   в houses: новая роль — строка, а не миграция. УК дома по-прежнему в
 *   houses.organization_id.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tickets
      ADD COLUMN detail_code TEXT,
      ADD COLUMN rule_id TEXT,
      ADD CONSTRAINT tickets_detail_code_check CHECK (char_length(detail_code) BETWEEN 1 AND 64),
      ADD CONSTRAINT tickets_rule_id_check CHECK (char_length(rule_id) BETWEEN 1 AND 64);

    CREATE TABLE house_organizations (
      -- CASCADE: связь без дома или без организации смысла не имеет.
      house_id         BIGINT NOT NULL REFERENCES houses (id) ON DELETE CASCADE,
      -- Роли — как responsible_categories rso_* в config/rules.yaml.
      role             TEXT NOT NULL,
      organization_id  BIGINT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

      -- Одна организация на роль у дома.
      PRIMARY KEY (house_id, role),
      CONSTRAINT house_organizations_role_check CHECK (role IN ('water', 'heat', 'electricity', 'gas'))
    );

    CREATE INDEX house_organizations_organization_id_idx ON house_organizations (organization_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE house_organizations;

    ALTER TABLE tickets
      DROP CONSTRAINT tickets_rule_id_check,
      DROP CONSTRAINT tickets_detail_code_check,
      DROP COLUMN rule_id,
      DROP COLUMN detail_code;
  `);
};
