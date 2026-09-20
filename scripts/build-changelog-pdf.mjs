/**
 * Пересобирает docs/CHANGELOG.pdf из docs/changelog.html.
 *
 *   node scripts/build-changelog-pdf.mjs
 *
 * Использует уже установленный в системе Chrome или Edge в headless-режиме,
 * а не puppeteer: качать ещё один Chromium на 150+ МБ ради одного документа
 * в день — плохая сделка, особенно когда сборка образов ограничена по времени.
 *
 * Правится ТОЛЬКО docs/changelog.html; PDF — производный артефакт.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'docs/changelog.html');
const output = resolve(root, 'docs/CHANGELOG.pdf');

/** Типовые места установки Chrome/Edge по платформам. */
const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
};

function findBrowser() {
  const fromEnv = process.env.CHROME_PATH?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`CHROME_PATH указывает на несуществующий файл: ${fromEnv}`);
    }
    return fromEnv;
  }

  const found = (CANDIDATES[process.platform] ?? []).find((path) => existsSync(path));

  if (!found) {
    throw new Error(
      'Не найден Chrome или Edge.\n' +
        '  Укажи путь вручную: CHROME_PATH=/path/to/chrome node scripts/build-changelog-pdf.mjs',
    );
  }

  return found;
}

if (!existsSync(source)) {
  console.error(`Нет исходника: ${source}`);
  process.exit(1);
}

const browser = findBrowser();

execFileSync(
  browser,
  [
    '--headless',
    '--disable-gpu',
    // Иначе Chrome печатает свои колонтитулы с url и датой поверх вёрстки.
    '--no-pdf-header-footer',
    `--print-to-pdf=${output}`,
    pathToFileURL(source).href,
  ],
  { stdio: 'ignore' },
);

if (!existsSync(output)) {
  console.error('Chrome отработал, но PDF не появился.');
  process.exit(1);
}

console.log(`Готово: ${output}`);
console.log(`Браузер: ${browser}`);
