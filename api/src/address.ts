/**
 * Разбор адреса, введённого жителем руками, в пару (улица, номер дома) — в том
 * же нормализованном виде, в каком адрес хранится в houses.street/number
 * (миграция 0002). Тогда поиск дома — точное равенство, а не сравнение строк
 * «на глаз».
 *
 * Правило (согласовано 24.09.2026): нижний регистр, ё → е, без знаков
 * препинания, без типов улиц и «д./дом»; номер — последнее слово с цифрой.
 * «ул. Ленина, д. 5», «Ленина 5» и «ЛЕНИНА д5» дают одно и то же.
 *
 * Известное ограничение: номер ищется как ПОСЛЕДНЕЕ слово с цифрой, поэтому
 * улица с цифрой в названии без номера дома («8 Марта») даст пустую улицу и
 * будет отклонена, а не угадана. Корпус/строение склеиваются с номером (5к2).
 */

/** Типы улиц и слово «дом» — выбрасываются, в хранимом адресе их нет. */
const NOISE = new Set([
  'ул', 'улица', 'пр', 'пр-т', 'пр-кт', 'просп', 'проспект', 'пер', 'переулок',
  'б-р', 'бульвар', 'ш', 'шоссе', 'пл', 'площадь', 'наб', 'набережная',
  'проезд', 'туп', 'тупик', 'аллея', 'мкр', 'микрорайон', 'д', 'дом',
]);

/** Слова, после которых идёт уже не адрес дома: подъезд, квартира, этаж. */
const TAIL = new Set(['подъезд', 'под', 'п', 'кв', 'квартира', 'эт', 'этаж']);

/** «г. Тестоград» — город вместе со следующим словом выбрасывается. */
const CITY = new Set(['г', 'город']);

/** Корпус и строение — приклеиваются к номеру: «5 корп 2» → «5к2». */
const BUILDING: Record<string, string> = { к: 'к', корп: 'к', корпус: 'к', стр: 'с', строение: 'с' };

const hasDigit = (token: string): boolean => /\d/.test(token);

export interface ParsedAddress {
  street: string;
  number: string;
}

export function parseAddress(raw: string): ParsedAddress | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    // Всё, кроме букв, цифр, пробела, дефиса («пр-т») и дроби («5/1»), — в пробел.
    .replace(/[^\p{L}\p{N}\s/-]/gu, ' ');

  const tokens = cleaned.split(/\s+/).filter(Boolean);

  // Отрезаем хвост «подъезд 2», «кв 15»: чат — на дом, эти части не нужны.
  const tailAt = tokens.findIndex((token) => TAIL.has(token));
  const head = tailAt === -1 ? tokens : tokens.slice(0, tailAt);

  const kept: string[] = [];
  for (let i = 0; i < head.length; i += 1) {
    // «д1» / «дом12» без пробела — это номер, а не часть улицы.
    const token = head[i]!.replace(/^(?:дом|д)(?=\d)/, '');

    if (CITY.has(token)) {
      i += 1; // и название города следом
      continue;
    }
    if (NOISE.has(token)) continue;

    const suffix = BUILDING[token];
    const next = head[i + 1];
    const previous = kept[kept.length - 1];
    if (suffix && next && hasDigit(next) && previous && hasDigit(previous)) {
      kept[kept.length - 1] = `${previous}${suffix}${next}`;
      i += 1;
      continue;
    }

    kept.push(token);
  }

  let numberAt = -1;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    if (hasDigit(kept[i]!)) {
      numberAt = i;
      break;
    }
  }

  if (numberAt <= 0) return null; // нет номера или нет улицы перед ним

  const street = kept.slice(0, numberAt).join(' ');
  // Литера отдельным словом («5 а») приклеивается к номеру; прочие слова после
  // номера — не часть адреса дома. «5-а» → «5а», дробь «5/1» сохраняем.
  const litera = kept[numberAt + 1];
  const number = (kept[numberAt]! + (litera && /^\p{L}$/u.test(litera) ? litera : '')).replace(/-/g, '');

  return street ? { street, number } : null;
}
