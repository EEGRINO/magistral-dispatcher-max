/**
 * Жильцов ведёт УК: где живёт (подъезд, этаж, квартира), номер договора,
 * архив вместо удаления. Согласовано 24.09.2026.
 *
 * - Подъезд, этаж, квартира, договор — необязательные: у уже заведённых жителей
 *   их нет, а войти в бота житель может и без них.
 * - Номер договора — справочное поле для УК. У жителя его не спрашиваем, вход
 *   по-прежнему по контакту MAX. Не уникален: на одну квартиру — несколько
 *   жильцов с одним договором.
 * - Удаление — это архив (archived_at): заявки ссылаются на жителя, а УК нужна
 *   история обращений по адресу. Из архива войти нельзя.
 * - Уникальность телефона — только среди НЕархивных: номер ушедшего жильца
 *   можно завести заново новой записью, старая остаётся со своими заявками.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE residents
      -- Подъезд и этаж числами: по ним удобно искать «кто живёт сверху».
      -- Этаж бывает отрицательным (цоколь, подвал).
      ADD COLUMN entrance SMALLINT,
      ADD COLUMN floor SMALLINT,
      -- Квартира текстом: «12А», «12/1».
      ADD COLUMN apartment TEXT,
      ADD COLUMN contract_number TEXT,
      ADD COLUMN archived_at TIMESTAMPTZ,
      ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      ADD CONSTRAINT residents_entrance_check CHECK (entrance BETWEEN 1 AND 100),
      ADD CONSTRAINT residents_floor_check CHECK (floor BETWEEN -5 AND 200),
      ADD CONSTRAINT residents_apartment_check CHECK (char_length(apartment) BETWEEN 1 AND 16),
      ADD CONSTRAINT residents_contract_number_check CHECK (char_length(contract_number) BETWEEN 1 AND 64),

      -- Архивный житель не держит привязку к MAX: иначе этот аккаунт MAX
      -- не смог бы войти в новую запись (UNIQUE на max_user_id).
      ADD CONSTRAINT residents_archived_unlinked_check
        CHECK (archived_at IS NULL OR (max_user_id IS NULL AND max_chat_id IS NULL)),

      DROP CONSTRAINT residents_phone_key;

    CREATE UNIQUE INDEX residents_phone_active_key ON residents (phone) WHERE archived_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Если в архиве остался номер, заведённый заново, вернуть UNIQUE (phone)
    -- не получится — откат упадёт на ADD CONSTRAINT, и это правильно: молча
    -- удалять архивных жителей вместе с их заявками откат не должен.
    DROP INDEX residents_phone_active_key;

    ALTER TABLE residents
      ADD CONSTRAINT residents_phone_key UNIQUE (phone),
      DROP CONSTRAINT residents_archived_unlinked_check,
      DROP COLUMN updated_at,
      DROP COLUMN archived_at,
      DROP COLUMN contract_number,
      DROP COLUMN apartment,
      DROP COLUMN floor,
      DROP COLUMN entrance;
  `);
};
