/**
 * Отмена заявки жителем и часовой пояс дома. Согласовано 26.09.2026.
 *
 * - Статус cancelled: житель отменил заявку, пока она ещё «принята». Заявка
 *   не удаляется — остаётся в БД и в истории со своим статусом.
 * - houses.timezone — часовой пояс дома (IANA, например Europe/Moscow): по нему
 *   бот показывает жителю время подачи заявки. MAX боту пояс жителя не
 *   сообщает; житель и дом обычно в одном городе. Мини-апп берёт пояс
 *   устройства. Неизвестный пояс триггер отвергает с понятной ошибкой — УК
 *   правит его в pgAdmin руками.
 *
 * ALTER TYPE … ADD VALUE внутри транзакции миграции допустим (PostgreSQL 12+),
 * пока новое значение в этой же транзакции не используется.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE ticket_status ADD VALUE 'cancelled';

    ALTER TABLE houses ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/Moscow';

    CREATE FUNCTION houses_check_timezone() RETURNS trigger AS $$
    BEGIN
      PERFORM now() AT TIME ZONE NEW.timezone;
      RETURN NEW;
    EXCEPTION WHEN invalid_parameter_value THEN
      RAISE EXCEPTION 'Часовой пояс «%» не найден. Пишите как Europe/Moscow, Asia/Yekaterinburg, Asia/Novosibirsk', NEW.timezone
        USING ERRCODE = 'check_violation';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER houses_check_timezone
      BEFORE INSERT OR UPDATE OF timezone ON houses
      FOR EACH ROW
      EXECUTE FUNCTION houses_check_timezone();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER houses_check_timezone ON houses;
    DROP FUNCTION houses_check_timezone();
    ALTER TABLE houses DROP COLUMN timezone;

    -- Удалить значение из enum PostgreSQL не умеет — тип пересоздаётся. Есть
    -- отменённые заявки — откат останавливается: молча переписать их статус
    -- на другой значило бы исказить историю.
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM tickets WHERE status = 'cancelled')
         OR EXISTS (SELECT 1 FROM ticket_events WHERE 'cancelled' IN (old_status, new_status)) THEN
        RAISE EXCEPTION 'Есть отменённые заявки — откат 0008 потерял бы их статус';
      END IF;
    END $$;

    -- Колонку из условия триггера (0007) менять нельзя — снимаем его на время.
    DROP TRIGGER tickets_status_changed ON tickets;

    ALTER TYPE ticket_status RENAME TO ticket_status_old;
    CREATE TYPE ticket_status AS ENUM ('new', 'in_progress', 'resolved');

    ALTER TABLE tickets ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE tickets ALTER COLUMN status TYPE ticket_status USING status::text::ticket_status;
    ALTER TABLE tickets ALTER COLUMN status SET DEFAULT 'new';
    ALTER TABLE ticket_events
      ALTER COLUMN old_status TYPE ticket_status USING old_status::text::ticket_status,
      ALTER COLUMN new_status TYPE ticket_status USING new_status::text::ticket_status;
    DROP TYPE ticket_status_old;

    CREATE TRIGGER tickets_status_changed
      AFTER UPDATE OF status ON tickets
      FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION tickets_log_status_change();
  `);
};
