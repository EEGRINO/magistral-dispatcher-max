/**
 * Вход жителя по телефону и чат дома. Решения 24.09.2026 — docs/Решения_проекта.md.
 *
 * Модель жителя переворачивается: раньше житель создавался ботом на каждый
 * /start, теперь его заранее заводит УК (для демо — seed) с телефоном и домом,
 * а бот при входе только привязывает к записи max_chat_id и max_user_id.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- ── Старые тестовые жители ──────────────────────────────────────────
    -- Все текущие записи созданы прежним find-or-create и телефона не имеют:
    -- колонки ещё нет. Решено удалить их как тестовые (24.09.2026). Заявки
    -- ссылаются на жителей без CASCADE, поэтому сначала заявки; история
    -- заявок (ticket_events) уйдёт вместе с ними каскадом.
    DELETE FROM tickets;
    DELETE FROM residents;

    -- ── Жители ──────────────────────────────────────────────────────────

    ALTER TABLE residents
      -- Нормализованный номер: ровно +7 и 10 цифр. К этому виду приводит
      -- любой ввод и номер из контакта MAX (там он без «+»), иначе
      -- «8 912…» и «+7912…» оказались бы разными жителями.
      ADD COLUMN phone TEXT NOT NULL,
      -- id пользователя MAX. Именно его отдаёт initData мини-приложения
      -- (user.id), а не chat_id диалога. Заполняется при входе через бота.
      ADD COLUMN max_user_id BIGINT,
      -- Житель существует до первого входа — диалога с ботом у него ещё нет.
      ALTER COLUMN max_chat_id DROP NOT NULL,
      -- Одна квартира на номер — осознанное ограничение MVP.
      ADD CONSTRAINT residents_phone_key UNIQUE (phone),
      ADD CONSTRAINT residents_phone_format_check CHECK (phone ~ '^[+]7[0-9]{10}$'),
      ADD CONSTRAINT residents_max_user_id_key UNIQUE (max_user_id);

    -- ── Дома ────────────────────────────────────────────────────────────

    ALTER TABLE houses
      -- Адрес для сопоставления с ручным вводом жителя. Хранится уже
      -- нормализованным (нижний регистр, без «ул.»/«улица», без знаков
      -- препинания): тогда поиск — точное равенство по индексу, а не разбор
      -- строки. Человекочитаемый вид остаётся в address.
      ADD COLUMN street TEXT,
      ADD COLUMN number TEXT,
      -- Ссылка на групповой чат дома. Заполняет УК; пусто — чата ещё нет.
      ADD COLUMN chat_link TEXT,
      -- Код дома для QR/диплинка вместо id: id перебираются подряд, код — нет.
      -- 12 символов из gen_random_uuid() — первые 12 hex-знаков UUID v4
      -- случайны целиком (48 бит). Volatile DEFAULT вычисляется для каждой
      -- строки отдельно, так что уже существующие дома получат разные коды.
      ADD COLUMN invite_code TEXT NOT NULL
        DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
      ADD CONSTRAINT houses_street_number_key UNIQUE (street, number),
      ADD CONSTRAINT houses_invite_code_key UNIQUE (invite_code),
      ADD CONSTRAINT houses_chat_link_https_check CHECK (chat_link ~ '^https://');

    -- ── Заявки ──────────────────────────────────────────────────────────

    -- Текст «опишите проблему» из мини-приложения. Необязателен: заявка
    -- из бота может состоять только из типа проблемы и места.
    ALTER TABLE tickets ADD COLUMN description TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tickets DROP COLUMN description;

    ALTER TABLE houses
      DROP CONSTRAINT houses_chat_link_https_check,
      DROP CONSTRAINT houses_invite_code_key,
      DROP CONSTRAINT houses_street_number_key,
      DROP COLUMN invite_code,
      DROP COLUMN chat_link,
      DROP COLUMN number,
      DROP COLUMN street;

    -- В старой схеме max_chat_id обязателен. Жители, ни разу не входившие
    -- через бота, в неё не помещаются — удаляем их вместе с заявками.
    DELETE FROM tickets WHERE resident_id IN (SELECT id FROM residents WHERE max_chat_id IS NULL);
    DELETE FROM residents WHERE max_chat_id IS NULL;

    ALTER TABLE residents
      DROP CONSTRAINT residents_max_user_id_key,
      DROP CONSTRAINT residents_phone_format_check,
      DROP CONSTRAINT residents_phone_key,
      ALTER COLUMN max_chat_id SET NOT NULL,
      DROP COLUMN max_user_id,
      DROP COLUMN phone;
  `);
};
