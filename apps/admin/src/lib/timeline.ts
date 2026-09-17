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
 * Знак на полосе суток. **Одно событие — один знак.**
 *
 * `count` больше единицы бывает только там, где знаки не развести, не соврав
 * про время (см. `layoutMarks`): тогда знак остаётся один и подписывается
 * числом. Посчитать события взглядом можно в обоих случаях.
 */
export interface MarkSlot {
  /** Доля суток — КУДА нарисован знак. Может не совпасть со временем. */
  pos: number;
  /** Сколько событий в знаке. */
  count: number;
  /** Настоящее время первого и последнего события знака — для подсказки. */
  firstAt: number;
  lastAt: number;
}

/** Мерки полосы в долях суток: сколько места у знака и куда ему можно. */
export interface MarkLayout {
  /** Минимальное расстояние между центрами соседних знаков. */
  pitch: number;
  /** Насколько знаку позволено отъехать от своего времени. */
  maxShift: number;
  /** Края полосы для центров знаков. */
  min?: number;
  max?: number;
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
 * Раскладка меток по полосе: **одно событие — один знак**.
 *
 * Сутки на телефоне — 336 точек, час в них помещается в четырнадцать. Знак
 * заметного размера занимает почти полчаса, поэтому у новорождённого, который
 * ест пачками, соседние кормления налезают друг на друга. Раньше такая пачка
 * рисовалась одной фигурой пошире — и заказчик читал её не как «шесть подряд»,
 * а как «одна большая отметка»: посчитать кормления взглядом было нельзя.
 *
 * Поэтому знаков всегда ровно столько, сколько событий, а налезающие соседи
 * раздвигаются до просвета `pitch` — порядок сохраняется, пачка остаётся
 * центром на среднем времени своих событий. Сдвиг в три точки экрана — это
 * десяток минут на суточной оси, и это честнее кляксы.
 *
 * Но сдвигать бесконечно нельзя, иначе плотная пачка растечётся на полосе в
 * часы, которых не было. Предел — `maxShift`: дальше пара самых тесных
 * соседей становится одним знаком с числом (`count`), и посчитать события
 * по-прежнему можно. Настоящее время при этом не теряется: `firstAt` и
 * `lastAt` остаются для подсказки.
 *
 * Мерки приходят снаружи в долях суток: они зависят от того, сколько точек
 * досталось полосе на самом деле. На телефоне раздвигать приходится часто,
 * на широком экране — почти никогда.
 */
export function layoutMarks(marks: TimeMark[], layout: MarkLayout): MarkSlot[] {
  const { pitch, maxShift, min = 0, max = 1 } = layout;
  let groups: Group[] = marks.map((m) => ({ at: m.pos, count: 1, firstAt: m.at, lastAt: m.at }));

  // Ширину полосы ещё не измерили — раздвигать не от чего, рисуем как есть.
  if (groups.length < 2 || !(pitch > 0) || max <= min) return groups.map(slot);

  // Сколько знаков помещается на полосе встык: больше не покажет никакая раскладка.
  const capacity = Math.floor((max - min) / pitch) + 1;

  for (;;) {
    if (groups.length > capacity) {
      groups = mergeTightest(groups, 0, groups.length);
      continue;
    }

    const { at, blocks } = spread(groups, pitch, min, max);
    const crowded = blocks.filter(
      (b) => b.end - b.start > 1 && worstShift(groups, at, b) > maxShift,
    );

    if (crowded.length === 0) {
      // Знак у самого края могло поджать границей полосы — это тоже сдвиг.
      const whole = { start: 0, end: groups.length };
      if (groups.length < 2 || worstShift(groups, at, whole) <= maxShift) {
        return groups.map((g, i) => ({ ...slot(g), pos: at[i] }));
      }
      groups = mergeTightest(groups, whole.start, whole.end);
      continue;
    }

    // По одной самой тесной паре в каждой не уложившейся пачке. С конца —
    // чтобы уже найденные границы не поехали от слияния слева.
    for (let k = crowded.length - 1; k >= 0; k--) {
      groups = mergeTightest(groups, crowded[k].start, crowded[k].end);
    }
  }
}

/** Знак в работе: `at` — среднее время его событий в долях суток. */
interface Group {
  at: number;
  count: number;
  firstAt: number;
  lastAt: number;
}

/** Участок подряд идущих знаков, которые раздвигались вместе. */
interface Block {
  start: number;
  /** За последним. */
  end: number;
}

function slot(g: Group): MarkSlot {
  return { pos: g.at, count: g.count, firstAt: g.firstAt, lastAt: g.lastAt };
}

/** Самый большой сдвиг знака от своего времени внутри участка. */
function worstShift(groups: Group[], at: number[], b: Block): number {
  let worst = 0;
  for (let i = b.start; i < b.end; i++) worst = Math.max(worst, Math.abs(at[i] - groups[i].at));
  return worst;
}

/**
 * Развести знаки так, чтобы просвет был не меньше `pitch`, а суммарный сдвиг
 * от настоящих времён — наименьший из возможных.
 *
 * Это изотоническая регрессия (PAVA): сдвиг i-го знака на `i * pitch` влево
 * превращает «между соседями не меньше pitch» в «значения не убывают», а
 * дальше соседние участки-нарушители сливаются в один и заменяются своим
 * средним. У такого участка знаки встают ровно через `pitch`, а середина
 * остаётся на среднем времени его событий — пачка не уезжает ни вправо,
 * ни влево, она только расправляется.
 */
function spread(
  groups: Group[],
  pitch: number,
  min: number,
  max: number,
): { at: number[]; blocks: Block[] } {
  const n = groups.length;
  const sum: number[] = [];
  const len: number[] = [];

  for (let i = 0; i < n; i++) {
    let s = groups[i].at - i * pitch;
    let l = 1;
    while (sum.length > 0 && sum[sum.length - 1] / len[len.length - 1] > s / l) {
      s += sum.pop()!;
      l += len.pop()!;
    }
    sum.push(s);
    len.push(l);
  }

  const at = new Array<number>(n);
  const blocks: Block[] = [];
  let i = 0;
  for (let b = 0; b < sum.length; b++) {
    const level = sum[b] / len[b];
    blocks.push({ start: i, end: i + len[b] });
    for (let k = 0; k < len[b]; k++, i++) at[i] = level + i * pitch;
  }

  // Края полосы: пачка у полуночи не имеет права уехать за них. Проход слева
  // держит начало суток и просвет, проход справа — конец суток, подтягивая
  // за собой соседей слева.
  for (let j = 0; j < n; j++) {
    at[j] = j === 0 ? Math.max(at[j], min) : Math.max(at[j], at[j - 1] + pitch);
  }
  for (let j = n - 1; j >= 0; j--) {
    at[j] = j === n - 1 ? Math.min(at[j], max) : Math.min(at[j], at[j + 1] - pitch);
  }

  return { at, blocks };
}

/**
 * Слить самую тесную пару соседей на участке в один знак с числом.
 *
 * Сливается именно пара, а не весь участок: так знаков остаётся столько,
 * сколько полоса честно выдерживает, и ритм видно даже там, где считать
 * приходится по подписям.
 */
function mergeTightest(groups: Group[], start: number, end: number): Group[] {
  if (end - start < 2) return groups;

  let best = start;
  let bestGap = Infinity;
  for (let i = start; i + 1 < end; i++) {
    const gap = groups[i + 1].at - groups[i].at;
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }

  const a = groups[best];
  const b = groups[best + 1];
  const count = a.count + b.count;
  const merged: Group = {
    // Слитый знак стоит на среднем времени своих событий, а не «где-то между».
    at: (a.at * a.count + b.at * b.count) / count,
    count,
    firstAt: a.firstAt,
    lastAt: b.lastAt,
  };
  return [...groups.slice(0, best), merged, ...groups.slice(best + 2)];
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
