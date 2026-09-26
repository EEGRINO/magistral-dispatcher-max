/**
 * ╔════════════════════════════════════════════════════════════════════╗
 * ║  ТЕСТОВЫЕ ДАННЫЕ. НЕ ДЛЯ ПРОДАКШЕНА.                               ║
 * ║  Организации и дома ниже — выдуманные, обезличенные: взяты из      ║
 * ║  houses.json Павла (24.09.2026), г. Заречный, 8 домов, 3 из них    ║
 * ║  на электроплитах. Настоящие дома заводит УК командой на сервере.  ║
 * ╚════════════════════════════════════════════════════════════════════╝
 *
 * Запуск:  npm run seed          (нужен DATABASE_URL в окружении)
 * В Docker: docker compose run --rm migrate npm run seed
 *
 * Скрипт идемпотентен: повторный запуск ничего не дублирует
 * (ON CONFLICT DO NOTHING по уникальным name / address / phone).
 *
 * Из окружения (.env), чтобы в git не попали настоящие номера и ссылки:
 *   SEED_TEST_PHONES      — номера тестовых жителей через запятую, в любом
 *                           виде: +7XXXXXXXXXX, 8 XXX XXX-XX-XX, XXXXXXXXXX.
 *                           Все жители привязываются к первому тестовому дому.
 *   SEED_HOUSE_CHAT_LINK  — ссылка на тестовый чат для первого дома (https://…).
 * Обе необязательны: без них загрузятся только организации и дома.
 *
 * Намеренно НЕ запускается автоматически при `docker compose up`:
 * данные помечены как тестовые, и подсовывать их молча в любую БД,
 * которую поднимут этой командой, — плохая идея.
 */

const { Client } = require('pg');

/**
 * Выдуманные организации из houses.json Павла. Телефоны — несуществующие
 * (+7 900 000-…). ТСЖ заведено с типом «УК»: в схеме тип организации —
 * УК / АДС / РСО, а ТСЖ по роли — та же управляющая организация дома.
 * ГЖИ (инспекция) не заводим: в маршрутизации заявок она не участвует.
 */
const ORGANIZATIONS = [
  { name: 'ООО «УК Маяк»', type: 'УК', phone: '+7 900 000-00-01' },
  { name: 'ООО «УК Солнечная»', type: 'УК', phone: '+7 900 000-00-02' },
  { name: 'ТСЖ «Берега»', type: 'УК', phone: '+7 900 000-00-03' },
  { name: 'Аварийно-диспетчерская служба №1', type: 'АДС', phone: '+7 900 111-00-01' },
  { name: 'Аварийно-диспетчерская служба №2', type: 'АДС', phone: '+7 900 111-00-02' },
  { name: 'МУП «Водоканал»', type: 'РСО', phone: '+7 900 222-00-01' },
  { name: 'АО «Теплосеть»', type: 'РСО', phone: '+7 900 222-00-02' },
  { name: 'ПАО «Энергосбыт»', type: 'РСО', phone: '+7 900 222-00-03' },
  { name: 'АО «Газораспределение»', type: 'РСО', phone: '+7 900 222-00-04' },
];

const ADS_1 = '+7 900 111-00-01';
const ADS_2 = '+7 900 111-00-02';

/**
 * Дома из houses.json Павла. street/number — в нормализованном виде (нижний
 * регистр, без «ул.», ё → е), как их хранит схема: так их найдёт ручной ввод.
 * emergency_phone — телефон АДС дома (ads_id), has_gas — rso.gas не null.
 */
const HOUSES = [
  { address: 'г. Заречный, ул. Полевая, д. 5', street: 'полевая', number: '5', organization: 'ООО «УК Маяк»', emergencyPhone: ADS_1, hasGas: true },
  { address: 'г. Заречный, ул. Полевая, д. 7', street: 'полевая', number: '7', organization: 'ООО «УК Маяк»', emergencyPhone: ADS_1, hasGas: true },
  { address: 'г. Заречный, ул. Солнечная, д. 12', street: 'солнечная', number: '12', organization: 'ООО «УК Солнечная»', emergencyPhone: ADS_2, hasGas: true },
  { address: 'г. Заречный, пр-т Мира, д. 21', street: 'мира', number: '21', organization: 'ООО «УК Солнечная»', emergencyPhone: ADS_2, hasGas: true },
  { address: 'г. Заречный, ул. Луговая, д. 3', street: 'луговая', number: '3', organization: 'ТСЖ «Берега»', emergencyPhone: ADS_1, hasGas: false },
  { address: 'г. Заречный, ул. Берёзовая, д. 9', street: 'березовая', number: '9', organization: 'ТСЖ «Берега»', emergencyPhone: ADS_2, hasGas: false },
  { address: 'г. Заречный, ул. Заводская, д. 14', street: 'заводская', number: '14', organization: 'ООО «УК Маяк»', emergencyPhone: ADS_1, hasGas: true },
  { address: 'г. Заречный, ул. Новая, д. 2', street: 'новая', number: '2', organization: 'ООО «УК Солнечная»', emergencyPhone: ADS_2, hasGas: false },
];

/**
 * РСО домов по ролям (houses.json Павла → rso). У всех восьми домов одни и те
 * же водоканал, теплосеть и энергосбыт; газовая — только у домов с газом.
 */
const RSO = {
  water: 'МУП «Водоканал»',
  heat: 'АО «Теплосеть»',
  electricity: 'ПАО «Энергосбыт»',
  gas: 'АО «Газораспределение»',
};

/** Любой ввод → +7XXXXXXXXXX; null, если это не российский мобильный из 10 цифр. */
function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`;
  return null;
}

function readTestPhones() {
  const raw = process.env.SEED_TEST_PHONES?.trim();
  if (!raw) return [];

  return raw.split(',').map((item) => {
    const phone = normalizePhone(item);
    if (!phone) {
      // Сам номер в сообщение не выводим: это персональные данные.
      throw new Error('SEED_TEST_PHONES: одно из значений не похоже на номер из 10 цифр после +7');
    }
    return phone;
  });
}

function readChatLink() {
  const link = process.env.SEED_HOUSE_CHAT_LINK?.trim();
  if (!link) return null;
  if (!link.startsWith('https://')) {
    throw new Error('SEED_HOUSE_CHAT_LINK должен начинаться с https://');
  }
  return link;
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED_IN_PRODUCTION !== '1') {
    console.error(
      'Отказ: NODE_ENV=production, а это тестовые данные.\n' +
        'Если это осознанное решение — ALLOW_SEED_IN_PRODUCTION=1.',
    );
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL не задан.');
    process.exit(1);
  }

  // Разбираем окружение до подключения: ошибка в .env не должна оставлять
  // полузагруженную базу.
  const testPhones = readTestPhones();
  const chatLink = readChatLink();

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');

    for (const org of ORGANIZATIONS) {
      await client.query(
        `INSERT INTO organizations (name, type, phone)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO NOTHING`,
        [org.name, org.type, org.phone],
      );
    }

    // DO UPDATE: дома, загруженные seed'ом раньше, уже есть в базе без полей
    // из поздних миграций (street/number — 0002, телефон АДС и газ — 0004).
    for (const house of HOUSES) {
      await client.query(
        `INSERT INTO houses (address, street, number, organization_id, emergency_phone, has_gas)
         VALUES (
           $1, $2, $3,
           (SELECT id FROM organizations WHERE name = $4),
           $5, $6
         )
         ON CONFLICT (address) DO UPDATE
           SET street = EXCLUDED.street, number = EXCLUDED.number,
               emergency_phone = EXCLUDED.emergency_phone, has_gas = EXCLUDED.has_gas`,
        [house.address, house.street, house.number, house.organization, house.emergencyPhone, house.hasGas],
      );
    }

    // РСО дома — для маршрутизации: ответственный rso_* из config/rules.yaml.
    for (const house of HOUSES) {
      for (const [role, organization] of Object.entries(RSO)) {
        if (role === 'gas' && !house.hasGas) continue;
        await client.query(
          `INSERT INTO house_organizations (house_id, role, organization_id)
           VALUES (
             (SELECT id FROM houses WHERE address = $1), $2,
             (SELECT id FROM organizations WHERE name = $3)
           )
           ON CONFLICT (house_id, role) DO UPDATE SET organization_id = EXCLUDED.organization_id`,
          [house.address, role, organization],
        );
      }
    }

    const firstHouse = HOUSES[0].address;

    if (chatLink) {
      await client.query('UPDATE houses SET chat_link = $1 WHERE address = $2', [chatLink, firstHouse]);
    }

    // Квартира — отдельной строкой в resident_premises (0009). Житель, уже
    // заведённый раньше, получает квартиру в первом доме, только если квартир
    // у него нет вовсе: заведённые руками в pgAdmin seed не трогает.
    for (const phone of testPhones) {
      await client.query(
        `INSERT INTO residents (phone) VALUES ($1)
         ON CONFLICT (phone) WHERE archived_at IS NULL DO NOTHING`,
        [phone],
      );
      await client.query(
        `INSERT INTO resident_premises (resident_id, house_id)
         SELECT r.id, (SELECT id FROM houses WHERE address = $2)
           FROM residents r
          WHERE r.phone = $1 AND r.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM resident_premises p WHERE p.resident_id = r.id)`,
        [phone, firstHouse],
      );
    }

    await client.query('COMMIT');

    const { rows } = await client.query(
      `SELECT
         (SELECT count(*) FROM organizations) AS organizations,
         (SELECT count(*) FROM houses)        AS houses,
         (SELECT count(*) FROM residents)     AS residents`,
    );

    console.log('Тестовые данные загружены.');
    console.log(`  organizations: ${rows[0].organizations}`);
    console.log(`  houses:        ${rows[0].houses}`);
    console.log(`  residents:     ${rows[0].residents}`);
    console.log(`  чат дома:      ${chatLink ? 'задан для первого дома' : 'не задан (SEED_HOUSE_CHAT_LINK пуст)'}`);
    console.log('');
    console.log('Напоминание: это ТЕСТОВЫЕ данные, не продакшен-справочник.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Seed не выполнен:', error.message);
  process.exit(1);
});
