/**
 * Склейка меток на полосе суток.
 *
 * Сутки на телефоне — 390 точек, и метка заметного размера занимает получаса.
 * Кормления новорождённого идут пачками, поэтому вопрос не «показать каждое»,
 * а «не превратить пачку в неразличимую кашу из чёрточек».
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { clusterMarks } from '../src/lib/timeline';
import type { TimeMark } from '../src/lib/timeline';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const T0 = Date.parse('2026-09-15T00:00:00.000Z');

/** Метка через `min` минут после начала суток. */
function mark(min: number): TimeMark {
  return { at: T0 + min * MINUTE, pos: (min * MINUTE) / DAY, label: '' };
}

/** Порог, при котором склеиваются метки ближе `min` минут друг к другу. */
function gapOf(min: number): number {
  return (min * MINUTE) / DAY;
}

test('пустая дорожка — ни одной фигуры', () => {
  assert.deepEqual(clusterMarks([], gapOf(45)), []);
});

test('одиночная метка — пачка нулевой длины, а не особый случай', () => {
  const runs = clusterMarks([mark(400)], gapOf(45));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].count, 1);
  assert.equal(runs[0].from, runs[0].to);
});

test('редкие кормления остаются отдельными фигурами', () => {
  // Три часа между кормлениями — на полосе это сантиметр, склеивать нечего.
  const runs = clusterMarks([mark(0), mark(180), mark(360)], gapOf(45));
  assert.equal(runs.length, 3);
});

test('пачка с промежутком в 20 минут склеивается в одну фигуру', () => {
  const runs = clusterMarks([mark(390), mark(410), mark(430)], gapOf(45));
  assert.equal(runs.length, 1);
  assert.deepEqual(
    { count: runs[0].count, first: runs[0].firstAt, last: runs[0].lastAt },
    { count: 3, first: T0 + 390 * MINUTE, last: T0 + 430 * MINUTE },
  );
});

test('слипание считается попарно: цепочка не рвётся на середине', () => {
  // Пять кормлений с шагом 20 минут — это восемьдесят минут подряд. Если бы
  // расстояние мерилось от начала пачки, цепочка развалилась бы на куски.
  const runs = clusterMarks([mark(0), mark(20), mark(40), mark(60), mark(80)], gapOf(45));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].count, 5);
});

test('пачка кончается там, где пошёл настоящий промежуток', () => {
  const runs = clusterMarks([mark(0), mark(20), mark(200), mark(220)], gapOf(45));
  assert.deepEqual(
    runs.map((r) => r.count),
    [2, 2],
  );
});

test('на широком экране порог меньше — та же пачка расходится на метки', () => {
  // Тот же день в браузере на большом мониторе: места хватает всем.
  const marks = [mark(390), mark(410), mark(430)];
  assert.equal(clusterMarks(marks, gapOf(15)).length, 3);
});

test('нулевой порог не склеивает ничего', () => {
  // Пока ширина полосы не измерена, склейка должна выключаться, а не
  // схлопывать все сутки в одну фигуру.
  const runs = clusterMarks([mark(0), mark(0), mark(1)], 0);
  assert.equal(runs.length, 3);
});

test('дубль разбора не ломает пачку', () => {
  // Два одинаковых времени — обычное дело: «покормила» и следом «грудью».
  const runs = clusterMarks([mark(100), mark(100)], gapOf(45));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].count, 2);
  assert.equal(runs[0].from, runs[0].to);
});
