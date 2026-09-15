/** Событие → строчки, которые видит человек в ленте. */
import type { ChangeSet, TrackerEvent } from '../types';
import type { Gender } from './taxonomy';
import { breastSide, subtypeLabel, typeDef, unitLabel } from './taxonomy';
import { undoableSets } from './group';
import {
  HOUR,
  durationMin,
  formatMinutes,
  formatNumber,
  formatWeight,
  parseTs,
  plural,
} from './format';

/**
 * Дольше этого «идёт» — уже не идёт, а незакрытая запись: купание без ended_at
 * иначе висело бы с бейджем «идёт» вечно.
 */
const STILL_GOING = 12 * HOUR;

/**
 * Модель помечает собственные допущения префиксом [?] в заметке
 * («[?] время не называлось, взята граница»). Для ленты это сигнал:
 * строку стоит развернуть и проверить.
 */
export const ASSUMPTION_MARK = '[?]';

export function isAssumption(note: string | null | undefined): boolean {
  return (note ?? '').trimStart().startsWith(ASSUMPTION_MARK);
}

export function stripAssumption(note: string | null | undefined): string {
  const raw = (note ?? '').trim();
  return raw.startsWith(ASSUMPTION_MARK) ? raw.slice(ASSUMPTION_MARK.length).trim() : raw;
}

/**
 * Длительность события — но только та, которую вообще осмысленно называть.
 *
 * Нулевая длительность не длительность, а её отсутствие, и печатать её нельзя:
 *
 *   - у точечного события (подгузник, взвешивание) модель ставит
 *     `ended_at = started_at` — это момент во времени, а не промежуток;
 *   - кормление в двадцать секунд округляется в те же ноль минут.
 *
 * И там и там в ленте появлялось «0 мин» — строка, которая ничего не сообщает,
 * а выглядит сломанной записью («мокрый подгузник 0 минут»).
 */
export function eventDurationMin(e: TrackerEvent): number | null {
  const min = durationMin(e.started_at, e.ended_at);
  return min != null && min > 0 ? min : null;
}

/** Есть ли у события настоящий промежуток «с … до …», а не точка во времени. */
export function hasTimeSpan(e: TrackerEvent): boolean {
  return eventDurationMin(e) !== null;
}

export interface EventName {
  /** «Сон, ночной», «Подгузник, мокрый», «Вес». */
  text: string;
  /** Род `text` — чтобы согласовать причастие («завершён» / «завершена»). */
  gender: Gender;
}

/** Измерение читается без слова «Измерение»: «Вес», а не «Измерение, вес». */
const MEASURE_NAME: Record<string, EventName> = {
  weight: { text: 'Вес', gender: 'm' },
  height: { text: 'Рост', gender: 'm' },
  head: { text: 'Окружность головы', gender: 'f' },
  temp: { text: 'Температура', gender: 'f' },
};

/**
 * Как запись зовут в ленте — без чисел и без длительности.
 *
 * Это начало строки и у события, и у фразы, изменившей запись: именно оно
 * держит общий ритм журнала, где каждая строка начинается с существительного.
 */
export function eventName(e: TrackerEvent): EventName {
  if (e.type === 'measure') {
    return MEASURE_NAME[e.subtype ?? ''] ?? { text: 'Измерение', gender: 'n' };
  }
  const def = typeDef(e.type);
  const sub = subtypeLabel(e.type, e.subtype);
  return { text: sub ? `${def.label}, ${sub}` : def.label, gender: def.gender };
}

export interface EventLines {
  /** «Кормление» */
  title: string;
  /** «бутылочка» */
  sub: string | null;
  /** «120 мл», «1 ч 10 мин», «левая» — каждая частица отдельно, чтобы верстать. */
  parts: string[];
  /** Заметка, если она не ушла в parts. */
  note: string | null;
  /** Событие ещё идёт (§1: ended_at IS NULL). */
  open: boolean;
  tone: string;
  icon: string;
}

function valueText(e: TrackerEvent): string | null {
  if (e.value_num == null) return null;
  if (e.type === 'measure') {
    if (e.subtype === 'weight') return formatWeight(e.value_unit === 'kg' ? e.value_num * 1000 : e.value_num);
    if (e.subtype === 'temp') return `${formatNumber(e.value_num, 1)} °C`;
    return `${formatNumber(e.value_num, 1)} ${unitLabel(e.value_unit ?? 'cm')}`;
  }
  return `${formatNumber(e.value_num, Number.isInteger(e.value_num) ? 0 : 1)} ${unitLabel(e.value_unit)}`.trim();
}

/**
 * Одна строка дневника: «Кормление, грудь, 15 мин».
 *
 * Свёрнутая лента читается глазами сверху вниз, поэтому здесь важна краткость,
 * а не полнота: подробности человек получает, развернув строку.
 */
export function summaryLine(e: TrackerEvent): string {
  const lines = describeEvent(e);

  // Измерения читаются естественнее без слова «Измерение»: «Вес 4,62 кг».
  if (e.type === 'measure') {
    return [eventName(e).text, ...lines.parts].join(' ');
  }

  if (e.type === 'note') {
    const text = stripAssumption(e.note);
    return text ? `Заметка: ${text}` : 'Заметка';
  }

  // Лекарство названо в subtype свободным текстом: «нурофен, 2,5 мл».
  if (e.type === 'meds') {
    return [e.subtype || 'Лекарство', ...lines.parts].join(', ');
  }

  const bits = [eventName(e).text, ...lines.parts];
  if (lines.open) bits.push('идёт');
  return bits.join(', ');
}

/** Причастия по родам: «сон завершён», «активность завершена», «кормление завершено». */
const FORM = {
  finished: { m: 'завершён', f: 'завершена', n: 'завершено' },
  changed: { m: 'изменён', f: 'изменена', n: 'изменено' },
  deleted: { m: 'удалён', f: 'удалена', n: 'удалено' },
} as const;

/**
 * Изменение фразы уже откатили: непогашенных наборов у неё не осталось.
 * Свой набор помечен `reverted_at`, а лёгший рядом набор-откат действием
 * фразы не является (§9.3: откат наследует её `utterance_id`).
 */
function isUndone(sets: ChangeSet[]): boolean {
  return sets.length > 0 && undoableSets(sets).length === 0;
}

/**
 * Что стало с записью, которую тронула фраза.
 *
 * Чем именно правка была, клиент не знает и знать не может: `GET /api/change-sets`
 * отдаёт только `events: number[]`, а снимок «до» живёт на сервере в ревизиях.
 * Поэтому здесь говорится правда о СОСТОЯНИИ записи сейчас — «сон завершён», —
 * а не догадка о том, какое поле правила модель. Что именно поменялось, человек
 * видит, развернув строку и открыв саму запись.
 */
function outcome(e: TrackerEvent, sets: ChangeSet[], gender: Gender): string {
  if (isUndone(sets)) return 'изменение отменено';
  if (e.deleted_at) return FORM.deleted[gender];

  const def = typeDef(e.type);
  // Открытый сон закрывать нечем — фраза его, наоборот, начала или сдвинула.
  if (def.openable && !e.ended_at) return 'идёт';
  if (def.ranged && e.ended_at) return FORM.finished[gender];
  return FORM.changed[gender];
}

export interface PhraseSummary {
  /** Текст свёрнутой строки. */
  text: string;
  /** true — это сырая цитата фразы, а не разбор. */
  quote: boolean;
}

/**
 * Свёрнутая строка фразы, которая не создала записей.
 *
 * Требование к журналу — «время и событие в разобранном виде, по тапу разворот».
 * У фразы, закрывшей сон, разбор есть, и он должен стоять в строке: «Сон, ночной —
 * завершён, 7 ч 10 мин». Сырая цитата «что он проснулся» выглядела необработанным
 * мусором, хотя разбор прошёл штатно.
 *
 * Единственное исключение — фраза, которую НИКТО не разобрал (`tone: 'gap'`,
 * см. lib/utterance.ts): там разбора нет вовсе, и цитата и есть суть.
 */
export function describePhrase(
  rawText: string,
  touched: TrackerEvent[],
  changeSets: ChangeSet[] = [],
): PhraseSummary {
  if (touched.length === 0) return { text: `«${rawText}»`, quote: true };

  const [first, ...rest] = touched;
  const { text: name, gender } = eventName(first);
  const bits = [`${name} — ${outcome(first, changeSets, gender)}`];

  /*
   * Длительность — только когда запись одна (иначе строка не помещается в ширину)
   * и когда изменение в силе: у откаченного «изменение отменено, 7 ч 10 мин»
   * приписывает отменённому действию результат, которого больше нет.
   */
  const mins = rest.length === 0 && !isUndone(changeSets) ? eventDurationMin(first) : null;
  if (mins != null) bits.push(formatMinutes(mins));

  let text = bits.join(', ');
  if (rest.length > 0) {
    // Остальные записи перечислены в развороте — здесь только их число.
    text += ` · ещё ${rest.length} ${plural(rest.length, 'запись', 'записи', 'записей')}`;
  }
  return { text, quote: false };
}

export function describeEvent(e: TrackerEvent): EventLines {
  const def = typeDef(e.type);
  const parts: string[] = [];
  let note = e.note?.trim() || null;

  const ranged = eventDurationMin(e);
  const startedMs = parseTs(e.started_at);
  const open =
    def.openable &&
    !e.ended_at &&
    startedMs != null &&
    Date.now() - startedMs < STILL_GOING;

  // Префикс [?] — служебная пометка модели, человеку её показывать не надо.
  if (isAssumption(note)) note = stripAssumption(note) || null;

  const value = valueText(e);
  if (value) parts.push(value);

  // Длительность показываем, когда она есть (eventDurationMin отсекает нулевую)
  // и не дублирует value: грудь и так измеряют минутами.
  if (ranged != null && !(e.value_unit === 'min' && Math.abs(ranged - (e.value_num ?? 0)) <= 1)) {
    parts.push(formatMinutes(ranged));
  }

  if (e.type === 'feed' && e.subtype === 'breast') {
    const side = breastSide(e.note);
    if (side) {
      parts.push(side);
      note = null; // сторона уже показана, дублировать не надо
    }
  }

  return {
    title: def.label,
    sub: subtypeLabel(e.type, e.subtype),
    parts,
    note,
    open,
    tone: `var(--t-${def.tone})`,
    icon: def.icon,
  };
}
