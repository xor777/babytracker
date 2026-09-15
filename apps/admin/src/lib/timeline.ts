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
 */
export function feedGaps(marks: TimeMark[]): { avgMin: number; maxMin: number } | null {
  if (marks.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < marks.length; i++) {
    gaps.push(Math.round((marks[i].at - marks[i - 1].at) / MINUTE));
  }
  return {
    avgMin: Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length),
    maxMin: Math.max(...gaps),
  };
}
