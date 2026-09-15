/**
 * §10.1–10.2 — суточная аналитика и нормы.
 *
 * По этим числам родитель решает, хватает ли ребёнку питья и еды: мокрые
 * подгузники — главный признак достаточного питья, кормления — достаточности
 * питания. Заниженный счётчик здесь не «неточность в интерфейсе», а повод
 * для ложного спокойствия.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig, testDb } from './helpers.ts';
import { dailyStats, insertEvent, softDeleteEvent } from '../src/events.ts';
import { normsForAge } from '../src/taxonomy.ts';
import type { Db } from '../src/db.ts';

const cfg = testConfig(); // ребёнок родился 2026-03-01, TZ Europe/Moscow
const NOW = new Date('2026-09-15T12:00:00.000Z');

function add(db: Db, type: string, subtype: string | null, extra: Record<string, unknown> = {}): void {
  insertEvent(db, {
    type,
    subtype,
    source: 'manual',
    started_at: '2026-09-15T09:00:00.000Z',
    ...extra,
  });
}

const today = (db: Db) => dailyStats(db, cfg, 1, NOW)[0]!;

/* ------------------------------------------------------------------ */
/* Подгузники                                                          */
/* ------------------------------------------------------------------ */

test('подгузники считаются по подтипам и в сумме', () => {
  const db = testDb();
  add(db, 'diaper', 'wet');
  add(db, 'diaper', 'wet');
  add(db, 'diaper', 'dirty');
  add(db, 'diaper', 'both');

  const stats = today(db);
  assert.equal(stats.diapers.total, 4);
  assert.equal(stats.diapers.both, 1);
});

test(
  'БАГ: «и пописал, и покакал» не засчитывается ни в мокрые, ни в грязные',
  () => {
    const db = testDb();
    for (let i = 0; i < 6; i++) add(db, 'diaper', 'both');

    const stats = today(db);
    assert.equal(stats.diapers.wet, 6, 'both — это и мокрый подгузник тоже');
    assert.equal(stats.diapers.dirty, 6, 'и грязный тоже');
    assert.ok(stats.diapers.wet >= stats.norms.wetDiapers.min, 'норма по питью выполнена');
  },
);

test('удалённый подгузник из статистики уходит', () => {
  const db = testDb();
  add(db, 'diaper', 'wet');
  const second = insertEvent(db, {
    type: 'diaper',
    subtype: 'wet',
    source: 'manual',
    started_at: '2026-09-15T10:00:00.000Z',
  }).event;
  assert.equal(today(db).diapers.wet, 2);

  softDeleteEvent(db, second.id);
  assert.equal(today(db).diapers.wet, 1, 'мягко удалённое не считается');
});

/* ------------------------------------------------------------------ */
/* Кормления и объём                                                   */
/* ------------------------------------------------------------------ */

test('кормления считаются по подтипам, объём суммируется только по названному', () => {
  const db = testDb();
  add(db, 'feed', 'breast', { value_num: 15, value_unit: 'min' });
  add(db, 'feed', 'bottle', { value_num: 90, value_unit: 'ml' });
  add(db, 'feed', 'bottle', { value_num: 30, value_unit: 'ml' });
  add(db, 'feed', 'solid');

  const stats = today(db);
  assert.equal(stats.feeds.total, 4);
  assert.equal(stats.feeds.breast, 1);
  assert.equal(stats.feeds.bottle, 2);
  assert.equal(stats.feeds.solid, 1);
  assert.equal(stats.feeds.volumeMl, 120, 'минуты груди в миллилитры не приплюсовываются');
});

test('объём не выдумывается: ни одного названного числа — null, а не ноль (§10.2)', () => {
  const db = testDb();
  add(db, 'feed', 'breast');
  add(db, 'feed', 'breast', { value_num: 20, value_unit: 'min' });

  const stats = today(db);
  assert.equal(stats.feeds.total, 2);
  assert.equal(stats.feeds.volumeMl, null, 'ноль означал бы «покормили нулём миллилитров»');
});

/* ------------------------------------------------------------------ */
/* Измерения                                                           */
/* ------------------------------------------------------------------ */

test('вес приводится к граммам независимо от того, в чём его назвали', () => {
  const db = testDb();
  add(db, 'measure', 'weight', { value_num: 5.4, value_unit: 'kg' });
  assert.equal(today(db).measures.weightG, 5400);

  const db2 = testDb();
  add(db2, 'measure', 'weight', { value_num: 5400, value_unit: 'g' });
  assert.equal(today(db2).measures.weightG, 5400);
});

test('из нескольких измерений за сутки берётся последнее, температура — максимальная', () => {
  const db = testDb();
  add(db, 'measure', 'weight', { value_num: 5.0, value_unit: 'kg', started_at: '2026-09-15T06:00:00.000Z' });
  add(db, 'measure', 'weight', { value_num: 5.2, value_unit: 'kg', started_at: '2026-09-15T09:00:00.000Z' });
  add(db, 'measure', 'temp', { value_num: 37.2, value_unit: 'c', started_at: '2026-09-15T06:00:00.000Z' });
  add(db, 'measure', 'temp', { value_num: 38.4, value_unit: 'c', started_at: '2026-09-15T07:00:00.000Z' });
  add(db, 'measure', 'temp', { value_num: 36.9, value_unit: 'c', started_at: '2026-09-15T09:00:00.000Z' });

  const stats = today(db);
  assert.equal(stats.measures.weightG, 5200, 'вес — последний за сутки');
  assert.equal(stats.measures.tempMaxC, 38.4, 'температура — худшая за сутки, а не последняя');
});

test('окружность головы — отдельный подтип head, не рост', () => {
  const db = testDb();
  add(db, 'measure', 'height', { value_num: 62, value_unit: 'cm' });
  add(db, 'measure', 'head', { value_num: 40.5, value_unit: 'cm' });

  const stats = today(db);
  assert.equal(stats.measures.heightCm, 62);
  assert.equal(stats.measures.headCm, 40.5);
});

test('не измеряли — null, а не ноль и не прошлое значение', () => {
  const db = testDb();
  add(db, 'feed', 'breast');

  const stats = today(db);
  assert.deepEqual(stats.measures, { weightG: null, heightCm: null, headCm: null, tempMaxC: null });
});

/* ------------------------------------------------------------------ */
/* Нормы AAP (§10.1)                                                   */
/* ------------------------------------------------------------------ */

test('норма мокрых подгузников растёт по дням и с 5-го дня фиксируется на 6', () => {
  assert.equal(normsForAge(0).wetDiapers.min, 1, 'возраст 0 дней — это первые сутки');
  assert.equal(normsForAge(1).wetDiapers.min, 2);
  assert.equal(normsForAge(2).wetDiapers.min, 3);
  assert.equal(normsForAge(3).wetDiapers.min, 4);
  assert.equal(normsForAge(4).wetDiapers.min, 6, 'пятые сутки — уже 6+');
  assert.equal(normsForAge(30).wetDiapers.min, 6);
  assert.equal(normsForAge(365).wetDiapers.min, 6);
});

test('нормы кормлений и грязных подгузников отдаются с пояснением, а не голым порогом', () => {
  const norms = normsForAge(14);
  assert.deepEqual([norms.feeds.min, norms.feeds.max], [8, 12]);
  assert.deepEqual([norms.dirtyDiapers.min, norms.dirtyDiapers.max], [3, 4]);
  for (const note of [norms.feeds.note, norms.wetDiapers.note, norms.dirtyDiapers.note]) {
    assert.ok(note.length > 0, 'норма без пояснения читается как жёсткий порог');
  }
});

test('возраст в норме не уходит в минус и не дробится', () => {
  assert.equal(normsForAge(-5).ageDays, 0);
  assert.equal(normsForAge(-5).wetDiapers.min, 1);
  assert.equal(normsForAge(13.7).ageDays, 13);
});

test('нормы в суточной статистике считаются на дату самих суток, а не на сегодня', () => {
  const db = testDb();
  add(db, 'feed', 'breast');

  const days = dailyStats(db, cfg, 3, NOW);
  assert.deepEqual(
    days.map((d) => [d.date, d.ageDays]),
    [
      ['2026-09-13', 196],
      ['2026-09-14', 197],
      ['2026-09-15', 198],
    ],
    'у каждых суток свой возраст ребёнка',
  );
});

/* ------------------------------------------------------------------ */
/* Границы суток в статистике                                          */
/* ------------------------------------------------------------------ */

test('событие в 00:30 МСК относится к новым суткам, а не к прошедшим', () => {
  const db = testDb();
  // 2026-09-15 21:30Z = 16 сентября 00:30 МСК
  add(db, 'feed', 'bottle', { started_at: '2026-09-15T21:30:00.000Z', value_num: 60, value_unit: 'ml' });

  const days = dailyStats(db, cfg, 2, new Date('2026-09-16T12:00:00.000Z'));
  assert.equal(days.find((d) => d.date === '2026-09-15')?.feeds.total, 0);
  assert.equal(days.find((d) => d.date === '2026-09-16')?.feeds.total, 1);
});

test('сон в суточной статистике совпадает с лентой сна', () => {
  const db = testDb();
  insertEvent(db, {
    type: 'sleep',
    subtype: 'night',
    source: 'manual',
    started_at: '2026-09-14T19:00:00.000Z', // 22:00 МСК 14-го
    ended_at: '2026-09-15T03:00:00.000Z', // 06:00 МСК 15-го
  });

  const days = dailyStats(db, cfg, 2, NOW);
  assert.equal(days.find((d) => d.date === '2026-09-14')?.sleep.totalMin, 120);
  assert.equal(days.find((d) => d.date === '2026-09-15')?.sleep.totalMin, 360);
});
