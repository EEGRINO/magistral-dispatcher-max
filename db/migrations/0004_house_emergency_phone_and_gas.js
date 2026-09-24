/**
 * Дому — телефон своей аварийной службы и признак газоснабжения. Согласовано
 * 24.09.2026 при переходе на модель Павла (config/rules.yaml).
 *
 * - emergency_phone — телефон АДС именно этого дома: его бот называет в
 *   экстренных инструкциях. NULL — телефона нет, бот называет 112.
 *   Текст, а не строгий формат: АДС бывают с городскими и короткими номерами.
 * - has_gas — есть ли в доме газ. false — бот не предлагает «Запах газа» в
 *   списке проблем (дома на электроплитах). По умолчанию true: для уже
 *   заведённых домов безопаснее показать лишнюю кнопку, чем спрятать нужную.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE houses
      ADD COLUMN emergency_phone TEXT,
      ADD COLUMN has_gas BOOLEAN NOT NULL DEFAULT true,
      ADD CONSTRAINT houses_emergency_phone_check CHECK (char_length(emergency_phone) BETWEEN 1 AND 32);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE houses
      DROP CONSTRAINT houses_emergency_phone_check,
      DROP COLUMN has_gas,
      DROP COLUMN emergency_phone;
  `);
};
