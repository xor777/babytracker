/**
 * Fast-path матчер (§4 контракта).
 *
 * `matchFast` — ЧИСТАЯ функция: никаких обращений к БД, логам, глобальному времени.
 * Момент «сейчас» приходит третьим необязательным параметром, чтобы разбор
 * YANDEX.DATETIME оставался детерминированным и тестируемым.
 *
 * Внимание к регулярным выражениям: `\b` в JS опирается на ASCII-класс `\w`,
 * с кириллицей он НЕ работает. Поэтому все шаблоны применяются к строке,
 * дополненной пробелами по краям, а границы слова выражаются явным пробелом.
 */

import type { AliceNlu, FastResult, YandexDateTimeValue } from './types.ts';
import type { CivilParts } from './time.ts';
import { civilToUtcMs, zonedParts } from './time.ts';

/**
 * Верхняя граница длины разбираемой команды.
 *
 * Матчер синхронный и работает прямо в обработчике вебхука, поэтому его время —
 * это время ответа Алисе и блокировка всего процесса. На 8 КБ разбор занимал
 * ~110 мс, на 32 КБ — почти две секунды: бюджет в 200 мс сорван, а сервер в это
 * время не отвечает никому. Реальная фраза в разы короче: сама Алиса ограничена
 * 1024 символами в ответе.
 *
 * Выбрасываем СЕРЕДИНУ, оставляя начало и конец: в русской речи значимый глагол
 * часто оказывается последним («...и в итоге он всё-таки заснул»), и усечение
 * с хвоста молча меняло бы разбор. И в любом случае поднимаем mayContainMore —
 * в выброшенном куске может быть событие, решать должна модель, а не обрезка.
 */
export const MAX_COMMAND_CHARS = 1024;

/** Оставляет начало и конец длинной фразы, выбрасывая середину. */
export function clampCommand(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= MAX_COMMAND_CHARS) return { text: raw, truncated: false };
  const half = Math.floor(MAX_COMMAND_CHARS / 2);
  return { text: `${raw.slice(0, half)} ${raw.slice(-half)}`, truncated: true };
}

/** Уверенность прямого словарного попадания. */
const C_DIRECT = 0.95;
/** Уверенность попадания по более вольному шаблону (запрос состояния). */
const C_QUERY = 0.9;
/**
 * Тип события понятен, а вот время — нет: во фразе есть указание на время,
 * которое не удалось превратить в абсолютный момент. Событие всё равно пишется
 * (иначе при недоступной модели оно потерялось бы совсем), но заявлять 0.95
 * матчер не вправе: записанное время почти наверняка неверное.
 */
const C_TIME_UNRESOLVED = 0.4;

/* ------------------------------------------------------------------ */
/* Нормализация                                                        */
/* ------------------------------------------------------------------ */

/**
 * NFC, нижний регистр, `ё` -> `е`, пунктуация -> пробел, схлопывание пробелов.
 * «Бай-бай!» -> «бай бай», «Ещё  НЕ проснулся...» -> «еще не проснулся».
 */
export function normalize(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  return input
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokenize(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/** Строка с пробелами по краям — так `" слово "` надёжно ловит границы. */
function padded(normalized: string): string {
  return ` ${normalized} `;
}

/* ------------------------------------------------------------------ */
/* Словари                                                             */
/* ------------------------------------------------------------------ */

/** Слова-паразиты: не мешают распознать «чистую» команду выхода или запрос. */
const FILLERS = new Set([
  'алиса',
  'ну',
  'все',
  'ладно',
  'окей',
  'ок',
  'давай',
  'уже',
  'так',
  'да',
  'спасибо',
  'хорошо',
  'и',
  'а',
  'же',
  'то',
  'там',
  'мне',
  'нам',
  'скажи',
  'покажи',
]);

const EXIT_TOKENS = new Set([
  'хватит',
  'стоп',
  'выход',
  'пока',
  'отмена',
  'закончили',
  'закончить',
  'конец',
  'отбой',
  'выйти',
  'отменить',
]);

const EXIT_PHRASES = ['до свидания', 'всего доброго', 'на этом все', 'больше ничего'];

/** Одиночные слова «ребёнок засыпает / заснул». */
const SLEEP_START_TOKENS = new Set([
  'заснул',
  'заснула',
  'уснул',
  'уснула',
  'засыпает',
  'засыпаем',
  'засыпаю',
  'спит',
  'уложили',
  'уложил',
  'уложила',
  'укладываем',
  'укладываю',
  'спатки',
  'спатеньки',
  'баиньки',
  'отрубился',
  'отрубилась',
  'вырубился',
  'вырубилась',
  'задрых',
  'задрыхнул',
  'дрыхнет',
  'сопит',
]);

const SLEEP_START_PHRASES = [
  'положили спать',
  'положил спать',
  'положила спать',
  'уложили спать',
  'уложил спать',
  'уложила спать',
  'спать пошел',
  'спать пошла',
  'пошел спать',
  'пошла спать',
  'ушел спать',
  'ушла спать',
  'лег спать',
  'легла спать',
  'спать лег',
  'отправили спать',
  'бай бай',
  'начал спать',
];

const SLEEP_END_TOKENS = new Set([
  'проснулся',
  'проснулась',
  'проснулись',
  'просыпается',
  'просыпаемся',
  'просыпаюсь',
  'пробудился',
  'пробудилась',
  'встал',
  'встала',
  'разбудили',
  'разбудил',
  'разбудила',
  'подъем',
  'очнулся',
  'очнулась',
  'выспался',
  'выспалась',
]);

/**
 * Многословные маркеры пробуждения. Проверяются РАНЬШЕ проверки отрицаний:
 * «не спит» — это именно пробуждение, а не отрицание засыпания (§4).
 */
const SLEEP_END_PHRASES = [
  'не спит',
  'уже не спит',
  'больше не спит',
  'глаза открыл',
  'глаза открыла',
  'открыл глаза',
  'открыла глаза',
  'глазки открыл',
  'открыл глазки',
  'сон закончился',
  'закончил спать',
];

/** Запрос состояния/сводки. Шаблоны применяются к padded-строке. */
const QUERY_PATTERNS: RegExp[] = [
  / сколько .*спал/u,
  / сколько .*спит/u,
  / сколько .*проспал/u,
  / как .*спал/u,
  / как .*спит/u,
  / сколько сегодня /u,
  / сколько всего /u,
  / что там /u,
  / как дела /u,
  / что по сну /u,
  / что со сном /u,
  / долго .*спит /u,
];

const QUERY_TOKENS = new Set(['статус', 'отчет', 'сводка', 'итоги', 'состояние']);

/**
 * Подгузник — единственный не-сонный факт, который матчер пишет сам.
 * Только однословные, ни с чем не путающиеся формы: всё сложнее уходит модели.
 */
const DIAPER_DIRTY_TOKENS = new Set([
  'покакал', 'покакала', 'какал', 'какала', 'накакал', 'накакала',
  'обкакался', 'обкакалась', 'покакали',
]);

const DIAPER_WET_TOKENS = new Set([
  'пописал', 'пописала', 'описался', 'описалась', 'пописали', 'нассал',
]);

/* ------------------------------------------------------------------ */
/* Команды управления данными (§9.4)                                   */
/* ------------------------------------------------------------------ */

/**
 * Слова, по которым видно, что фраза не про новое событие, а про правку уже
 * записанного: «убери предыдущую запись», «исправь, он заснул в девять».
 * Такие фразы всегда уходят модели, какой бы уверенный ни был fast-path —
 * сам он их разобрать не может, а цена пропуска высокая.
 *
 * Сравнение по началу слова: «удали», «удалить», «удалите» — одно и то же.
 */
export const DATA_COMMAND_STEMS: readonly string[] = [
  'удал', // удали, удалить, удалите
  'убер', // убери, уберите
  'убрат', // убрать
  'отмени', // отмени, отмените (в отличие от «отмена» — это выход из диалога)
  'исправ', // исправь, исправить
  'поправ', // поправь, поправить
  'ошиб', // ошиблась, ошибся, ошибка
  'верни', // верни
  'вернут', // вернуть
  'сотри',
  'стере', // стереть
  'замен', // замени, заменить
  'перепиш',
  'переписа',
];

/** Многословные маркеры правки. */
export const DATA_COMMAND_PHRASES: readonly string[] = [
  'не так',
  'не то',
  'как было',
  'последнюю запись',
  'предыдущую запись',
];

/** Похожа ли фраза на команду управления уже записанными данными (§9.4). */
export function looksLikeDataCommand(command: string): boolean {
  const normalized = normalize(command);
  if (normalized.length === 0) return false;

  if (containsPhrase(padded(normalized), DATA_COMMAND_PHRASES)) return true;

  for (const token of tokenize(normalized)) {
    for (const stem of DATA_COMMAND_STEMS) {
      if (token.startsWith(stem)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Домены событий (§10.2) и «во фразе может быть ещё что-то» (§10.3)    */
/* ------------------------------------------------------------------ */

/**
 * Ключевые слова доменов. Нужны не для разбора (этим занимается модель),
 * а чтобы ПОНЯТЬ, что фразу нельзя закрывать одним fast-path.
 *
 * Сравнение по началу слова: «покорм» ловит «покормили», «покормила», «покормить».
 */
export const DOMAIN_STEMS: Readonly<Record<string, readonly string[]>> = {
  feed: [
    'покушал', 'кушал', 'кушает', 'поел', 'поела', 'поели', 'ест', 'едим',
    'покорм', 'кормл', 'кормил', 'кормим', 'кормит', 'кормить',
    'груд', 'сиськ', 'сисю', 'титьк', 'сосал', 'сосет', 'присосал',
    'бутылочк', 'бутылк', 'смес', 'прикорм', 'докорм', 'пюре', 'кашк', 'каш',
  ],
  pump: ['сцед', 'сцеживан'],
  diaper: [
    'подгузник', 'памперс', 'покакал', 'какал', 'покак', 'обкакал',
    'пописал', 'писал', 'описал', 'пеленк', 'подмыл', 'грязн', 'мокр',
  ],
  measure: [
    'взвесил', 'взвеш', 'весит', 'весил', 'вес', 'рост', 'выраст', 'измерил',
    'померил', 'температур', 'градусник', 'окружност', 'сантиметр', 'килограмм', 'грамм',
  ],
  meds: [
    'витамин', 'лекарств', 'капл', 'сироп', 'таблетк', 'парацетамол', 'нурофен',
    'фенистил', 'аквадетрим', 'дозу', 'жаропониж', 'свеч',
  ],
  symptom: [
    'срыгн', 'срыгив', 'вырвал', 'рвот', 'сып', 'колик', 'плач', 'плакал',
    'кашл', 'сопл', 'насморк', 'болит', 'беспоко', 'капризнич', 'жар',
    // Желтизна кожи и белков глаз. Матчер её НЕ разбирает и события не пишет —
    // стемы стоят здесь ровно затем, чтобы фраза с ней гарантированно ушла
    // модели: «покормила, и он какой-то желтенький» иначе закрылось бы
    // кормлением, а наблюдение пропало бы молча (§10.3).
    'желт', 'жёлт',
  ],
  activity: [
    'купал', 'ванн', 'гулял', 'гулять', 'прогулк', 'выклад', 'животик', 'массаж', 'зарядк',
  ],
  sleep: [
    'спал', 'спит', 'сон', 'засн', 'усн', 'засып', 'проснул', 'просып', 'дрых', 'уложил',
  ],
};

/** Числительные словами — «минут пятнадцать» это одно число. */
const NUMERAL_STEMS: readonly string[] = [
  'полтор', 'полутор',
  'один', 'одну', 'одна', 'два', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь',
  'восемь', 'девять', 'десять', 'одиннадцат', 'двенадцат', 'тринадцат', 'четырнадцат',
  'пятнадцат', 'шестнадцат', 'семнадцат', 'восемнадцат', 'девятнадцат', 'двадцат',
  'тридцат', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяност',
  'двест', 'трист', 'полчаса', 'половин',
];

/* ------------------------------------------------------------------ */
/* Указание на время (§10.3)                                           */
/* ------------------------------------------------------------------ */

/**
 * Слова, по которым видно, что мама назвала время события.
 *
 * Мама редко записывает событие ровно в тот момент, когда оно случилось:
 * «заснул полчаса назад», «проснулся в три», «уснул после обеда» — обычный
 * способ говорить. Если такое слово есть, а абсолютный момент получить
 * не удалось, решать должна модель, а не матчер.
 */
const TIME_MARKER_TOKENS = new Set([
  'назад',
  'утром', 'утра', 'утру',
  'днем', 'полдень', 'полудни',
  'вечером', 'вечера', 'вечеру',
  'ночью', 'ночи',
  'недавно', 'давно', 'рано', 'поздно',
  'вчера', 'позавчера',
  'обед', 'обеда', 'обедом', 'обеде',
  'завтрак', 'завтрака', 'завтраком',
  'ужин', 'ужина', 'ужином',
  'полдник', 'полдника',
  'полчаса', 'полтора', 'полутора',
  'минут', 'минуту', 'минуты', 'минута',
  'час', 'часа', 'часов', 'часу',
  'перед', 'после',
]);

const TIME_MARKER_PHRASES: readonly string[] = [
  'только что',
  'пару минут',
  'пару часов',
  'на днях',
  'в обед',
  'под утро',
  'под вечер',
  'к обеду',
];

/**
 * Есть ли во фразе указание на время.
 *
 * Отдельно ловится конструкция «в <число>»: «в три», «в 15», «в половину».
 */
export function hasTimeReference(normalized: string): boolean {
  if (normalized.length === 0) return false;
  if (containsPhrase(padded(normalized), TIME_MARKER_PHRASES)) return true;

  const tokens = tokenize(normalized);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (TIME_MARKER_TOKENS.has(token)) return true;

    // «в три», «в 15», «во сколько-то»
    if (token === 'в' || token === 'во') {
      const next = tokens[i + 1];
      if (next !== undefined && (/^\d+$/u.test(next) || startsWithAny(next, NUMERAL_STEMS))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * §10.3: во фразе названо время, а разрешить его в абсолютный момент не вышло.
 *
 * Именно этот случай дал тихую порчу данных на проде: «андрей заснул полтора
 * часа назад» при пустом `nlu.entities` записался на «сейчас» с уверенностью
 * 0.95 и поэтому не ушёл модели — правдоподобное, но неверное время без единого
 * признака ошибки в интерфейсе.
 *
 * Пустой `nlu.entities` при наличии слов времени — тот же случай: NLU не
 * справился, и решать должна модель.
 */
export function isTimeUnresolved(normalized: string, resolvedAt: string | undefined): boolean {
  if (resolvedAt !== undefined) return false;
  return hasTimeReference(normalized);
}

/** Слова, которые не считаются «значимыми» при подсчёте длины фразы. */
const INSIGNIFICANT = new Set([
  'и', 'а', 'но', 'же', 'то', 'ли', 'бы', 'в', 'во', 'на', 'с', 'со', 'у', 'к', 'ко',
  'о', 'об', 'за', 'по', 'из', 'от', 'до', 'для', 'при', 'про', 'над', 'под',
  'он', 'она', 'они', 'мы', 'я', 'ты', 'его', 'ее', 'их', 'нам', 'мне', 'ему',
  'уже', 'еще', 'так', 'там', 'тут', 'вот', 'это', 'этот', 'что', 'как', 'ну',
  'андрей', 'андрея', 'андрею', 'алиса', 'сегодня', 'вчера', 'сейчас',
]);

/**
 * Союзы и перечисления (§10.3). Запятая проверяется по СЫРОЙ фразе:
 * нормализация её уже съела.
 */
const CONJUNCTION_PATTERNS: readonly RegExp[] = [
  / и /u,
  / а /u,
  / потом/u,
  / затем/u,
  / после/u,
  / плюс/u,
];

function startsWithAny(token: string, stems: readonly string[]): boolean {
  for (const stem of stems) if (token.startsWith(stem)) return true;
  return false;
}

/** Домены, ключевые слова которых встречаются во фразе. */
export function detectDomains(normalized: string): Set<string> {
  const found = new Set<string>();
  const tokens = tokenize(normalized);
  for (const [domain, stems] of Object.entries(DOMAIN_STEMS)) {
    for (const token of tokens) {
      if (startsWithAny(token, stems)) {
        found.add(domain);
        break;
      }
    }
  }
  return found;
}

/** Сколько чисел во фразе: цифрами и словами. */
export function countNumbers(normalized: string): number {
  let count = (normalized.match(/\d+/gu) ?? []).length;
  for (const token of tokenize(normalized)) {
    if (/\d/.test(token)) continue; // уже посчитали цифрами
    if (startsWithAny(token, NUMERAL_STEMS)) count++;
  }
  return count;
}

/** Значимые слова — без предлогов, местоимений и имени ребёнка. */
export function countSignificantWords(normalized: string): number {
  return tokenize(normalized).filter((t) => !INSIGNIFICANT.has(t)).length;
}

export const MAX_SIMPLE_WORDS = 6;

export interface MayContainMoreInput {
  /** Сырая фраза — по ней ищем запятые, которые нормализация убирает. */
  raw: string;
  normalized: string;
  /** Домен, который уже распознал fast-path ('sleep' либо null). */
  recognizedDomain: string | null;
}

/**
 * §10.3: может ли во фразе быть что-то, кроме распознанного.
 *
 * Это защита от тихой потери данных, а не оптимизация: «Андрей покушал и уснул»
 * fast-path видит как уверенный sleep_start, и без этой проверки кормление
 * исчезло бы молча — мама думает, что записала, а записи нет.
 * Поэтому правило сознательно срабатывает с запасом: лишний вызов модели дёшев,
 * потерянное событие — нет.
 */
export function computeMayContainMore(input: MayContainMoreInput): boolean {
  const { raw, normalized, recognizedDomain } = input;
  if (normalized.length === 0) return false;

  // 1. Союз или перечисление
  if (raw.includes(',')) return true;
  const padded_ = padded(normalized);
  if (CONJUNCTION_PATTERNS.some((re) => re.test(padded_))) return true;

  // 2. Ключевое слово из другого домена
  for (const domain of detectDomains(normalized)) {
    if (domain !== recognizedDomain) return true;
  }

  // 3. Больше одного числа
  if (countNumbers(normalized) > 1) return true;

  // 4. Длинная фраза
  if (countSignificantWords(normalized) > MAX_SIMPLE_WORDS) return true;

  return false;
}

/* ------------------------------------------------------------------ */
/* Вопрос против утверждения                                           */
/* ------------------------------------------------------------------ */

/**
 * Вопросительные конструкции.
 *
 * «Спит ли он» — это вопрос, а матчер уверенно понимал его как «заснул» и писал
 * событие: мама спросила, а в дневнике появилась запись о том, чего не было.
 * Хуже того, «проснулся ли он» ЗАКРЫВАЛО идущий сон и считало длительность.
 *
 * Частица «ли» — однозначный машинный признак, но не единственный: вопрос дают
 * и вопросительные слова в начале фразы, и знак вопроса, если он дошёл до нас.
 */
const QUESTION_PARTICLES = new Set(['ли', 'разве', 'неужели']);

const QUESTION_WORDS = new Set([
  'когда',
  'почему',
  'зачем',
  'отчего',
  'где',
  'кто',
  'куда',
  'какой',
  'какая',
  'долго',
]);

const QUESTION_PHRASES: readonly string[] = ['во сколько', 'в котором часу', 'правда что'];

/**
 * Похожа ли фраза на вопрос. Проверяется по сырому тексту тоже: знак вопроса
 * нормализация съедает, а он самый надёжный признак из всех.
 */
export function looksLikeQuestion(raw: string, normalized: string): boolean {
  if (typeof raw === 'string' && raw.includes('?')) return true;
  if (normalized.length === 0) return false;

  const padded_ = padded(normalized);
  if (containsPhrase(padded_, QUESTION_PHRASES)) return true;

  const tokens = tokenize(normalized);
  // частица «ли» может стоять где угодно: «спит ли он», «он ли это»
  if (tokens.some((t) => QUESTION_PARTICLES.has(t))) return true;
  // вопросительное слово — только в начале: «когда заснул» вопрос,
  // а «положили когда проснулся» разбирать матчеру всё равно нечего
  const first = tokens[0];
  return first !== undefined && QUESTION_WORDS.has(first);
}

/* ------------------------------------------------------------------ */
/* Отрицания                                                           */
/* ------------------------------------------------------------------ */

const NEGATIONS = new Set(['не', 'нет', 'ни']);

/**
 * Есть ли отрицание перед ключевым словом сна.
 * Смотрим два токена назад: «не заснул», «ещё не проснулся», «так и не уснул».
 */
function hasNegatedSleepKeyword(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) continue;
    if (!SLEEP_START_TOKENS.has(t) && !SLEEP_END_TOKENS.has(t)) continue;
    for (let back = 1; back <= 2 && i - back >= 0; back++) {
      const prev = tokens[i - back];
      if (prev !== undefined && NEGATIONS.has(prev)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* YANDEX.DATETIME                                                     */
/* ------------------------------------------------------------------ */

type UnitKey = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';
const UNIT_ORDER: UnitKey[] = ['year', 'month', 'day', 'hour', 'minute', 'second'];

function isRelative(value: YandexDateTimeValue, unit: UnitKey): boolean {
  return value[`${unit}_is_relative` as keyof YandexDateTimeValue] === true;
}

function unitValue(value: YandexDateTimeValue, unit: UnitKey): number | undefined {
  const v = value[unit];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Превращает YANDEX.DATETIME в абсолютный момент (ISO UTC).
 * null — если сущность пустая или бессмысленная.
 */
export function resolveYandexDateTime(
  value: YandexDateTimeValue,
  now: Date,
  tz: string,
): string | null {
  const specifiedIdx = UNIT_ORDER.map((u, i) => (unitValue(value, u) !== undefined ? i : -1)).filter(
    (i) => i >= 0,
  );
  if (specifiedIdx.length === 0) return null;

  const civil: CivilParts = { ...zonedParts(now, tz) };
  const lastSpecifiedIdx = Math.max(...specifiedIdx);
  const hasDatePart =
    unitValue(value, 'year') !== undefined ||
    unitValue(value, 'month') !== undefined ||
    unitValue(value, 'day') !== undefined;

  // 1. Абсолютные компоненты присваиваем.
  for (const unit of UNIT_ORDER) {
    const v = unitValue(value, unit);
    if (v === undefined || isRelative(value, unit)) continue;
    civil[unit] = v;
  }

  // 2. Компоненты мельче самого мелкого названного обнуляем — но ТОЛЬКО если он
  //    назван абсолютно: «в три» => 03:00:00, а «два часа назад» => сейчас минус 2 ч
  //    (обнулять минуты в относительном сдвиге нельзя, это потеряет 32 минуты).
  const smallestUnit = UNIT_ORDER[lastSpecifiedIdx];
  if (smallestUnit !== undefined && !isRelative(value, smallestUnit)) {
    for (let i = lastSpecifiedIdx + 1; i < UNIT_ORDER.length; i++) {
      const unit = UNIT_ORDER[i];
      if (unit === 'hour' || unit === 'minute' || unit === 'second') civil[unit] = 0;
    }
  }

  // 3. Относительные сдвиги — поверх; Date.UTC сам нормализует переполнения.
  for (const unit of UNIT_ORDER) {
    const v = unitValue(value, unit);
    if (v === undefined || !isRelative(value, unit)) continue;
    civil[unit] += v;
  }

  let ms = civilToUtcMs(civil, tz);
  if (!Number.isFinite(ms)) return null;

  // 4. «Проснулся в три», сказанное в 01:00 — это прошедшие сутки, а не будущее.
  //    Дату пользователь не называл, значит сдвигаемся на сутки назад.
  if (!hasDatePart && ms > now.getTime() + 60_000) ms -= 86_400_000;

  return new Date(ms).toISOString();
}

function extractDateTime(nlu: AliceNlu | undefined, now: Date, tz: string): string | undefined {
  const entities = nlu?.entities;
  if (!Array.isArray(entities)) return undefined;
  for (const entity of entities) {
    if (!entity || entity.type !== 'YANDEX.DATETIME') continue;
    const value = entity.value;
    if (!value || typeof value !== 'object') continue;
    const iso = resolveYandexDateTime(value as YandexDateTimeValue, now, tz);
    if (iso) return iso;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Белый список канонических фраз                                      */
/* ------------------------------------------------------------------ */

/**
 * КЛЮЧЕВОЕ РЕШЕНИЕ ПРОЕКТА, принятое после трёх одинаковых инцидентов на проде:
 *
 *   1. «покушал и уснул»            — не было правила про составные фразы;
 *   2. «заснул полтора часа назад»  — не было правила про неразрешённое время;
 *   3. «что он закончил кушать когда лег спать» — «когда» не было в списке
 *      связок, а «кушать» не покрывалось стемами еды. ДВЕ дыры в одной фразе.
 *
 * Каждый раз список опасностей дописывали ПОСЛЕ того, как он подвёл, и каждый
 * раз ценой потерянного факта в дневнике ребёнка. Полный список русских связок
 * не составить: впереди «как только», «пока», «и тут», «а сам», «перед тем как».
 *
 * Поэтому направление решения перевёрнуто, ровно как со списком колонок
 * в валидаторе SQL. Было: «матчер уверен -> модель не зовём». Стало:
 *
 *   ФРАЗА СОВПАЛА С КОРОТКОЙ КАНОНИЧЕСКОЙ ФОРМОЙ -> не зовём.
 *   ВСЁ ОСТАЛЬНОЕ -> зовём.
 *
 * Канонична фраза, в которой КАЖДОЕ слово матчеру знакомо. Незнакомое слово —
 * само по себе достаточная причина отдать фразу модели: именно незнакомые слова
 * («кушать», «когда») и уносили факты все три раза. Список угроз перестаёт быть
 * точкой отказа: чтобы дыра появилась, теперь надо ошибочно ДОБАВИТЬ слово
 * в белый список, а не забыть добавить в чёрный.
 */

/** Слова, которые ничего не значат для разбора и не мешают каноничности. */
const CANONICAL_FILLERS = new Set([
  'андрей', 'андрея', 'андрею', 'андрейка',
  'он', 'она', 'малыш', 'ребенок', 'сын',
  'уже', 'наконец', 'наконец то', 'опять', 'снова', 'все', 'ну', 'да', 'ладно',
  'вот', 'так', 'и', 'а',
]);

/** Слова фразы-маркера (многословные формы вроде «положили спать»). */
function wordsOf(phrases: readonly string[]): string[] {
  return phrases.flatMap((phrase) => phrase.split(' '));
}

/** Разрешённый словарь для каждого вида разбора. */
const CANONICAL_VOCABULARY: Readonly<Record<string, ReadonlySet<string>>> = {
  sleep_start: new Set([...SLEEP_START_TOKENS, ...wordsOf(SLEEP_START_PHRASES)]),
  sleep_end: new Set([...SLEEP_END_TOKENS, ...wordsOf(SLEEP_END_PHRASES)]),
  diaper: new Set([...DIAPER_DIRTY_TOKENS, ...DIAPER_WET_TOKENS]),
  exit: new Set([...EXIT_TOKENS, ...wordsOf(EXIT_PHRASES), ...FILLERS]),
  query_state: new Set([
    ...QUERY_TOKENS,
    'сколько', 'спал', 'спит', 'проспал', 'проспала', 'спала',
    'как', 'что', 'там', 'дела', 'сегодня', 'всего', 'долго', 'сну', 'сном', 'по', 'со',
  ]),
};

/** Сколько значимых слов допускает каноническая форма. */
export const CANONICAL_MAX_WORDS = 4;

export interface CanonicalCheck {
  canonical: boolean;
  /** Почему НЕ канонична — попадает в ленту распознавания, чтобы было видно. */
  reason: string;
}

/**
 * Совпадает ли фраза с короткой канонической формой, которую матчер понимает
 * целиком и в которой ошибиться негде.
 */
export function checkCanonical(command: string, fast: FastResult): CanonicalCheck {
  if (fast.kind === 'unknown') {
    return { canonical: false, reason: 'матчер не понял фразу' };
  }
  if (fast.mayContainMore) {
    return { canonical: false, reason: 'во фразе может быть ещё событие' };
  }
  if (fast.timeUnresolved) {
    return { canonical: false, reason: 'во фразе названо время, разобрать его не удалось' };
  }

  const { text: source } = clampCommand(typeof command === 'string' ? command : '');
  const normalized = normalize(source);
  if (normalized.length === 0) return { canonical: false, reason: 'пустая фраза' };

  if (looksLikeQuestion(source, normalized)) {
    return { canonical: false, reason: 'это вопрос, а не утверждение' };
  }
  if (countNumbers(normalized) > 0) {
    return { canonical: false, reason: 'во фразе есть число' };
  }
  if (hasTimeReference(normalized)) {
    return { canonical: false, reason: 'во фразе есть указание на время' };
  }
  if (countSignificantWords(normalized) > CANONICAL_MAX_WORDS) {
    return { canonical: false, reason: 'фраза длиннее короткой канонической формы' };
  }

  const vocabulary = CANONICAL_VOCABULARY[fast.kind];
  if (!vocabulary) return { canonical: false, reason: `разбор «${fast.kind}» не каноничен` };

  for (const token of tokenize(normalized)) {
    if (vocabulary.has(token) || CANONICAL_FILLERS.has(token)) continue;
    // Незнакомое слово — самостоятельная причина отдать фразу модели.
    // Именно незнакомые слова унесли факты все три раза.
    return { canonical: false, reason: `матчеру незнакомо слово «${token}»` };
  }

  return { canonical: true, reason: 'короткая каноническая фраза, понятная матчеру целиком' };
}

/* ------------------------------------------------------------------ */
/* Матчер                                                              */
/* ------------------------------------------------------------------ */

function containsPhrase(paddedText: string, phrases: readonly string[]): boolean {
  for (const phrase of phrases) {
    if (paddedText.includes(` ${phrase} `)) return true;
  }
  return false;
}

function hasAnyToken(tokens: string[], dict: ReadonlySet<string>): boolean {
  return tokens.some((t) => dict.has(t));
}

function isExit(paddedText: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  if (containsPhrase(paddedText, EXIT_PHRASES)) return true;
  // Команда выхода — только если ВСЯ фраза состоит из стоп-слов и мусора.
  // Иначе «пока спит» превратилось бы в прощание.
  let sawExitWord = false;
  for (const t of tokens) {
    if (EXIT_TOKENS.has(t)) {
      sawExitWord = true;
      continue;
    }
    if (!FILLERS.has(t)) return false;
  }
  return sawExitWord;
}

function isQuery(paddedText: string, tokens: string[]): boolean {
  if (QUERY_PATTERNS.some((re) => re.test(paddedText))) return true;
  // Односложные «статус», «отчёт» — только если это вся фраза (плюс мусор).
  if (!hasAnyToken(tokens, QUERY_TOKENS)) return false;
  return tokens.every((t) => QUERY_TOKENS.has(t) || FILLERS.has(t));
}

function sleepResult(
  kind: 'sleep_start' | 'sleep_end',
  at: string | undefined,
  mayContainMore: boolean,
  timeUnresolved: boolean,
): FastResult {
  // Тип события матчер распознал уверенно, но если время названо и не разобрано,
  // заявлять 0.95 нечестно: записанный момент почти наверняка неверный.
  const confidence = timeUnresolved ? C_TIME_UNRESOLVED : C_DIRECT;

  if (kind === 'sleep_start') {
    return at === undefined
      ? { kind: 'sleep_start', confidence, mayContainMore, timeUnresolved }
      : { kind: 'sleep_start', confidence, at, mayContainMore, timeUnresolved };
  }
  return at === undefined
    ? { kind: 'sleep_end', confidence, mayContainMore, timeUnresolved }
    : { kind: 'sleep_end', confidence, at, mayContainMore, timeUnresolved };
}

export interface MatchFastOptions {
  /** Момент «сейчас» для разбора относительного времени. */
  now?: Date;
  /** Таймзона представления (для YANDEX.DATETIME). */
  tz?: string;
}

/**
 * Детерминированный разбор фразы. Без побочных эффектов.
 *
 * Третий параметр — необязательное расширение сигнатуры из §4: без него функция
 * не смогла бы разворачивать относительное время, оставаясь чистой.
 */
export function matchFast(
  command: string,
  nlu?: AliceNlu,
  options: MatchFastOptions = {},
): FastResult {
  const now = options.now ?? new Date();
  const tz = options.tz ?? 'Europe/Moscow';

  const raw = typeof command === 'string' ? command : '';
  // Длинный ввод режем ДО разбора: иначе он съедает бюджет ответа Алисе
  // и блокирует процесс целиком.
  const { text: source, truncated } = clampCommand(raw);

  const normalized = normalize(source);
  if (normalized.length === 0) {
    return { kind: 'unknown', mayContainMore: truncated, timeUnresolved: false };
  }

  const text = padded(normalized);
  const tokens = tokenize(normalized);

  /** §10.3: считается относительно того, что распознали. */
  const more = (recognizedDomain: string | null): boolean =>
    // в отрезанном хвосте может быть что угодно — решать модели
    truncated || computeMayContainMore({ raw: source, normalized, recognizedDomain });

  // 1. Выход — раньше всего: это управление диалогом, а не событие.
  if (isExit(text, tokens)) {
    return { kind: 'exit', mayContainMore: false, timeUnresolved: false };
  }

  const at = extractDateTime(nlu, now, tz);
  // Время названо, но в абсолютный момент не превратилось — см. §10.3.
  const timeUnresolved = isTimeUnresolved(normalized, at);

  // Вопрос — не утверждение: события по нему писать нельзя. Отдаём модели,
  // она и ответит, и разберётся, о чём вообще спрашивали.
  if (looksLikeQuestion(source, normalized)) {
    return { kind: 'unknown', mayContainMore: more(null), timeUnresolved: false };
  }

  // 2. Многословные маркеры пробуждения (в т.ч. «не спит») — до проверки отрицаний.
  if (containsPhrase(text, SLEEP_END_PHRASES)) {
    return sleepResult('sleep_end', at, more('sleep'), timeUnresolved);
  }

  // 3. Многословные маркеры засыпания.
  if (containsPhrase(text, SLEEP_START_PHRASES)) {
    return sleepResult('sleep_start', at, more('sleep'), timeUnresolved);
  }

  // 4. Запрос состояния: события не пишет, поэтому время ему безразлично.
  if (isQuery(text, tokens)) {
    return { kind: 'query_state', confidence: C_QUERY, mayContainMore: false, timeUnresolved: false };
  }

  // 5. Отрицание рядом с ключевым словом сна — отдаём LLM, сами не гадаем.
  if (hasNegatedSleepKeyword(tokens)) {
    return { kind: 'unknown', mayContainMore: more(null), timeUnresolved };
  }

  // 6. Одиночные ключевые слова.
  if (hasAnyToken(tokens, SLEEP_END_TOKENS)) {
    return sleepResult('sleep_end', at, more('sleep'), timeUnresolved);
  }
  if (hasAnyToken(tokens, SLEEP_START_TOKENS)) {
    return sleepResult('sleep_start', at, more('sleep'), timeUnresolved);
  }

  // 7. Подгузник: однословные, ни с чем не путающиеся формы.
  for (const [subtype, dictionary] of [
    ['dirty', DIAPER_DIRTY_TOKENS],
    ['wet', DIAPER_WET_TOKENS],
  ] as const) {
    if (!hasAnyToken(tokens, dictionary)) continue;
    const base = {
      kind: 'diaper' as const,
      subtype,
      confidence: timeUnresolved ? C_TIME_UNRESOLVED : C_DIRECT,
      mayContainMore: more('diaper'),
      timeUnresolved,
    };
    return at === undefined ? base : { ...base, at };
  }

  return { kind: 'unknown', mayContainMore: more(null), timeUnresolved };
}
