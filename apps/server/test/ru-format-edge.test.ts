/**
 * Русское форматирование — крайние значения.
 *
 * Эти строки Алиса произносит вслух и дашборд показывает с трёх метров.
 * «21 минут» или «1 часов» — не опечатка в логе, а то, что слышит мама.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAYS,
  HOURS,
  MINUTES,
  MINUTES_ACC,
  PHRASES,
  SLEEPS,
  TIMES,
  formatDateLocal,
  formatDateTimeLocal,
  formatDurationRu,
  formatDurationRuAcc,
  formatDurationShort,
  formatTimeLocal,
  localDateISO,
  pluralRu,
  withUnit,
} from '../src/ru.ts';

const TZ = 'Europe/Moscow';

/* ------------------------------------------------------------------ */
/* Склонения                                                           */
/* ------------------------------------------------------------------ */

test('склонение на 1, 2, 5, 11, 21, 101, 111 — полный набор ловушек', () => {
  const cases: Array<[number, string]> = [
    [0, 'дней'],
    [1, 'день'],
    [2, 'дня'],
    [4, 'дня'],
    [5, 'дней'],
    [11, 'дней'],
    [12, 'дней'],
    [14, 'дней'],
    [15, 'дней'],
    [21, 'день'],
    [22, 'дня'],
    [25, 'дней'],
    [100, 'дней'],
    [101, 'день'],
    [102, 'дня'],
    [105, 'дней'],
    [111, 'дней'],
    [112, 'дней'],
    [121, 'день'],
    [1000, 'дней'],
    [1001, 'день'],
    [1011, 'дней'],
    [1021, 'день'],
    [1111, 'дней'],
  ];
  for (const [n, expected] of cases) {
    assert.equal(pluralRu(n, DAYS), expected, `${n} — ожидалось «${expected}»`);
  }
});

test('11–14 всегда «много», сколько бы сотен ни было впереди', () => {
  for (const base of [0, 100, 200, 1000, 12_300]) {
    for (const tail of [11, 12, 13, 14]) {
      assert.equal(
        pluralRu(base + tail, MINUTES),
        'минут',
        `${base + tail} должно быть «минут»`,
      );
    }
  }
});

test('ноль — это «много», а не «один»', () => {
  assert.equal(pluralRu(0, MINUTES), 'минут');
  assert.equal(pluralRu(0, HOURS), 'часов');
  assert.equal(pluralRu(0, SLEEPS), 'снов');
  assert.equal(pluralRu(0, TIMES), 'раз');
  assert.equal(pluralRu(0, PHRASES), 'фраз');
});

test('отрицательные и дробные числа склоняются по модулю и целой части', () => {
  assert.equal(pluralRu(-1, MINUTES), 'минута');
  assert.equal(pluralRu(-2, MINUTES), 'минуты');
  assert.equal(pluralRu(-5, MINUTES), 'минут');
  assert.equal(pluralRu(-11, MINUTES), 'минут');
  assert.equal(pluralRu(-21, MINUTES), 'минута');
  assert.equal(pluralRu(1.9, MINUTES), 'минута', 'дробь отбрасывается, а не округляется');
  assert.equal(pluralRu(2.9, MINUTES), 'минуты');
});

test('очень большие значения не ломают выбор формы', () => {
  assert.equal(pluralRu(1_000_001, MINUTES), 'минута');
  assert.equal(pluralRu(1_000_011, MINUTES), 'минут');
  assert.equal(pluralRu(1_000_000, MINUTES), 'минут');
  // ...740991 — последние две цифры 91, значит «минута»
  assert.equal(pluralRu(Number.MAX_SAFE_INTEGER, MINUTES), 'минута');
});

test('все словари согласованы между собой по форме числа', () => {
  for (const forms of [MINUTES, MINUTES_ACC, HOURS, DAYS, TIMES, SLEEPS, PHRASES]) {
    assert.equal(forms.length, 3, 'форм ровно три: одна, две, пять');
    for (const n of [1, 2, 5, 11, 21, 101, 111]) {
      assert.equal(typeof pluralRu(n, forms), 'string');
      assert.notEqual(pluralRu(n, forms).length, 0);
    }
  }
});

test('винительный падеж отличается только минутами', () => {
  assert.equal(withUnit(1, MINUTES), '1 минута');
  assert.equal(withUnit(1, MINUTES_ACC), '1 минуту');
  assert.equal(withUnit(21, MINUTES_ACC), '21 минуту');
  assert.equal(withUnit(5, MINUTES_ACC), '5 минут');
  assert.equal(withUnit(1, HOURS), '1 час', 'часы в винительном совпадают с именительным');
});

/* ------------------------------------------------------------------ */
/* Длительности                                                        */
/* ------------------------------------------------------------------ */

test('длительность: нули, округление и граница «меньше минуты»', () => {
  assert.equal(formatDurationRu(0), 'меньше минуты');
  assert.equal(formatDurationRu(0.4), 'меньше минуты');
  assert.equal(formatDurationRu(0.5), '1 минута', '30 секунд округляются до минуты');
  assert.equal(formatDurationRu(59.6), '1 час');
  assert.equal(formatDurationRu(-100), 'меньше минуты', 'минус не озвучивается');
});

test('длительность в сутки и больше остаётся в часах, без «дней»', () => {
  assert.equal(formatDurationRu(1440), '24 часа');
  assert.equal(formatDurationRu(1441), '24 часа 1 минута');
  assert.equal(formatDurationRu(10_080), '168 часов');
  assert.equal(formatDurationRuAcc(1501), '25 часов 1 минуту');
});

test('круглый час не договаривает «0 минут»', () => {
  assert.equal(formatDurationRu(60), '1 час');
  assert.equal(formatDurationRu(120), '2 часа');
  assert.equal(formatDurationRu(300), '5 часов');
  assert.equal(formatDurationRuAcc(60), '1 час');
});

test('короткий формат дополняет минуты нулём и не теряет часы', () => {
  assert.equal(formatDurationShort(0), '0:00');
  assert.equal(formatDurationShort(5), '0:05');
  assert.equal(formatDurationShort(95), '1:35');
  assert.equal(formatDurationShort(1440), '24:00');
  assert.equal(formatDurationShort(-5), '0:00');
});

test(
  'БАГ: нечисловая длительность даёт пустую строку и «Infinity часов»',
  {
  },
  () => {
    assert.equal(formatDurationRu(Number.NaN), 'меньше минуты');
    assert.equal(formatDurationRuAcc(Number.NaN), 'меньше минуты');
    assert.equal(formatDurationShort(Number.NaN), '0:00');
    assert.doesNotMatch(formatDurationRu(Number.POSITIVE_INFINITY), /Infinity/);
  },
);

/* ------------------------------------------------------------------ */
/* Время и дата                                                        */
/* ------------------------------------------------------------------ */

test('локальное время: полночь, однозначные часы, Date и строка одинаково', () => {
  assert.equal(formatTimeLocal('2026-09-15T21:00:00.000Z', TZ), '00:00');
  assert.equal(formatTimeLocal('2026-09-15T00:05:00.000Z', TZ), '03:05');
  assert.equal(formatTimeLocal(new Date('2026-09-15T14:32:00.000Z'), TZ), '17:32');
  assert.equal(formatTimeLocal('2026-09-15T14:32:00.000Z', 'UTC'), '14:32');
});

test('битая метка времени даёт заглушку, а не «Invalid Date» вслух', () => {
  assert.equal(formatTimeLocal('мусор', TZ), '--:--');
  assert.equal(formatTimeLocal('', TZ), '--:--');
  assert.equal(formatDateLocal('мусор', TZ), '');
  assert.equal(formatDateTimeLocal('мусор', TZ), ', --:--');
});

test('дата по-русски: родительный падеж месяца и переход через полночь', () => {
  assert.equal(formatDateLocal('2026-09-15T14:32:00.000Z', TZ), '15 сентября');
  assert.equal(formatDateLocal('2026-09-15T21:00:00.000Z', TZ), '16 сентября', 'после полуночи МСК');
  assert.equal(formatDateLocal('2026-01-01T00:00:00.000Z', 'UTC'), '1 января');
  assert.equal(formatDateLocal('2026-12-31T00:00:00.000Z', 'UTC'), '31 декабря');
  assert.equal(formatDateTimeLocal('2026-12-31T21:30:00.000Z', TZ), '1 января, 00:30');
});

test('все двенадцать месяцев названы и в родительном падеже', () => {
  const expected = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  for (let month = 1; month <= 12; month++) {
    const iso = `2026-${String(month).padStart(2, '0')}-10T12:00:00.000Z`;
    assert.equal(formatDateLocal(iso, 'UTC'), `10 ${expected[month - 1]}`);
  }
});

test('localDateISO реэкспортирован из ru — слой представления знает один модуль', () => {
  assert.equal(localDateISO(new Date('2026-09-15T21:00:00.000Z'), TZ), '2026-09-16');
});
