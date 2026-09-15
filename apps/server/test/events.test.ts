/** Доменные инварианты: один открытый сон, пробуждение без сна, сводки. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig, testDb } from './helpers.ts';
import {
  dailySleep,
  endSleep,
  findOpenSleep,
  getState,
  insertEvent,
  queryEvents,
  sleepSubtype,
  softDeleteEvent,
  startSleep,
  updateEvent,
} from '../src/events.ts';
import { all } from '../src/db.ts';
import type { EventRow } from '../src/types.ts';

function openSleepCount(db: ReturnType<typeof testDb>): number {
  return all<EventRow>(
    db,
    `SELECT id FROM events WHERE type='sleep' AND ended_at IS NULL AND deleted_at IS NULL`,
  ).length;
}

test('инвариант: два «заснул» подряд не создают два открытых сна', () => {
  const db = testDb();
  const cfg = testConfig();

  const first = startSleep(db, cfg, { at: '2026-09-15T14:00:00.000Z' });
  assert.equal(first.status, 'created');

  const second = startSleep(db, cfg, { at: '2026-09-15T14:10:00.000Z' });
  assert.equal(second.status, 'already_open');
  assert.equal(second.event.id, first.event.id);

  const third = startSleep(db, cfg, { at: '2026-09-15T14:20:00.000Z' });
  assert.equal(third.status, 'already_open');

  assert.equal(openSleepCount(db), 1, 'открытый сон должен быть ровно один');
  assert.equal(queryEvents(db, { type: 'sleep' }).length, 1, 'лишних событий сна быть не должно');

  db.close();
});

test('инвариант держится и при прямой вставке (политика close-previous)', () => {
  const db = testDb();

  insertEvent(db, { type: 'sleep', started_at: '2026-09-15T10:00:00.000Z', source: 'manual' });
  const { event, closedPrevious } = insertEvent(db, {
    type: 'sleep',
    started_at: '2026-09-15T12:00:00.000Z',
    source: 'manual',
  });

  assert.ok(closedPrevious, 'предыдущий открытый сон должен быть закрыт');
  assert.equal(closedPrevious?.ended_at, '2026-09-15T12:00:00.000Z');
  assert.equal(event.ended_at, null);
  assert.equal(openSleepCount(db), 1);

  db.close();
});

test('«проснулся» без открытого сна не падает и фиксирует факт', () => {
  const db = testDb();
  const cfg = testConfig();

  const res = endSleep(db, cfg, { at: '2026-09-15T14:00:00.000Z' });
  assert.equal(res.status, 'no_open_sleep');
  assert.equal(res.event.type, 'note');
  assert.match(res.event.note ?? '', /Проснулся/);
  // пустых снов в статистике быть не должно
  assert.equal(queryEvents(db, { type: 'sleep' }).length, 0);

  db.close();
});

test('цикл заснул -> проснулся закрывает сон и считает длительность', () => {
  const db = testDb();
  const cfg = testConfig();

  startSleep(db, cfg, { at: '2026-09-15T10:00:00.000Z' });
  const res = endSleep(db, cfg, { at: '2026-09-15T11:35:00.000Z' });

  assert.equal(res.status, 'closed');
  assert.equal(res.durationMin, 95);
  assert.equal(res.event.ended_at, '2026-09-15T11:35:00.000Z');
  assert.equal(findOpenSleep(db), null);

  db.close();
});

test('время пробуждения раньше засыпания не даёт отрицательной длительности', () => {
  const db = testDb();
  const cfg = testConfig();

  startSleep(db, cfg, { at: '2026-09-15T10:00:00.000Z' });
  const res = endSleep(db, cfg, { at: '2026-09-15T09:00:00.000Z' });

  assert.equal(res.status, 'closed');
  assert.equal(res.durationMin, 0);
  assert.equal(res.event.ended_at, '2026-09-15T10:00:00.000Z');

  db.close();
});

test('subtype сна: ночь с 19:00 до 06:00 локального времени', () => {
  const tz = 'Europe/Moscow';
  assert.equal(sleepSubtype('2026-09-15T17:00:00.000Z', tz), 'night'); // 20:00 МСК
  assert.equal(sleepSubtype('2026-09-15T11:00:00.000Z', tz), 'nap'); // 14:00 МСК
  assert.equal(sleepSubtype('2026-09-15T00:30:00.000Z', tz), 'night'); // 03:30 МСК
  assert.equal(sleepSubtype('2026-09-15T04:00:00.000Z', tz), 'nap'); // 07:00 МСК
});

test('getState отражает сон и сводку за сутки', () => {
  const db = testDb();
  const cfg = testConfig();
  const now = new Date('2026-09-15T14:00:00.000Z'); // 17:00 МСК

  // завершённый дневной сон 11:00-12:30 МСК
  insertEvent(db, {
    type: 'sleep',
    subtype: 'nap',
    started_at: '2026-09-15T08:00:00.000Z',
    ended_at: '2026-09-15T09:30:00.000Z',
    source: 'manual',
  });
  // текущий сон с 16:00 МСК
  insertEvent(db, {
    type: 'sleep',
    subtype: 'nap',
    started_at: '2026-09-15T13:00:00.000Z',
    source: 'manual',
  });

  const state = getState(db, cfg, now);

  assert.equal(state.sleep.status, 'asleep');
  assert.equal(state.sleep.since, '2026-09-15T13:00:00.000Z');
  assert.equal(state.sleep.currentDurationMin, 60);
  assert.equal(state.sleep.lastSleep?.durationMin, 90);
  assert.equal(state.today.date, '2026-09-15');
  assert.equal(state.today.sleepSessions, 2);
  assert.equal(state.today.sleepTotalMin, 150);
  assert.equal(state.today.longestSleepMin, 90);
  assert.equal(state.child.name, 'Андрей');
  assert.equal(state.child.ageDays, 198);
  assert.equal(state.pending, 0);

  db.close();
});

test('бодрствование: since = конец последнего сна', () => {
  const db = testDb();
  const cfg = testConfig();
  const now = new Date('2026-09-15T14:00:00.000Z');

  insertEvent(db, {
    type: 'sleep',
    started_at: '2026-09-15T11:00:00.000Z',
    ended_at: '2026-09-15T13:00:00.000Z',
    source: 'manual',
  });

  const state = getState(db, cfg, now);
  assert.equal(state.sleep.status, 'awake');
  assert.equal(state.sleep.since, '2026-09-15T13:00:00.000Z');
  assert.equal(state.sleep.currentDurationMin, 60);

  db.close();
});

test('пустая база: состояние корректно и без снов', () => {
  const db = testDb();
  const cfg = testConfig();
  const state = getState(db, cfg, new Date('2026-09-15T14:00:00.000Z'));

  assert.equal(state.sleep.status, 'awake');
  assert.equal(state.sleep.since, null);
  assert.equal(state.sleep.lastSleep, null);
  assert.equal(state.today.sleepTotalMin, 0);
  assert.equal(state.today.sleepSessions, 0);

  db.close();
});

test('ночной сон делится между сутками по локальной полуночи', () => {
  const db = testDb();
  const cfg = testConfig();
  // 22:00 14-го — 07:00 15-го по Москве
  insertEvent(db, {
    type: 'sleep',
    subtype: 'night',
    started_at: '2026-09-14T19:00:00.000Z',
    ended_at: '2026-09-15T04:00:00.000Z',
    source: 'manual',
  });

  const days = dailySleep(db, cfg, 2, new Date('2026-09-15T14:00:00.000Z'));
  assert.equal(days.length, 2);
  assert.equal(days[0]?.date, '2026-09-14');
  assert.equal(days[0]?.totalMin, 120, '22:00–24:00 14-го');
  assert.equal(days[1]?.date, '2026-09-15');
  assert.equal(days[1]?.totalMin, 420, '00:00–07:00 15-го');
  assert.equal(days[1]?.nightMin, 420);
  assert.equal(days[1]?.napMin, 0);

  db.close();
});

test('мягкое удаление убирает событие из выборок', () => {
  const db = testDb();
  const { event } = insertEvent(db, {
    type: 'sleep',
    started_at: '2026-09-15T10:00:00.000Z',
    ended_at: '2026-09-15T11:00:00.000Z',
    source: 'manual',
  });

  assert.equal(queryEvents(db, {}).length, 1);
  const deleted = softDeleteEvent(db, event.id);
  assert.ok(deleted?.deleted_at);
  assert.equal(queryEvents(db, {}).length, 0);
  assert.equal(softDeleteEvent(db, event.id), null, 'повторное удаление возвращает null');

  db.close();
});

test('updateEvent правит поля и нормализует время', () => {
  const db = testDb();
  const { event } = insertEvent(db, {
    type: 'sleep',
    started_at: '2026-09-15T10:00:00.000Z',
    source: 'manual',
  });

  const updated = updateEvent(db, event.id, {
    ended_at: '2026-09-15T12:00:00Z',
    note: 'поправлено',
  });

  assert.equal(updated?.ended_at, '2026-09-15T12:00:00.000Z');
  assert.equal(updated?.note, 'поправлено');
  assert.equal(updateEvent(db, 999999, { note: 'нет такого' }), null);

  db.close();
});

test('queryEvents уважает фильтры и лимит', () => {
  const db = testDb();
  for (let i = 0; i < 5; i++) {
    insertEvent(db, {
      type: 'feed',
      subtype: 'bottle',
      started_at: `2026-09-1${i}T10:00:00.000Z`,
      ended_at: `2026-09-1${i}T10:20:00.000Z`,
      value_num: 120,
      value_unit: 'ml',
      source: 'manual',
    });
  }
  insertEvent(db, {
    type: 'sleep',
    started_at: '2026-09-15T10:00:00.000Z',
    ended_at: '2026-09-15T11:00:00.000Z',
    source: 'manual',
  });

  assert.equal(queryEvents(db, { type: 'feed' }).length, 5);
  assert.equal(queryEvents(db, { type: 'sleep' }).length, 1);
  assert.equal(queryEvents(db, { limit: 2 }).length, 2);
  assert.equal(queryEvents(db, { from: '2026-09-13T00:00:00.000Z' }).length, 3);

  const sorted = queryEvents(db, { type: 'feed' });
  assert.ok((sorted[0]?.started_at ?? '') > (sorted[1]?.started_at ?? ''), 'сортировка DESC');

  db.close();
});
