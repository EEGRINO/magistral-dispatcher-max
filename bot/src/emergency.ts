/**
 * Опасные ситуации — danger_types из config/rules.yaml (Павел, 23.09.2026):
 * запах газа, искрящая проводка, угроза затопления, человек в лифте.
 * Опасность выясняется ДО обычной заявки: уточняющим вопросом после выбора типа
 * проблемы и страховкой по словам в любом тексте жителя (решения 24.09.2026).
 *
 * Отдельно — огонь и дым: не danger_type, а общее правило из
 * docs/danger-types-spec.md — в любом тексте, всегда, сразу 101/112.
 */

export const DANGER_TYPES = ['gas_smell', 'exposed_wiring', 'flooding_threat', 'elevator_entrapment'] as const;
export type DangerType = (typeof DANGER_TYPES)[number];

export function isDangerType(value: string): value is DangerType {
  return (DANGER_TYPES as readonly string[]).includes(value);
}

/** Нижний регистр, ё → е, знаки препинания → пробел, пробелы схлопнуты. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Слова, по которым бот заподозрит опасность в свободном тексте. Лучше лишний
 * раз показать инструкцию, чем пропустить утечку газа, — поэтому признаки
 * широкие. Ложное срабатывание стоит одного лишнего сообщения: заявку по слову
 * бот сам не создаёт, только после кнопки «Да, это авария».
 *
 * Слово между признаками допускается: «пахнет сильно газом», «прорвало на
 * кухне трубу».
 */
const GAP = '(?:\\s+\\S+)?\\s+';

const PATTERNS: Record<DangerType, RegExp[]> = {
  gas_smell: [
    new RegExp(`(запах|пахн|воня|несет|утечк)\\S*${GAP}газ`),
    new RegExp(`газ\\S*${GAP}(пахн|воня|несет|утечк|шипит)`),
    /(^|[^а-я])газ([^а-я]|$)/, // одно слово «газ» — «газ!», «газ в подъезде»
  ],
  exposed_wiring: [
    /(^|[^а-я])искр(ит|ят|ила|или|ение|а|ы)([^а-я]|$)/,
    new RegExp(`(плавит|оплав)\\S*${GAP}(розетк|проводк|провод|щит|выключател)`),
    new RegExp(`(розетк|проводк|провод|щит|выключател)\\S*${GAP}(плавит|оплав)`),
    /(пахнет|запах)\S*\s+гар/,
    /(бьет|бьется|ударило)\S*\s+ток/,
    /короткое\s+замыкание/,
    /оголен\S*\s+провод/,
  ],
  flooding_threat: [
    /(^|[^а-я])(затоп|потоп)/,
    /(^|[^а-я])зали(вает|ло|ли|вают)([^а-я]|$)/,
    /(прорвал|прорыв|лопнул|хлещет|фонтаном)/,
    /(течет|льет)\S*\s+(с|из)\s+потолк/,
  ],
  elevator_entrapment: [
    new RegExp(`застрял\\S*${GAP}(в${GAP})?лифт`),
    new RegExp(`лифт\\S*${GAP}(\\S+\\s+)?застрял`),
    new RegExp(`(заперт|закрыт)\\S*\\s+в\\s+лифт`),
  ],
};

/** Первая найденная опасность или null. Порядок — по тяжести: газ, ток, вода, лифт. */
export function detectDanger(text: string): DangerType | null {
  const normalized = normalize(text);
  for (const type of DANGER_TYPES) {
    if (PATTERNS[type].some((pattern) => pattern.test(normalized))) return type;
  }
  return null;
}

/**
 * Огонь или дым: «пожар», «горит», «дым», «задымление», «огонь». По словам, а не
 * подстрокой: «дымоход» — не дым. «Не горит свет» — не пожар: «горит» после
 * «не» не считаем, иначе каждое «в подъезде не горит лампочка» пугало бы 101.
 */
export function detectFire(text: string): boolean {
  const words = normalize(text).split(' ');
  return words.some((word, i) => {
    // «пожарный выход закрыт» — жалоба на подъезд, а не пожар.
    if (/^(пожар(?!н)|задымл|загорел|возгоран)/.test(word)) return true;
    if (/^(огонь|огня|огнем|огне|дым|дыма|дымом|дыму|дымит|дымится|дымят)$/.test(word)) return true;
    if (/^(горит|горят|горело|горела)$/.test(word)) return words[i - 1] !== 'не';
    return false;
  });
}
