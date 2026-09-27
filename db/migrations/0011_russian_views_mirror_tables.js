/**
 * Русские представления — зеркало таблиц один в один. 27.09.2026.
 *
 * Зачем: открыть рядом английскую таблицу (в ней правят) и русское
 * представление (по нему сверяют, тот ли столбец правится). Для этого у
 * представления те же столбцы в том же порядке, что у таблицы, и строки
 * по возрастанию id — как pgAdmin показывает таблицу. Вычисляемые столбцы
 * «…_словами» — в самом конце, чтобы не сбивать сравнение. В 0010 столбцы
 * были выборочные и переставлены — сравнивать было неудобно.
 *
 * Добавлено представление организации_дома (house_organizations).
 * Таблицы, их столбцы и код не меняются. Сравнения с enum — через ::text
 * (см. 0010: на свежей базе миграции идут одной транзакцией).
 */

exports.shorthands = undefined;

const DROP_ALL = `
  DROP VIEW IF EXISTS организации_дома;
  DROP VIEW IF EXISTS история_заявок;
  DROP VIEW IF EXISTS заявки;
  DROP VIEW IF EXISTS организации;
  DROP VIEW IF EXISTS дома;
  DROP VIEW IF EXISTS квартиры;
  DROP VIEW IF EXISTS жители;
`;

const STATUS_WORDS = (column) => `CASE ${column}::text
               WHEN 'new' THEN 'принята'
               WHEN 'in_progress' THEN 'в работе'
               WHEN 'resolved' THEN 'решена'
               WHEN 'cancelled' THEN 'отменена'
             END`;

exports.up = (pgm) => {
  pgm.sql(`
    ${DROP_ALL}

    CREATE VIEW жители AS
      SELECT id AS номер,
             max_chat_id AS "чат_MAX",
             created_at AS заведён,
             phone AS телефон,
             max_user_id AS "аккаунт_MAX",
             archived_at AS в_архиве_с,
             updated_at AS изменён,
             full_name AS "ФИО"
        FROM residents
       ORDER BY id;

    CREATE VIEW квартиры AS
      SELECT id AS номер,
             resident_id AS номер_жителя,
             house_id AS номер_дома,
             entrance AS подъезд,
             floor AS этаж,
             apartment AS квартира,
             contract_number AS договор,
             created_at AS заведена,
             updated_at AS изменена
        FROM resident_premises
       ORDER BY id;

    CREATE VIEW дома AS
      SELECT id AS номер,
             address AS адрес,
             organization_id AS номер_УК,
             created_at AS заведён,
             street AS улица,
             number AS дом,
             chat_link AS ссылка_на_чат,
             invite_code AS "код_QR",
             emergency_phone AS телефон_АДС,
             has_gas AS есть_газ,
             timezone AS часовой_пояс
        FROM houses
       ORDER BY id;

    CREATE VIEW организации AS
      SELECT id AS номер,
             name AS название,
             type AS тип,
             phone AS телефон,
             created_at AS заведена
        FROM organizations
       ORDER BY id;

    CREATE VIEW организации_дома AS
      SELECT house_id AS номер_дома,
             role AS роль,
             organization_id AS номер_организации,
             CASE role
               WHEN 'water' THEN 'вода'
               WHEN 'heat' THEN 'тепло'
               WHEN 'electricity' THEN 'электричество'
               WHEN 'gas' THEN 'газ'
               ELSE role
             END AS роль_словами
        FROM house_organizations
       ORDER BY house_id, role;

    CREATE VIEW заявки AS
      SELECT id AS номер,
             resident_id AS номер_жителя,
             house_id AS номер_дома,
             problem_type AS тип,
             place AS место,
             status AS статус,
             assigned_organization_id AS номер_исполнителя,
             deadline_at AS срок,
             created_at AS подана,
             updated_at AS изменена,
             description AS описание,
             detail_code AS уточнение,
             rule_id AS правило,
             ${STATUS_WORDS('status')} AS статус_словами,
             CASE problem_type
               WHEN 'leak' THEN 'Протечка / потоп'
               WHEN 'blockage' THEN 'Засор'
               WHEN 'heating' THEN 'Нет отопления / холодно'
               WHEN 'electricity' THEN 'Электричество'
               WHEN 'elevator' THEN 'Лифт'
               WHEN 'common_area' THEN 'Подъезд / двор'
               WHEN 'structural' THEN 'Окна / двери / кровля'
               WHEN 'pests' THEN 'Насекомые / грызуны'
               WHEN 'meter_replacement' THEN 'Замена счётчиков ГВС/ХВС'
               WHEN 'meter_verification' THEN 'Услуга: поверка счётчика'
               WHEN 'radiator_replacement' THEN 'Услуга: замена батарей'
               WHEN 'other' THEN 'Другое / не уверен'
               WHEN 'gas_smell' THEN 'АВАРИЯ: запах газа'
               WHEN 'exposed_wiring' THEN 'АВАРИЯ: искрит проводка'
               WHEN 'flooding_threat' THEN 'АВАРИЯ: угроза затопления'
               WHEN 'elevator_entrapment' THEN 'АВАРИЯ: человек в лифте'
               ELSE problem_type
             END AS тип_словами
        FROM tickets
       ORDER BY id;

    CREATE VIEW история_заявок AS
      SELECT id AS номер,
             ticket_id AS номер_заявки,
             event_type AS событие,
             old_status AS был_статус,
             new_status AS стал_статус,
             created_at AS когда,
             CASE event_type::text
               WHEN 'created' THEN 'заявка создана'
               WHEN 'status_changed' THEN 'статус изменён'
               WHEN 'notified' THEN 'житель уведомлён'
             END AS событие_словами
        FROM ticket_events
       ORDER BY id;

    COMMENT ON VIEW заявки IS 'Заявки по-русски, столбцы в том же порядке, что в tickets. Сменить статус: UPDATE заявки SET статус = ''in_progress'' WHERE номер = 5';
  `);
};

// Откат — представления в виде 0010 (выборочные столбцы, без организации_дома).
exports.down = (pgm) => {
  pgm.sql(`
    ${DROP_ALL}

    CREATE VIEW жители AS
      SELECT id AS номер, full_name AS "ФИО", phone AS телефон,
             (max_user_id IS NOT NULL) AS вошёл_в_бота, archived_at AS в_архиве_с,
             created_at AS заведён, updated_at AS изменён
        FROM residents;

    CREATE VIEW квартиры AS
      SELECT id AS номер, resident_id AS номер_жителя, house_id AS номер_дома, entrance AS подъезд,
             floor AS этаж, apartment AS квартира, contract_number AS договор, created_at AS заведена
        FROM resident_premises;

    CREATE VIEW дома AS
      SELECT id AS номер, address AS адрес, organization_id AS номер_УК, chat_link AS ссылка_на_чат,
             emergency_phone AS телефон_АДС, has_gas AS есть_газ, timezone AS часовой_пояс,
             invite_code AS код_QR, created_at AS заведён
        FROM houses;

    CREATE VIEW организации AS
      SELECT id AS номер, name AS название, type AS тип, phone AS телефон FROM organizations;

    CREATE VIEW заявки AS
      SELECT id AS номер, resident_id AS номер_жителя, house_id AS номер_дома, status AS статус,
             ${STATUS_WORDS('status')} AS статус_словами,
             problem_type AS тип, problem_type AS тип_словами, place AS место, detail_code AS уточнение,
             description AS описание, rule_id AS правило, deadline_at AS срок,
             created_at AS подана, updated_at AS изменена
        FROM tickets;

    CREATE VIEW история_заявок AS
      SELECT id AS номер, ticket_id AS номер_заявки, event_type AS событие,
             CASE event_type::text
               WHEN 'created' THEN 'заявка создана'
               WHEN 'status_changed' THEN 'статус изменён'
               WHEN 'notified' THEN 'житель уведомлён'
             END AS событие_словами,
             old_status AS был_статус, new_status AS стал_статус, created_at AS когда
        FROM ticket_events;
  `);
};
