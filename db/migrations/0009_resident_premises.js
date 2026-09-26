/**
 * Несколько квартир у жителя. Согласовано 26.09.2026 (кейс 10 чек-листа).
 *
 * - residents — человек: телефон и аккаунт MAX. Квартира — отдельной строкой
 *   в resident_premises: дом, подъезд, этаж, квартира, договор. У жителя с
 *   квартирами в разных домах бот и мини-апп спрашивают дом — в «Чат дома»
 *   и в новой заявке.
 * - Основная квартира — первая заведённая (наименьший id): её дом api отдаёт
 *   старым клиентам как residents.house_id / GET /residents/:id/house.
 * - Данные переносятся: житель с домом → одна квартира. Колонки квартиры из
 *   residents удаляются — одна правда о квартире, а не две. Квартира без дома
 *   смысла не имеет (подъезд какого дома?): у жителя без дома подъезд, этаж,
 *   квартира и договор не переносятся, число таких жителей — в NOTICE.
 * - Дом удалён — удаляются и его квартиры; заявки остаются (tickets.house_id
 *   по-прежнему SET NULL).
 *
 * down возвращает колонки и заполняет их основной квартирой; остальные
 * квартиры теряются (их число — в NOTICE).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE resident_premises (
      id              BIGSERIAL PRIMARY KEY,
      resident_id     BIGINT NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
      house_id        BIGINT NOT NULL REFERENCES houses (id) ON DELETE CASCADE,
      entrance        SMALLINT,
      floor           SMALLINT,
      apartment       TEXT,
      contract_number TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT resident_premises_entrance_check CHECK (entrance BETWEEN 1 AND 100),
      CONSTRAINT resident_premises_floor_check CHECK (floor BETWEEN -5 AND 200),
      CONSTRAINT resident_premises_apartment_check CHECK (char_length(apartment) BETWEEN 1 AND 16),
      CONSTRAINT resident_premises_contract_number_check CHECK (char_length(contract_number) BETWEEN 1 AND 64),
      -- Одна и та же квартира дважды — почти всегда двойной ввод в pgAdmin.
      -- NULLS NOT DISTINCT: и две строки «дом без номера квартиры» — тоже дубль.
      CONSTRAINT resident_premises_unique UNIQUE NULLS NOT DISTINCT (resident_id, house_id, apartment)
    );

    -- resident_id — первая колонка UNIQUE, для него отдельный индекс не нужен.
    CREATE INDEX resident_premises_house_id_idx ON resident_premises (house_id);

    -- updated_at при правке в pgAdmin — как у жителей (0007).
    CREATE FUNCTION resident_premises_touch() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER resident_premises_touch
      BEFORE UPDATE ON resident_premises
      FOR EACH ROW
      EXECUTE FUNCTION resident_premises_touch();

    INSERT INTO resident_premises (resident_id, house_id, entrance, floor, apartment, contract_number,
                                   created_at, updated_at)
    SELECT id, house_id, entrance, floor, apartment, contract_number, created_at, updated_at
      FROM residents
     WHERE house_id IS NOT NULL
     ORDER BY id;

    DO $$
    DECLARE
      lost int;
    BEGIN
      SELECT count(*) INTO lost FROM residents
       WHERE house_id IS NULL
         AND (entrance IS NOT NULL OR floor IS NOT NULL OR apartment IS NOT NULL OR contract_number IS NOT NULL);
      IF lost > 0 THEN
        RAISE NOTICE 'Жителей без дома, у которых были подъезд/этаж/квартира/договор: % — эти поля не перенесены', lost;
      END IF;
    END
    $$;

    ALTER TABLE residents
      DROP COLUMN house_id,
      DROP COLUMN entrance,
      DROP COLUMN floor,
      DROP COLUMN apartment,
      DROP COLUMN contract_number;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE residents
      ADD COLUMN house_id BIGINT REFERENCES houses (id) ON DELETE SET NULL,
      ADD COLUMN entrance SMALLINT,
      ADD COLUMN floor SMALLINT,
      ADD COLUMN apartment TEXT,
      ADD COLUMN contract_number TEXT,
      ADD CONSTRAINT residents_entrance_check CHECK (entrance BETWEEN 1 AND 100),
      ADD CONSTRAINT residents_floor_check CHECK (floor BETWEEN -5 AND 200),
      ADD CONSTRAINT residents_apartment_check CHECK (char_length(apartment) BETWEEN 1 AND 16),
      ADD CONSTRAINT residents_contract_number_check CHECK (char_length(contract_number) BETWEEN 1 AND 64);

    CREATE INDEX residents_house_id_idx ON residents (house_id);

    UPDATE residents r
       SET house_id = p.house_id, entrance = p.entrance, floor = p.floor,
           apartment = p.apartment, contract_number = p.contract_number
      FROM (SELECT DISTINCT ON (resident_id) * FROM resident_premises ORDER BY resident_id, id) p
     WHERE p.resident_id = r.id;

    DO $$
    DECLARE
      lost int;
    BEGIN
      SELECT count(*) - count(DISTINCT resident_id) INTO lost FROM resident_premises;
      IF lost > 0 THEN
        RAISE NOTICE 'Дополнительных квартир жителей: % — при откате они теряются, остаётся основная', lost;
      END IF;
    END
    $$;

    DROP TABLE resident_premises;
    DROP FUNCTION resident_premises_touch();
  `);
};
