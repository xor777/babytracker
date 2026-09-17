/**
 * Полоса суток целиком: от событий дневника до знаков на экране.
 *
 * Заказчик смотрит полосу с телефона и считает по ней события глазами.
 * Раньше близкие кормления склеивались в одну фигуру пошире — и «шесть подряд»
 * читалось как «одна большая отметка», а два близких подгузника — как один
 * треугольник крупнее соседних. Здесь проверяется именно то, что он видит:
 * сходится ли число знаков с числом событий в легенде.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildDayTimeline, layoutMarks } from '../src/lib/timeline';
import type { MarkSlot } from '../src/lib/timeline';
import type { TrackerEvent } from '../src/types';

const DAY_START = Date.parse('2026-09-16T00:00:00.000Z');
const MINUTE = 60_000;

/** Полоса на телефоне: 336 точек на сутки. Те же числа, что в DayStrip.tsx. */
const PHONE = { pitch: 11 / 336, maxShift: 4 / 336 };
/** Та же полоса на узком экране: 280 точек. Раздвигать становится некуда. */
const NARROW = { pitch: 11 / 280, maxShift: 4 / 280 };

let seq = 0;

function event(type: string, hh: number, mm: number, extra: Partial<TrackerEvent> = {}): TrackerEvent {
  return {
    id: ++seq,
    type,
    started_at: new Date(DAY_START + (hh * 60 + mm) * MINUTE).toISOString(),
    ...extra,
  };
}

/** Настоящий день 16 сентября: пятнадцать кормлений и семь подгузников. */
const FEEDS: [number, number][] = [
  [0, 19],
  [2, 59],
  [4, 59],
  [8, 15],
  [9, 15],
  [12, 16],
  [14, 11],
  [15, 13],
  [17, 55],
  [18, 35],
  [19, 33],
  [20, 1],
  [20, 43],
  [21, 48],
  [22, 50],
];
const DIAPERS: [number, number][] = [
  [1, 10],
  [5, 20],
  [9, 40],
  [13, 5],
  [17, 30],
  [20, 55],
  [21, 20],
];

function realDay(): TrackerEvent[] {
  return [
    ...FEEDS.map(([h, m]) => event('feed', h, m)),
    ...DIAPERS.map(([h, m]) => event('diaper', h, m)),
  ];
}

/** Сколько событий обещают знаки — это число и стоит в легенде полосы. */
function total(slots: MarkSlot[]): number {
  return slots.reduce((sum, s) => sum + s.count, 0);
}

test('настоящий день: пятнадцать кормлений — пятнадцать знаков', () => {
  const day = buildDayTimeline(realDay(), DAY_START, DAY_START + 12 * 60 * MINUTE);
  const slots = layoutMarks(day.feeds, PHONE);

  assert.equal(slots.length, 15, 'знаков на полосе меньше, чем кормлений в легенде');
  assert.equal(total(slots), 15);
});

test('вечерняя пачка кормлений — семь знаков, а не колбаса', () => {
  // 17:55, 18:35, 19:33, 20:01, 20:43, 21:48, 22:50 — именно на этот кусок
  // полосы заказчик и жаловался.
  const day = buildDayTimeline(realDay(), DAY_START, DAY_START + 12 * 60 * MINUTE);
  const evening = layoutMarks(day.feeds, PHONE).filter((s) => s.firstAt >= DAY_START + 17 * 60 * MINUTE);

  assert.equal(evening.length, 7);
  assert.equal(total(evening), 7);
});

test('два подгузника подряд — два одинаковых знака', () => {
  // 20:55 и 21:20: раньше на их месте был один треугольник заметно крупнее
  // остальных, и заказчик читал его как одно событие.
  const day = buildDayTimeline(realDay(), DAY_START, DAY_START + 12 * 60 * MINUTE);
  const slots = layoutMarks(day.diapers, PHONE);

  assert.equal(slots.length, 7);
  assert.deepEqual(
    slots.map((s) => s.count),
    [1, 1, 1, 1, 1, 1, 1],
    'знак с числом означал бы, что пару не удалось развести',
  );
});

test('удалённое событие на полосу не попадает', () => {
  const events = [
    event('feed', 8, 0),
    event('feed', 12, 0, { deleted_at: '2026-09-16T13:00:00.000Z' }),
    event('feed', 16, 0),
  ];
  const day = buildDayTimeline(events, DAY_START, DAY_START + 20 * 60 * MINUTE);
  const slots = layoutMarks(day.feeds, PHONE);

  assert.equal(total(slots), 2);
});

test('редкие кормления полоса не трогает вовсе', () => {
  const events = [event('feed', 7, 0), event('feed', 11, 0), event('feed', 15, 0)];
  const day = buildDayTimeline(events, DAY_START, DAY_START + 20 * 60 * MINUTE);
  const slots = layoutMarks(day.feeds, PHONE);

  slots.forEach((s, i) => {
    assert.ok(Math.abs(s.pos - day.feeds[i].pos) < 1e-12, `знак ${i} сдвинули без нужды`);
  });
});

test('на узком экране число событий всё равно сходится', () => {
  // Места меньше, часть знаков становится общими — но сумма по подписям
  // обязана остаться той же, иначе легенда и полоса разойдутся.
  const day = buildDayTimeline(realDay(), DAY_START, DAY_START + 12 * 60 * MINUTE);
  const slots = layoutMarks(day.feeds, NARROW);

  assert.equal(total(slots), 15);
  assert.ok(slots.length >= 12, `знаков осталось всего ${slots.length} — полоса схлопнулась зря`);
});

test('в подсказке остаётся настоящее время, даже если знак сдвинули', () => {
  const day = buildDayTimeline(realDay(), DAY_START, DAY_START + 12 * 60 * MINUTE);
  const slots = layoutMarks(day.feeds, PHONE);
  const real = day.feeds.map((m) => m.at);

  assert.deepEqual(
    slots.map((s) => s.firstAt),
    real,
    'знаки разошлись со временами событий',
  );
  assert.deepEqual(
    slots.map((s) => s.lastAt),
    real,
  );
});
