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
 * (ON CONFLICT DO NOTHING по уникальным name / address).
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

/** Дома с привязкой к УК по имени организации. */
const HOUSES = [
  { address: 'г. Тестоград, ул. Примерная, д. 1', organization: 'УК «Тестовая Жилищная»' },
  { address: 'г. Тестоград, ул. Примерная, д. 3', organization: 'УК «Тестовая Жилищная»' },
  { address: 'г. Тестоград, пр-т Образцовый, д. 12', organization: null },
];

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

    for (const house of HOUSES) {
      await client.query(
        `INSERT INTO houses (address, organization_id)
         VALUES (
           $1,
           (SELECT id FROM organizations WHERE name = $2)
         )
         ON CONFLICT (address) DO NOTHING`,
        [house.address, house.organization],
      );
    }

    await client.query('COMMIT');

    const { rows } = await client.query(
      `SELECT
         (SELECT count(*) FROM organizations) AS organizations,
         (SELECT count(*) FROM houses)        AS houses`,
    );

    console.log('Тестовые данные загружены.');
    console.log(`  organizations: ${rows[0].organizations}`);
    console.log(`  houses:        ${rows[0].houses}`);
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
