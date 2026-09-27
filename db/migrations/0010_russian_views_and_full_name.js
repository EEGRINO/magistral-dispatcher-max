/**
 * ФИО жителя и русские названия для работы УК в pgAdmin. Согласовано 27.09.2026.
 *
 * - residents.full_name — ФИО жителя, необязательное, 1–200 символов, любые
 *   буквы (кириллица и латиница). Персональные данные: в логи не пишется,
 *   жителю в боте и мини-аппе не показывается.
 * - Русские представления (VIEW) — «зеркала» таблиц с русскими именами
 *   столбцов: жители, квартиры, дома, организации, заявки, история_заявок.
 *   Таблицы и их английские столбцы не меняются: на них написан весь SQL api
 *   и бота. Представления простые (одна таблица, без группировок), поэтому
 *   PostgreSQL пропускает через них и UPDATE/INSERT/DELETE — в SQL-запросе
 *   можно писать по-русски. Столбцы «…_словами» — только для чтения.
 * - Русские подсказки (COMMENT) к таблицам и столбцам — pgAdmin показывает их
 *   в свойствах.
 *
 * Имена с заглавными буквами и цифрами пишутся в кавычках: SELECT "ФИО" FROM жители.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE residents
      ADD COLUMN full_name TEXT,
      ADD CONSTRAINT residents_full_name_check CHECK (char_length(btrim(full_name)) BETWEEN 1 AND 200);

    -- ── подсказки к таблицам и столбцам ──
    COMMENT ON TABLE residents IS 'Жители: человек — телефон и аккаунт MAX. Квартиры — в resident_premises. По-русски — представление «жители»';
    COMMENT ON COLUMN residents.full_name IS 'ФИО жителя (необязательно; кириллица или латиница)';
    COMMENT ON COLUMN residents.phone IS 'Телефон +7XXXXXXXXXX — по нему житель входит в бота';
    COMMENT ON COLUMN residents.max_user_id IS 'Аккаунт MAX (заполняет бот при входе)';
    COMMENT ON COLUMN residents.max_chat_id IS 'Диалог с ботом в MAX (заполняет бот при входе)';
    COMMENT ON COLUMN residents.archived_at IS 'Когда убран в архив; пусто — действующий';

    COMMENT ON TABLE resident_premises IS 'Квартиры жителей: дом, подъезд, этаж, квартира, договор. По-русски — «квартиры»';
    COMMENT ON TABLE houses IS 'Дома УК. По-русски — «дома»';
    COMMENT ON COLUMN houses.chat_link IS 'Ссылка на чат дома в MAX';
    COMMENT ON COLUMN houses.emergency_phone IS 'Телефон аварийной службы дома; пусто — бот называет 112';
    COMMENT ON COLUMN houses.invite_code IS 'Код дома для QR-ссылки на бота';
    COMMENT ON COLUMN houses.timezone IS 'Часовой пояс дома, например Europe/Moscow';

    COMMENT ON TABLE tickets IS 'Заявки жителей. По-русски — «заявки»';
    COMMENT ON COLUMN tickets.status IS 'Статус: new — принята, in_progress — в работе, resolved — решена, cancelled — отменена. Смена статуса = уведомление жителю';
    COMMENT ON COLUMN tickets.detail_code IS 'Уточнение жителя: moderate, valve, kitchen_hot, rooms_two и т.п.';
    COMMENT ON COLUMN tickets.rule_id IS 'Правило config/rules.yaml, по которому направлена заявка';

    COMMENT ON TABLE ticket_events IS 'История заявок, только добавляется: created — создана (api), status_changed — статус изменён (триггер), notified — житель уведомлён (бот). Руками не править. По-русски — «история_заявок»';

    -- ── русские представления ──
    CREATE VIEW жители AS
      SELECT id AS номер,
             full_name AS "ФИО",
             phone AS телефон,
             (max_user_id IS NOT NULL) AS вошёл_в_бота,
             archived_at AS в_архиве_с,
             created_at AS заведён,
             updated_at AS изменён
        FROM residents;

    CREATE VIEW квартиры AS
      SELECT id AS номер,
             resident_id AS номер_жителя,
             house_id AS номер_дома,
             entrance AS подъезд,
             floor AS этаж,
             apartment AS квартира,
             contract_number AS договор,
             created_at AS заведена
        FROM resident_premises;

    CREATE VIEW дома AS
      SELECT id AS номер,
             address AS адрес,
             organization_id AS номер_УК,
             chat_link AS ссылка_на_чат,
             emergency_phone AS телефон_АДС,
             has_gas AS есть_газ,
             timezone AS часовой_пояс,
             invite_code AS код_QR,
             created_at AS заведён
        FROM houses;

    CREATE VIEW организации AS
      SELECT id AS номер,
             name AS название,
             type AS тип,
             phone AS телефон
        FROM organizations;

    CREATE VIEW заявки AS
      SELECT id AS номер,
             resident_id AS номер_жителя,
             house_id AS номер_дома,
             status AS статус,
             CASE status
               WHEN 'new' THEN 'принята'
               WHEN 'in_progress' THEN 'в работе'
               WHEN 'resolved' THEN 'решена'
               WHEN 'cancelled' THEN 'отменена'
             END AS статус_словами,
             problem_type AS тип,
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
             END AS тип_словами,
             place AS место,
             detail_code AS уточнение,
             description AS описание,
             rule_id AS правило,
             deadline_at AS срок,
             created_at AS подана,
             updated_at AS изменена
        FROM tickets;

    CREATE VIEW история_заявок AS
      SELECT id AS номер,
             ticket_id AS номер_заявки,
             event_type AS событие,
             CASE event_type
               WHEN 'created' THEN 'заявка создана'
               WHEN 'status_changed' THEN 'статус изменён'
               WHEN 'notified' THEN 'житель уведомлён'
             END AS событие_словами,
             old_status AS был_статус,
             new_status AS стал_статус,
             created_at AS когда
        FROM ticket_events;

    COMMENT ON VIEW заявки IS 'Заявки по-русски. Сменить статус: UPDATE заявки SET статус = ''in_progress'' WHERE номер = 5';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW история_заявок;
    DROP VIEW заявки;
    DROP VIEW организации;
    DROP VIEW дома;
    DROP VIEW квартиры;
    DROP VIEW жители;

    COMMENT ON TABLE residents IS NULL;
    COMMENT ON TABLE resident_premises IS NULL;
    COMMENT ON TABLE houses IS NULL;
    COMMENT ON TABLE tickets IS NULL;
    COMMENT ON TABLE ticket_events IS NULL;
    COMMENT ON COLUMN residents.phone IS NULL;
    COMMENT ON COLUMN residents.max_user_id IS NULL;
    COMMENT ON COLUMN residents.max_chat_id IS NULL;
    COMMENT ON COLUMN residents.archived_at IS NULL;
    COMMENT ON COLUMN houses.chat_link IS NULL;
    COMMENT ON COLUMN houses.emergency_phone IS NULL;
    COMMENT ON COLUMN houses.invite_code IS NULL;
    COMMENT ON COLUMN houses.timezone IS NULL;
    COMMENT ON COLUMN tickets.status IS NULL;
    COMMENT ON COLUMN tickets.detail_code IS NULL;
    COMMENT ON COLUMN tickets.rule_id IS NULL;

    ALTER TABLE residents DROP COLUMN full_name;
  `);
};
