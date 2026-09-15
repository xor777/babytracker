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

/** Уверенность прямого словарного попадания. */
const C_DIRECT = 0.95;
/** Уверенность попадания по более вольному шаблону (запрос состояния). */
const C_QUERY = 0.9;

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
  confidence: number,
  at: string | undefined,
): FastResult {
  if (kind === 'sleep_start') {
    return at === undefined
      ? { kind: 'sleep_start', confidence }
      : { kind: 'sleep_start', confidence, at };
  }
  return at === undefined
    ? { kind: 'sleep_end', confidence }
    : { kind: 'sleep_end', confidence, at };
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

  const normalized = normalize(command);
  if (normalized.length === 0) return { kind: 'unknown' };

  const text = padded(normalized);
  const tokens = tokenize(normalized);

  // 1. Выход — раньше всего: это управление диалогом, а не событие.
  if (isExit(text, tokens)) return { kind: 'exit' };

  const at = extractDateTime(nlu, now, tz);

  // 2. Многословные маркеры пробуждения (в т.ч. «не спит») — до проверки отрицаний.
  if (containsPhrase(text, SLEEP_END_PHRASES)) return sleepResult('sleep_end', C_DIRECT, at);

  // 3. Многословные маркеры засыпания.
  if (containsPhrase(text, SLEEP_START_PHRASES)) return sleepResult('sleep_start', C_DIRECT, at);

  // 4. Запрос состояния.
  if (isQuery(text, tokens)) return { kind: 'query_state', confidence: C_QUERY };

  // 5. Отрицание рядом с ключевым словом сна — отдаём LLM, сами не гадаем.
  if (hasNegatedSleepKeyword(tokens)) return { kind: 'unknown' };

  // 6. Одиночные ключевые слова.
  if (hasAnyToken(tokens, SLEEP_END_TOKENS)) return sleepResult('sleep_end', C_DIRECT, at);
  if (hasAnyToken(tokens, SLEEP_START_TOKENS)) return sleepResult('sleep_start', C_DIRECT, at);

  return { kind: 'unknown' };
}
