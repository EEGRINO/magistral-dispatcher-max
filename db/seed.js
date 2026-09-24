/**
 * ╔════════════════════════════════════════════════════════════════════╗
 * ║  ТЕСТОВЫЕ ДАННЫЕ. НЕ ДЛЯ ПРОДАКШЕНА.                               ║
 * ║  Организации и дома ниже — выдуманные, для локальной проверки      ║
 * ║  сквозного прохода. Настоящие справочники приедут из config/       ║
 * ║  (houses.json, rules.yaml) — это зона Павла.                       ║
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

/** Выдуманные организации. Телефоны — из диапазона 555, несуществующие. */
const ORGANIZATIONS = [
  { name: 'УК «Тестовая Жилищная»', type: 'УК', phone: '+7 495 555-01-01' },
  { name: 'АДС «Тестовая Аварийная»', type: 'АДС', phone: '+7 495 555-02-02' },
  { name: 'РСО «Тестводоканал»', type: 'РСО', phone: '+7 495 555-03-03' },
];

/**
 * Дома с привязкой к УК по имени организации. street/number — в нормализованном
 * виде (нижний регистр, без «ул.»), как их хранит схема: так их найдёт ручной ввод.
 */
const HOUSES = [
  { address: 'г. Тестоград, ул. Примерная, д. 1', street: 'примерная', number: '1', organization: 'УК «Тестовая Жилищная»' },
  { address: 'г. Тестоград, ул. Примерная, д. 3', street: 'примерная', number: '3', organization: 'УК «Тестовая Жилищная»' },
  { address: 'г. Тестоград, пр-т Образцовый, д. 12', street: 'образцовый', number: '12', organization: null },
];

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

    // DO UPDATE для street/number: дома, загруженные seed'ом до миграции 0002,
    // уже есть в базе без этих полей — иначе они так и остались бы пустыми.
    for (const house of HOUSES) {
      await client.query(
        `INSERT INTO houses (address, street, number, organization_id)
         VALUES (
           $1, $2, $3,
           (SELECT id FROM organizations WHERE name = $4)
         )
         ON CONFLICT (address) DO UPDATE
           SET street = EXCLUDED.street, number = EXCLUDED.number`,
        [house.address, house.street, house.number, house.organization],
      );
    }

    const firstHouse = HOUSES[0].address;

    if (chatLink) {
      await client.query('UPDATE houses SET chat_link = $1 WHERE address = $2', [chatLink, firstHouse]);
    }

    for (const phone of testPhones) {
      await client.query(
        `INSERT INTO residents (phone, house_id)
         VALUES ($1, (SELECT id FROM houses WHERE address = $2))
         ON CONFLICT (phone) DO NOTHING`,
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
