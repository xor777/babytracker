/** Русские склонения и форматирование длительностей. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOURS,
  MINUTES,
  SLEEPS,
  formatDurationRu,
  formatDurationRuAcc,
  formatDurationShort,
  formatTimeLocal,
  pluralRu,
  withUnit,
} from '../src/ru.ts';

test('склонение минут: граничные случаи', () => {
  const cases: Array<[number, string]> = [
    [0, 'минут'],
    [1, 'минута'],
    [2, 'минуты'],
    [3, 'минуты'],
    [4, 'минуты'],
    [5, 'минут'],
    [10, 'минут'],
    [11, 'минут'],
    [12, 'минут'],
    [13, 'минут'],
    [14, 'минут'],
    [15, 'минут'],
    [20, 'минут'],
    [21, 'минута'],
    [22, 'минуты'],
    [25, 'минут'],
    [101, 'минута'],
    [111, 'минут'],
    [121, 'минута'],
  ];
  for (const [n, expected] of cases) {
    assert.equal(pluralRu(n, MINUTES), expected, `${n} минут(а/ы)`);
  }
});

test('склонение часов: граничные случаи', () => {
  const cases: Array<[number, string]> = [
    [1, 'час'],
    [2, 'часа'],
    [4, 'часа'],
    [5, 'часов'],
    [11, 'часов'],
    [21, 'час'],
    [22, 'часа'],
    [101, 'час'],
  ];
  for (const [n, expected] of cases) {
    assert.equal(pluralRu(n, HOURS), expected, `${n} час(а/ов)`);
  }
});

test('склонение снов', () => {
  assert.equal(pluralRu(1, SLEEPS), 'сон');
  assert.equal(pluralRu(4, SLEEPS), 'сна');
  assert.equal(pluralRu(5, SLEEPS), 'снов');
});

test('withUnit собирает число и слово', () => {
  assert.equal(withUnit(1, MINUTES), '1 минута');
  assert.equal(withUnit(21, HOURS), '21 час');
});

test('длительность словами', () => {
  assert.equal(formatDurationRu(0), 'меньше минуты');
  assert.equal(formatDurationRu(0.4), 'меньше минуты');
  assert.equal(formatDurationRu(1), '1 минута');
  assert.equal(formatDurationRu(2), '2 минуты');
  assert.equal(formatDurationRu(5), '5 минут');
  assert.equal(formatDurationRu(11), '11 минут');
  assert.equal(formatDurationRu(21), '21 минута');
  assert.equal(formatDurationRu(45), '45 минут');
  assert.equal(formatDurationRu(60), '1 час');
  assert.equal(formatDurationRu(61), '1 час 1 минута');
  assert.equal(formatDurationRu(95), '1 час 35 минут');
  assert.equal(formatDurationRu(120), '2 часа');
  assert.equal(formatDurationRu(122), '2 часа 2 минуты');
  assert.equal(formatDurationRu(300), '5 часов');
  assert.equal(formatDurationRu(1281), '21 час 21 минута');
  assert.equal(formatDurationRu(101), '1 час 41 минута');
});

test('винительный падеж: «спал 1 минуту», а не «1 минута»', () => {
  assert.equal(formatDurationRuAcc(1), '1 минуту');
  assert.equal(formatDurationRuAcc(2), '2 минуты');
  assert.equal(formatDurationRuAcc(5), '5 минут');
  assert.equal(formatDurationRuAcc(11), '11 минут');
  assert.equal(formatDurationRuAcc(21), '21 минуту');
  assert.equal(formatDurationRuAcc(101), '1 час 41 минуту');
  assert.equal(formatDurationRuAcc(95), '1 час 35 минут');
  assert.equal(formatDurationRuAcc(60), '1 час');
  assert.equal(formatDurationRuAcc(0), 'меньше минуты');
});

test('отрицательная длительность не ломает вывод', () => {
  assert.equal(formatDurationRu(-10), 'меньше минуты');
});

test('короткий формат длительности', () => {
  assert.equal(formatDurationShort(95), '1:35');
  assert.equal(formatDurationShort(45), '0:45');
  assert.equal(formatDurationShort(0), '0:00');
});

test('локальное время в TZ сервера', () => {
  assert.equal(formatTimeLocal('2026-09-15T14:32:05.123Z', 'Europe/Moscow'), '17:32');
  assert.equal(formatTimeLocal('2026-09-15T14:32:05.123Z', 'UTC'), '14:32');
  assert.equal(formatTimeLocal('2026-09-15T21:05:00.000Z', 'Europe/Moscow'), '00:05');
  assert.equal(formatTimeLocal('мусор', 'Europe/Moscow'), '--:--');
});
