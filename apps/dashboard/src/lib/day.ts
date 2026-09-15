import type { TrackerEvent } from '../types';
import { parseTs } from './format';
import { zonedDateString } from './tz';

/** Дата события в зоне отображения, YYYY-MM-DD. */
export function localDate(ms: number): string {
  return zonedDateString(ms);
}

export function isAlive(ev: TrackerEvent): boolean {
  return !ev.deleted_at;
}

/** Человеческое название события. Служебные значения сюда не попадают — см. §10.2. */
const SUBTYPE_LABEL: Record<string, Record<string, string>> = {
  sleep: { night: 'ночной сон', nap: 'дневной сон' },
  feed: { breast: 'грудь', bottle: 'бутылочка', solid: 'прикорм' },
  diaper: { wet: 'мокрый', dirty: 'грязный', both: 'мокрый и грязный' },
  measure: { weight: 'вес', height: 'рост', head: 'окружность головы', temp: 'температура' },
  activity: { bath: 'купание', walk: 'прогулка', tummy_time: 'на животе' },
  symptom: {
    spit_up: 'срыгивание',
    vomit: 'рвота',
    rash: 'сыпь',
    colic: 'колики',
    crying: 'плач',
    fever: 'температура',
  },
};

const TYPE_LABEL: Record<string, string> = {
  sleep: 'сон',
  feed: 'кормление',
  pump: 'сцеживание',
  diaper: 'подгузник',
  measure: 'замер',
  meds: 'лекарство',
  symptom: 'самочувствие',
  activity: 'занятие',
  note: 'заметка',
};

export function eventLabel(ev: TrackerEvent): string | null {
  const byType = SUBTYPE_LABEL[ev.type];
  if (byType && ev.subtype && byType[ev.subtype]) return byType[ev.subtype];
  return TYPE_LABEL[ev.type] ?? null;
}

/** Чем кормили: «бутылочка 120 мл», «грудь 15 мин». */
export function feedLabel(ev: TrackerEvent | null): string | null {
  if (!ev) return null;
  const what = (ev.subtype && SUBTYPE_LABEL.feed[ev.subtype]) || 'кормление';
  const n = ev.value_num;
  // Округление до нуля («0 мин», «0 мл») на весь экран кричит о том, чего не было:
  // это не «покормили нулём», а «значения по сути нет». Тогда называем только чем.
  if (typeof n === 'number' && Number.isFinite(n) && Math.round(n) > 0) {
    if (ev.value_unit === 'ml') return `${what} ${Math.round(n)} мл`;
    if (ev.value_unit === 'min') return `${what} ${Math.round(n)} мин`;
  }
  return what;
}

export interface FeedSummary {
  count: number;
  /** Сумма только по тем кормлениям, где объём назван (контракт §10.2: NULL ≠ 0). */
  totalMl: number;
  withMl: number;
  last: TrackerEvent | null;
  /** Предпоследнее кормление — нужно, когда текущее ещё идёт. */
  prev: TrackerEvent | null;
  everRecorded: boolean;
}

export interface DiaperSummary {
  count: number;
  wet: number;
  dirty: number;
  everRecorded: boolean;
}

export interface DaySummary {
  feeds: FeedSummary;
  diapers: DiaperSummary;
}

function ofType(events: TrackerEvent[], type: string): TrackerEvent[] {
  return events.filter((ev) => ev.type === type && isAlive(ev));
}

export function summarizeDay(events: TrackerEvent[], today: string): DaySummary {
  const feeds = ofType(events, 'feed');
  const todayFeeds = feeds.filter((ev) => {
    const ms = parseTs(ev.started_at);
    return ms != null && localDate(ms) === today;
  });
  const withMl = todayFeeds.filter((ev) => ev.value_unit === 'ml' && typeof ev.value_num === 'number');
  const byRecency = feeds
    .slice()
    .sort((a, b) => (parseTs(b.started_at) ?? 0) - (parseTs(a.started_at) ?? 0));
  const lastFeed = byRecency[0] ?? null;
  const prevFeed = byRecency[1] ?? null;

  const diapers = ofType(events, 'diaper');
  const todayDiapers = diapers.filter((ev) => {
    const ms = parseTs(ev.started_at);
    return ms != null && localDate(ms) === today;
  });

  return {
    feeds: {
      count: todayFeeds.length,
      totalMl: withMl.reduce((acc, ev) => acc + (ev.value_num ?? 0), 0),
      withMl: withMl.length,
      last: lastFeed,
      prev: prevFeed,
      everRecorded: feeds.length > 0,
    },
    diapers: {
      count: todayDiapers.length,
      wet: todayDiapers.filter((ev) => ev.subtype === 'wet' || ev.subtype === 'both').length,
      dirty: todayDiapers.filter((ev) => ev.subtype === 'dirty' || ev.subtype === 'both').length,
      everRecorded: diapers.length > 0,
    },
  };
}

export interface WeightPoint {
  at: number;
  grams: number;
}

/**
 * Ряд взвешиваний по возрастанию времени. Единицы приводим к граммам:
 * контракт разрешает и `g`, и `kg`.
 */
export function weightSeries(events: TrackerEvent[]): WeightPoint[] {
  const out: WeightPoint[] = [];
  for (const ev of events) {
    if (ev.type !== 'measure' || !isAlive(ev)) continue;
    if (ev.subtype !== 'weight') continue;
    const at = parseTs(ev.started_at);
    const n = ev.value_num;
    if (at == null || typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
    const grams = ev.value_unit === 'kg' ? n * 1000 : n < 100 ? n * 1000 : n;
    out.push({ at, grams: Math.round(grams) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** «4 584» — узкий пробел между разрядами, чтобы число читалось с трёх метров. */
export function formatGrams(grams: number): string {
  return Math.round(grams).toLocaleString('ru-RU').replace(/ /g, ' ');
}

export function formatDelta(grams: number): string {
  const sign = grams > 0 ? '+' : grams < 0 ? '−' : '';
  return `${sign}${formatGrams(Math.abs(grams))} г`;
}

/* ============================================================
   Идущее занятие: кормление, сцеживание, купание и прочее
   ============================================================ */

/**
 * Сколько минут открытое событие ещё можно считать идущим.
 *
 * Чтобы засечь длительность, нужны две фразы — «начал кушать» и «поел», —
 * и вторую будут забывать, особенно ночью. После порога мы перестаём
 * утверждать, что событие идёт. Закрывать его сами не имеем права:
 * когда оно кончилось, нам никто не сказал, а выдумывать факты нельзя.
 *
 * Сон в этой таблице отсутствует намеренно: шесть часов сна — это правда,
 * а не забытая фраза, порога у него быть не должно.
 */
const OPEN_LIMIT_MIN: Record<string, number> = {
  feed: 90,
  pump: 45,
  'activity:bath': 60,
  'activity:walk': 180,
  'activity:tummy_time': 45,
  activity: 120,
};

const ONGOING_WORD: Record<string, { word: string; noun: string }> = {
  feed: { word: 'КУШАЕТ', noun: 'кормление' },
  pump: { word: 'СЦЕЖИВАНИЕ', noun: 'сцеживание' },
  'activity:bath': { word: 'КУПАЕТСЯ', noun: 'купание' },
  'activity:walk': { word: 'НА ПРОГУЛКЕ', noun: 'прогулка' },
  'activity:tummy_time': { word: 'НА ЖИВОТЕ', noun: 'время на животе' },
  activity: { word: 'ЗАНЯТИЕ', noun: 'занятие' },
};

export interface OngoingActivity {
  event: TrackerEvent;
  startedAt: number;
  /** true — порог пройден: событие висит открытым, идущим его не считаем. */
  stale: boolean;
  limitMin: number;
  word: string;
  noun: string;
}

function limitFor(ev: TrackerEvent): number | null {
  const key = ev.subtype ? `${ev.type}:${ev.subtype}` : ev.type;
  return OPEN_LIMIT_MIN[key] ?? OPEN_LIMIT_MIN[ev.type] ?? null;
}

function wordsFor(ev: TrackerEvent): { word: string; noun: string } {
  const key = ev.subtype ? `${ev.type}:${ev.subtype}` : ev.type;
  return ONGOING_WORD[key] ?? ONGOING_WORD[ev.type] ?? { word: 'ЗАНЯТИЕ', noun: 'занятие' };
}

/**
 * Самое свежее открытое событие с длительностью (кроме сна — он отдельно).
 * Возвращается и просроченное: его надо показать нейтрально, а не спрятать.
 */
export function findOngoing(events: TrackerEvent[], now: number): OngoingActivity | null {
  let best: OngoingActivity | null = null;
  for (const ev of events) {
    if (!isAlive(ev) || ev.ended_at) continue;
    const limitMin = limitFor(ev);
    if (limitMin == null) continue;
    const startedAt = parseTs(ev.started_at);
    if (startedAt == null || startedAt > now + 60_000) continue;
    const candidate: OngoingActivity = {
      event: ev,
      startedAt,
      stale: now - startedAt > limitMin * 60_000,
      limitMin,
      ...wordsFor(ev),
    };
    if (!best || candidate.startedAt > best.startedAt) best = candidate;
  }
  return best;
}
