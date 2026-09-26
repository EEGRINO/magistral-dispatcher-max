/**
 * Правка данных прямо в БД (pgAdmin) даёт тот же результат, что и через api.
 * Согласовано 26.09.2026: для демо сотрудник УК работает в pgAdmin мышкой.
 *
 * Без этих триггеров правка в таблице ломала бы логику молча:
 * - статус заявки меняли бы без события status_changed — житель не получил
 *   бы уведомление (бот берёт очередь из ticket_events);
 * - телефон «8 999 123-45-67» отвергался бы проверкой формата;
 * - перевод жителя в архив падал бы на проверке «у архивного нет привязки к MAX».
 *
 * Логика, которой место в БД, — в БД: так она работает при любом способе
 * правки. Разбор адреса на улицу и номер остаётся в api (api/src/address.ts,
 * одна реализация на бота и УК): триггер только сбрасывает устаревшие
 * street/number, а api дозаполняет их (api/src/house-normalizer.ts).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- ── Заявки: событие при любой смене статуса ─────────────────────────
    -- Раньше событие писал api (routes/dispatch.ts); теперь — только триггер,
    -- иначе при смене через api событий было бы два.

    CREATE FUNCTION tickets_log_status_change() RETURNS trigger AS $$
    BEGIN
      INSERT INTO ticket_events (ticket_id, event_type, old_status, new_status)
      VALUES (NEW.id, 'status_changed', OLD.status, NEW.status);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER tickets_status_changed
      AFTER UPDATE OF status ON tickets
      FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION tickets_log_status_change();

    -- ── Жители: телефон, архив, смена номера ────────────────────────────

    CREATE FUNCTION residents_normalize() RETURNS trigger AS $$
    DECLARE
      digits TEXT := regexp_replace(NEW.phone, '[^0-9]', '', 'g');
    BEGIN
      -- Любой ввод → +7XXXXXXXXXX, как команда УК и бот. Не похоже на номер —
      -- оставляем как есть: проверка формата отвергнет с понятной ошибкой.
      IF char_length(digits) = 10 THEN
        NEW.phone := '+7' || digits;
      ELSIF char_length(digits) = 11 AND left(digits, 1) IN ('7', '8') THEN
        NEW.phone := '+7' || substr(digits, 2);
      END IF;

      IF TG_OP = 'UPDATE' THEN
        -- Номер сменился — привязка к MAX снимается: аккаунт подтверждал
        -- старый номер. Архив — тоже: иначе этот аккаунт MAX не смог бы
        -- войти в новую запись (UNIQUE max_user_id).
        IF NEW.phone IS DISTINCT FROM OLD.phone
           OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL) THEN
          NEW.max_user_id := NULL;
          NEW.max_chat_id := NULL;
        END IF;
        NEW.updated_at := now();
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER residents_normalize
      BEFORE INSERT OR UPDATE ON residents
      FOR EACH ROW
      EXECUTE FUNCTION residents_normalize();

    -- ── Дома: новый адрес — разобрать заново ────────────────────────────
    -- Адрес поменяли, а улицу и номер нет (правка в pgAdmin) — сбрасываем их,
    -- api разберёт адрес заново. Api меняет все три поля вместе — его правку
    -- триггер не трогает.

    CREATE FUNCTION houses_reset_parsed_address() RETURNS trigger AS $$
    BEGIN
      IF NEW.address IS DISTINCT FROM OLD.address
         AND NEW.street IS NOT DISTINCT FROM OLD.street
         AND NEW.number IS NOT DISTINCT FROM OLD.number THEN
        NEW.street := NULL;
        NEW.number := NULL;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER houses_reset_parsed_address
      BEFORE UPDATE OF address ON houses
      FOR EACH ROW
      EXECUTE FUNCTION houses_reset_parsed_address();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER houses_reset_parsed_address ON houses;
    DROP FUNCTION houses_reset_parsed_address();
    DROP TRIGGER residents_normalize ON residents;
    DROP FUNCTION residents_normalize();
    DROP TRIGGER tickets_status_changed ON tickets;
    DROP FUNCTION tickets_log_status_change();
  `);
};
