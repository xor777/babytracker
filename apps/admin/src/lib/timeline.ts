/**
 * Раскладка событий по суткам — для полосы дня.
 *
 * Полоса суток — главный инструмент для новорождённого: ритм видно целиком,
 * и она остаётся осмысленной, когда событий три штуки: ось часов на месте,
 * а пустота честно означает «пока не записывали».
 */
import type { TrackerEvent } from '../types';
import { DAY, MINUTE, parseTs, startOfLocalDay } from './format';

export interface SleepBlock {
  /** Доли суток 0..1 — позиция и ширина в полосе. */
  from: number;
  to: number;
  /** Сон ещё идёт (упирается в «сейчас»). */
  open: boolean;
  minutes: number;
}

export interface TimeMark {
  at: number;
  /** Доля суток 0..1. */
  pos: number;
  label: string;
}

/**
 * Пачка меток, слипшихся на полосе в одну фигуру.
 *
 * Одиночная метка — это тоже пачка из одной: рисуется одним и тем же
 * правилом, просто нулевой длины.
 */
export interface MarkRun {
  /** Доля суток — центр первой метки пачки. */
  from: number;
  /** Доля суток — центр последней метки пачки. */
  to: number;
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface DayTimeline {
  dayStart: number;
  dayEnd: number;
  sleeps: SleepBlock[];
  feeds: TimeMark[];
  diapers: TimeMark[];
  /** Доля суток для отметки «сейчас»; null, если день не сегодняшний. */
  nowPos: number | null;
  /** Суммарный сон в пределах этих суток, минуты. */
  sleepMin: number;
}

/** Сколько минут события попало в интервал; сон через полночь режется по границе. */
function clip(from: number, to: number, lo: number, hi: number): [number, number] | null {
  const a = Math.max(from, lo);
  const b = Math.min(to, hi);
  return b > a ? [a, b] : null;
}

export function buildDayTimeline(
  events: TrackerEvent[],
  dayStart: number,
  now = Date.now(),
): DayTimeline {
  const dayEnd = dayStart + DAY;
  const span = dayEnd - dayStart;
  const sleeps: SleepBlock[] = [];
  const feeds: TimeMark[] = [];
  const diapers: TimeMark[] = [];
  let sleepMin = 0;

  for (const e of events) {
    if (e.deleted_at) continue;
    const at = parseTs(e.started_at);
    if (at == null) continue;

    if (e.type === 'sleep') {
      // Открытый сон тянется до «сейчас», но не дальше конца суток.
      const rawEnd = parseTs(e.ended_at) ?? Math.min(now, dayEnd);
      const piece = clip(at, rawEnd, dayStart, dayEnd);
      if (!piece) continue;
      const [a, b] = piece;
      sleepMin += Math.round((b - a) / MINUTE);
      sleeps.push({
        from: (a - dayStart) / span,
        to: (b - dayStart) / span,
        open: !e.ended_at,
        minutes: Math.round((b - a) / MINUTE),
      });
      continue;
    }

    if (at < dayStart || at >= dayEnd) continue;
    const mark: TimeMark = { at, pos: (at - dayStart) / span, label: '' };
    if (e.type === 'feed') feeds.push(mark);
    else if (e.type === 'diaper') diapers.push(mark);
  }

  sleeps.sort((a, b) => a.from - b.from);
  feeds.sort((a, b) => a.at - b.at);
  diapers.sort((a, b) => a.at - b.at);

  const isToday = startOfLocalDay(now) === dayStart;
  return {
    dayStart,
    dayEnd,
    sleeps,
    feeds,
    diapers,
    nowPos: isToday ? (now - dayStart) / span : null,
    sleepMin,
  };
}

/**
 * Склейка меток, которые всё равно налезли бы друг на друга.
 *
 * Сутки на телефоне — это 390 точек, час помещается в шестнадцать. Метка
 * заметного размера занимает получаса, поэтому у новорождённого, который ест
 * пачками, соседние кормления неизбежно слипаются в кашу из полосок. Полоса
 * отвечает на вопрос «какой ритм был за сутки», а не «перечисли мне события»,
 * — поэтому пачку честнее показать одной фигурой от первой метки до последней,
 * чем набором неразличимых чёрточек. Точное число остаётся в легенде и в
 * подсказке, а по журналу его видно поимённо.
 *
 * `minGap` — минимальный зазор между центрами меток в долях суток, при котором
 * они ещё читаются раздельно. Он зависит от реальной ширины полосы, поэтому
 * приходит снаружи: на телефоне склеек больше, на широком экране меньше.
 *
 * Слипание считается попарно, а не от начала пачки: пять кормлений с шагом
 * в двадцать минут — это одна непрерывная цепочка, а не пять отдельных фигур.
 */
export function clusterMarks(marks: TimeMark[], minGap: number): MarkRun[] {
  const runs: MarkRun[] = [];
  for (const m of marks) {
    const last = runs[runs.length - 1];
    if (last && minGap > 0 && m.pos - last.to < minGap) {
      last.to = m.pos;
      last.lastAt = m.at;
      last.count += 1;
      continue;
    }
    runs.push({ from: m.pos, to: m.pos, count: 1, firstAt: m.at, lastAt: m.at });
  }
  return runs;
}

/** Последнее по времени событие нужного типа — «когда в последний раз…». */
export function lastOfType(events: TrackerEvent[], type: string): TrackerEvent | null {
  let best: TrackerEvent | null = null;
  let bestMs = -Infinity;
  for (const e of events) {
    if (e.deleted_at || e.type !== type) continue;
    const ms = parseTs(e.started_at);
    if (ms != null && ms > bestMs) {
      bestMs = ms;
      best = e;
    }
  }
  return best;
}

/**
 * Промежутки между кормлениями за сутки — то, что у новорождённого спрашивают
 * чаще всего: «давно ли ел». Меньше двух кормлений — промежутков ещё нет.
 *
 * Нулевые промежутки выбрасываются: два кормления в одну минуту — это дубль
 * разбора или уточнение («покормила» и следом «грудью»), а не промежуток.
 * Иначе на экран попадало «между кормлениями в среднем 0 мин».
 */
export function feedGaps(marks: TimeMark[]): { avgMin: number; maxMin: number } | null {
  if (marks.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < marks.length; i++) {
    const gap = Math.round((marks[i].at - marks[i - 1].at) / MINUTE);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  return {
    avgMin: Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length),
    maxMin: Math.max(...gaps),
  };
}
