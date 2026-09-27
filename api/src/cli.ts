/**
 * Команда УК на сервере: дома и жители. Согласовано 24.09.2026.
 *
 *   docker compose exec api node dist/cli.js <команда>      (без аргументов — справка)
 *   docker compose exec -T api node dist/cli.js residents import - < жители.csv
 *
 * Работает через маршруты /admin того же api, а не напрямую с БД: проверки
 * (формат телефона, разбор адреса, архив) живут в одном месте, и будущая
 * веб-панель УК получит ровно то же поведение.
 *
 * Номера телефонов печатаются только в списке — это рабочий экран УК. В
 * сообщениях об ошибках импорта — номер строки файла, не номер телефона.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const HELP = `Дома, жители и заявки УК.

Дома:
  houses list
  houses add  --address "ул. Ленина, д. 5" [--chat https://…]
  houses edit <id> [--address "…"] [--chat https://… | --chat -]

Жители:
  residents list [--house <id>] [--phone <номер>] [--archived]
  residents add  --phone <номер> (--house <id> | --address "…")
                 [--name "Иванов Иван Иванович"]
                 [--entrance N] [--floor N] [--apartment 12А] [--contract <№>]
  residents edit <id> [те же поля, что у add]
  residents archive <id>
  residents import <файл.csv | -> [--dry-run]

Заявки:
  tickets list [--house <id>] [--active]
  tickets status <id> <принята | в_работе | решена | отменена>
                 Житель получит уведомление от бота в течение нескольких секунд.

Значение «-» стирает поле: --apartment -, --chat -.
Дом, подъезд, этаж, квартира и договор — основной квартиры жителя. Другие его
квартиры (в том числе в других домах) заводятся в pgAdmin: таблица resident_premises.
Смена телефона снимает привязку к MAX — житель войдёт в бота заново.
Архив вместо удаления: войти нельзя, заявки жителя остаются.

CSV: первая строка — заголовки. Обязательны «телефон» и «адрес»; по желанию
«ФИО», «подъезд», «этаж», «квартира», «договор». Разделитель «;» или «,», кодировка
UTF-8 или Windows-1251 (так сохраняет Excel). Жители из файла заводятся или
обновляются по телефону; пустая ячейка значение не меняет, «-» — стирает.
Кого нет в файле — не трогаются. Дома должны быть заведены заранее (houses add).
Сначала --dry-run: проверит файл, ничего не записав.`;

class CliError extends Error {}

// ── api ────────────────────────────────────────────────────────────────

const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string; details?: string[] } }
    | null;

  if (!response.ok) {
    const error = json?.error;
    const details = error?.details?.length ? ` (${error.details.join('; ')})` : '';
    throw new CliError(`${error?.message ?? `HTTP ${response.status}`}${details} [${error?.code ?? response.status}]`);
  }
  return json as T;
}

interface House {
  id: number;
  address: string;
  chat_link: string | null;
  invite_code: string;
  residents: number;
}

interface Resident {
  id: number;
  phone: string;
  full_name: string | null;
  house_id: number | null;
  house_address: string | null;
  entrance: number | null;
  floor: number | null;
  apartment: string | null;
  contract_number: string | null;
  premises_count: number;
  max_linked: boolean;
  archived_at: string | null;
}

// ── разбор значений ────────────────────────────────────────────────────

/** Любой ввод → +7XXXXXXXXXX; null, если это не 10 цифр после +7/8. */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`;
  return null;
}

function phoneArg(raw: string): string {
  const phone = normalizePhone(raw);
  if (!phone) throw new CliError('Телефон не похож на номер из 10 цифр после +7');
  return phone;
}

function idArg(raw: string | undefined, what: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new CliError(`Нужен id ${what}: целое число`);
  return id;
}

/** «-» — стереть (null), иначе целое число. */
function intOrClear(raw: string, name: string): number | null {
  if (raw === '-') return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new CliError(`${name}: нужно целое число или «-»`);
  return value;
}

const textOrClear = (raw: string): string | null => (raw === '-' ? null : raw.trim());

async function houseIdByAddress(address: string): Promise<number> {
  const query = new URLSearchParams({ address });
  const { houses } = await call<{ houses: House[] }>('GET', `/admin/houses?${query}`);
  const house = houses[0];
  if (!house) throw new CliError('Дом с таким адресом не заведён — сначала houses add');
  return house.id;
}

// ── вывод ──────────────────────────────────────────────────────────────

function printHouse(house: House): void {
  console.log(
    `#${house.id}  ${house.address}\n` +
      `     жителей: ${house.residents}   чат: ${house.chat_link ?? '—'}   код QR: ${house.invite_code}`,
  );
}

function printResident(r: Resident): void {
  const place = [
    r.entrance !== null ? `под. ${r.entrance}` : null,
    r.floor !== null ? `эт. ${r.floor}` : null,
    r.apartment !== null ? `кв. ${r.apartment}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  console.log(
    `#${r.id}  ${r.phone}${r.full_name ? `  ${r.full_name}` : ''}  ${r.house_address ?? 'дом не указан'}${place ? `, ${place}` : ''}` +
      (r.premises_count > 1 ? `   (+${r.premises_count - 1} кв. — в pgAdmin, resident_premises)` : '') +
      '\n' +
      `     договор: ${r.contract_number ?? '—'}   вошёл в бота: ${r.max_linked ? 'да' : 'нет'}` +
      (r.archived_at ? `   В АРХИВЕ с ${r.archived_at.slice(0, 10)}` : ''),
  );
}

// ── поля жителя из аргументов ──────────────────────────────────────────

type Values = Record<string, string | boolean | undefined>;

async function residentFields(values: Values): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  const str = (name: string) => (typeof values[name] === 'string' ? (values[name] as string) : undefined);

  if (str('house') !== undefined && str('address') !== undefined) {
    throw new CliError('Укажите дом одним способом: --house или --address');
  }
  const house = str('house');
  if (house !== undefined) fields.house_id = house === '-' ? null : idArg(house, 'дома');
  const address = str('address');
  if (address !== undefined) fields.house_id = await houseIdByAddress(address);

  const entrance = str('entrance');
  if (entrance !== undefined) fields.entrance = intOrClear(entrance, 'Подъезд');
  const floor = str('floor');
  if (floor !== undefined) fields.floor = intOrClear(floor, 'Этаж');
  const apartment = str('apartment');
  if (apartment !== undefined) fields.apartment = textOrClear(apartment);
  const contract = str('contract');
  if (contract !== undefined) fields.contract_number = textOrClear(contract);
  const name = str('name');
  if (name !== undefined) fields.full_name = textOrClear(name);

  return fields;
}

// ── заявки ─────────────────────────────────────────────────────────────

interface AdminTicket {
  id: number;
  house_address: string | null;
  problem_type: string;
  place: string | null;
  description: string | null;
  rule_id: string | null;
  status: 'new' | 'in_progress' | 'resolved' | 'cancelled';
  responsible_name: string | null;
  created_at: string;
}

const STATUS_RU = { new: 'принята', in_progress: 'в работе', resolved: 'решена', cancelled: 'отменена' } as const;

/** Статус из командной строки: коды api и русские слова. */
const STATUS_ARG: Record<string, keyof typeof STATUS_RU> = {
  new: 'new', принята: 'new',
  in_progress: 'in_progress', в_работе: 'in_progress', 'в-работе': 'in_progress', работа: 'in_progress',
  resolved: 'resolved', решена: 'resolved', решено: 'resolved',
  cancelled: 'cancelled', отменена: 'cancelled',
};

function printTicket(t: AdminTicket): void {
  console.log(
    `#${t.id}  [${STATUS_RU[t.status]}]  ${t.problem_type}${t.place ? ` · ${t.place}` : ''}  ${t.created_at.slice(0, 10)}\n` +
      `     ${t.house_address ?? 'дом не указан'}   ответственный: ${t.responsible_name ?? '—'}   правило: ${t.rule_id ?? '—'}` +
      (t.description ? `\n     «${t.description}»` : ''),
  );
}

// ── CSV ────────────────────────────────────────────────────────────────

/** Excel в русской локали сохраняет CSV в Windows-1251; пробуем UTF-8 строго. */
function decode(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1251').decode(buffer);
  }
}

/** Минимальный CSV: кавычки, "" внутри кавычек, переводы строк внутри кавычек. */
function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = [';', ',', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Пустые строки (в том числе хвостовые от Excel) пропускаем.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADERS: Record<string, string> = {
  телефон: 'phone', phone: 'phone',
  адрес: 'address', address: 'address',
  подъезд: 'entrance', entrance: 'entrance',
  этаж: 'floor', floor: 'floor',
  квартира: 'apartment', кв: 'apartment', apartment: 'apartment',
  договор: 'contract', '№ договора': 'contract', 'номер договора': 'contract', contract: 'contract',
  фио: 'name', 'ф.и.о': 'name', 'ф. и. о': 'name', имя: 'name', name: 'name', full_name: 'name',
};

async function importResidents(source: string, dryRun: boolean): Promise<void> {
  const rows = parseCsv(decode(source === '-' ? readFileSync(0) : readFileSync(source)));
  const header = rows.shift();
  if (!header) throw new CliError('Файл пуст');

  const columns = header.map((name) => HEADERS[name.trim().toLowerCase().replace(/\.$/, '')]);
  if (!columns.includes('phone') || !columns.includes('address')) {
    throw new CliError('В первой строке нужны столбцы «телефон» и «адрес»');
  }

  const houseCache = new Map<string, number | string>(); // адрес → id дома или текст ошибки
  const seen = new Map<string, number>(); // телефон → строка файла
  const errors: string[] = [];
  let created = 0;
  let updated = 0;

  for (const [index, cells] of rows.entries()) {
    const line = index + 2; // +1 заголовок, +1 нумерация с единицы
    const get = (field: string) => {
      const at = columns.indexOf(field);
      const value = at === -1 ? '' : (cells[at] ?? '').trim();
      return value === '' ? undefined : value;
    };

    try {
      const phone = normalizePhone(get('phone') ?? '');
      if (!phone) throw new CliError('телефон не похож на номер из 10 цифр после +7');
      const earlier = seen.get(phone);
      if (earlier !== undefined) throw new CliError(`этот телефон уже был в строке ${earlier}`);
      seen.set(phone, line);

      const address = get('address');
      if (!address) throw new CliError('пустой адрес');
      if (!houseCache.has(address)) {
        try {
          houseCache.set(address, await houseIdByAddress(address));
        } catch (error) {
          houseCache.set(address, error instanceof Error ? error.message : String(error));
        }
      }
      const house = houseCache.get(address)!;
      if (typeof house === 'string') throw new CliError(house);

      const fields: Record<string, unknown> = { house_id: house };
      const entrance = get('entrance');
      if (entrance !== undefined) fields.entrance = intOrClear(entrance, 'подъезд');
      const floor = get('floor');
      if (floor !== undefined) fields.floor = intOrClear(floor, 'этаж');
      const apartment = get('apartment');
      if (apartment !== undefined) fields.apartment = textOrClear(apartment);
      const contract = get('contract');
      if (contract !== undefined) fields.contract_number = textOrClear(contract);
      const name = get('name');
      if (name !== undefined) fields.full_name = textOrClear(name);

      const query = new URLSearchParams({ phone });
      const { residents } = await call<{ residents: Resident[] }>('GET', `/admin/residents?${query}`);
      const existing = residents[0];

      if (existing) {
        if (!dryRun) await call('PATCH', `/admin/residents/${existing.id}`, fields);
        updated += 1;
      } else {
        if (!dryRun) await call('POST', '/admin/residents', { phone, ...fields });
        created += 1;
      }
    } catch (error) {
      errors.push(`строка ${line}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const verb = dryRun ? 'Будет' : 'Готово';
  console.log(`${verb}: новых жителей ${created}, обновлённых ${updated}, строк с ошибками ${errors.length}.`);
  for (const message of errors) console.log(`  ${message}`);
  if (dryRun) console.log('Проверка (--dry-run): ничего не записано.');
  if (errors.length > 0) process.exitCode = 1;
}

// ── команды ────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      address: { type: 'string' },
      chat: { type: 'string' },
      phone: { type: 'string' },
      house: { type: 'string' },
      entrance: { type: 'string' },
      floor: { type: 'string' },
      apartment: { type: 'string' },
      contract: { type: 'string' },
      name: { type: 'string' },
      archived: { type: 'boolean' },
      active: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [area, action, target] = positionals;
  const command = `${area ?? ''} ${action ?? ''}`.trim();

  switch (command) {
    case 'houses list': {
      const { houses } = await call<{ houses: House[] }>('GET', '/admin/houses');
      if (houses.length === 0) console.log('Домов нет.');
      houses.forEach(printHouse);
      return;
    }

    case 'houses add': {
      if (!values.address) throw new CliError('Нужен --address');
      const body: Record<string, unknown> = { address: values.address };
      if (values.chat !== undefined) body.chat_link = textOrClear(values.chat);
      const { house } = await call<{ house: House }>('POST', '/admin/houses', body);
      printHouse(house);
      return;
    }

    case 'houses edit': {
      const body: Record<string, unknown> = {};
      if (values.address !== undefined) body.address = values.address;
      if (values.chat !== undefined) body.chat_link = textOrClear(values.chat);
      if (Object.keys(body).length === 0) throw new CliError('Нечего менять: --address и/или --chat');
      const { house } = await call<{ house: House }>('PATCH', `/admin/houses/${idArg(target, 'дома')}`, body);
      printHouse(house);
      return;
    }

    case 'residents list': {
      const query = new URLSearchParams();
      if (values.house !== undefined) query.set('house_id', String(idArg(values.house, 'дома')));
      if (values.phone !== undefined) query.set('phone', phoneArg(values.phone));
      if (values.archived) query.set('include_archived', 'true');
      const { residents } = await call<{ residents: Resident[] }>('GET', `/admin/residents?${query}`);
      if (residents.length === 0) console.log('Жителей не найдено.');
      residents.forEach(printResident);
      return;
    }

    case 'residents add': {
      if (!values.phone) throw new CliError('Нужен --phone');
      const body = { phone: phoneArg(values.phone), ...(await residentFields(values)) };
      const { resident } = await call<{ resident: Resident }>('POST', '/admin/residents', body);
      printResident(resident);
      return;
    }

    case 'residents edit': {
      const id = idArg(target, 'жителя');
      const body = await residentFields(values);
      if (values.phone !== undefined) body.phone = phoneArg(values.phone);
      if (Object.keys(body).length === 0) throw new CliError('Нечего менять — см. справку');
      const { resident } = await call<{ resident: Resident }>('PATCH', `/admin/residents/${id}`, body);
      printResident(resident);
      if (values.phone !== undefined) console.log('Телефон изменён: привязка к MAX снята, житель войдёт заново.');
      return;
    }

    case 'residents archive': {
      const id = idArg(target, 'жителя');
      const { resident } = await call<{ resident: Resident }>('POST', `/admin/residents/${id}/archive`);
      printResident(resident);
      return;
    }

    case 'tickets list': {
      const query = new URLSearchParams();
      if (values.house !== undefined) query.set('house_id', String(idArg(values.house, 'дома')));
      if (values.active) query.set('active', 'true');
      const { tickets } = await call<{ tickets: AdminTicket[] }>('GET', `/admin/tickets?${query}`);
      if (tickets.length === 0) console.log('Заявок нет.');
      tickets.forEach(printTicket);
      return;
    }

    case 'tickets status': {
      const id = idArg(target, 'заявки');
      const status = STATUS_ARG[(positionals[3] ?? '').toLowerCase()];
      if (!status) throw new CliError('Новый статус: принята, в_работе или решена');
      const result = await call<{ ticket: AdminTicket; changed: boolean }>('POST', `/admin/tickets/${id}/status`, {
        status,
      });
      printTicket(result.ticket);
      console.log(result.changed ? 'Статус изменён — житель получит уведомление.' : 'Статус уже был таким — ничего не изменилось.');
      return;
    }

    case 'residents import': {
      if (!target) throw new CliError('Нужен путь к CSV или «-» для чтения из stdin');
      await importResidents(target, values['dry-run'] === true);
      return;
    }

    default:
      console.log(HELP);
      if (command !== '' && !values.help) process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CliError || (error instanceof TypeError && 'code' in error)) {
    console.error(`Ошибка: ${error.message}`);
  } else if (error instanceof TypeError) {
    // fetch не достучался до api — чаще всего контейнер api не запущен.
    console.error(`api недоступен по ${base}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
