/**
 * Границы локальных суток и таймзона (§1, §3.2, §3.4).
 *
 * В БД всё в UTC, показываем в локальной зоне — классическое место ошибки на сутки.
 * Цена ошибки здесь не косметическая: сон, уехавший в соседние сутки, врёт маме
 * про режим ребёнка, а «сегодня спал 0 минут» после ночи выглядит правдоподобно.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig, testDb } from './helpers.ts';
import { dailySleep, getState, insertEvent, sleepStatsForRange, startSleep } from '../src/events.ts';
import {
  civilToUtcMs,
  daysBetween,
  localDateISO,
  localDayStartMs,
  minutesBetween,
  shiftLocalDate,
  toIsoUtc,
  zonedParts,
} from '../src/time.ts';
import type { Db } from '../src/db.ts';

const cfg = testConfig(); // Europe/Moscow, UTC+3 круглый год

/** Момент по московскому времени как ISO UTC. */
function msk(day: number, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 8, day, (h ?? 0) - 3, m ?? 0)).toISOString();
}

function addSleep(db: Db, startedAt: string, endedAt: string | null, subtype = 'nap'): void {
  insertEvent(db, { type: 'sleep', subtype, source: 'manual', started_at: startedAt, ended_at: endedAt });
}

/* ------------------------------------------------------------------ */
/* Стык суток                                                          */
/* ------------------------------------------------------------------ */

test('события в 23:59 и в 00:01 локального времени расходятся по разным суткам', () => {
  const db = testDb();
  addSleep(db, msk(15, '23:59'), msk(16, '00:00')); // 1 минута 15-го
  addSleep(db, msk(16, '00:01'), msk(16, '00:05')); // 4 минуты 16-го

  const days = dailySleep(db, cfg, 2, new Date(msk(16, '12:00')));
  assert.deepEqual(
    days.map((d) => [d.date, d.totalMin, d.sessions]),
    [
      ['2026-09-15', 1, 1],
      ['2026-09-16', 4, 1],
    ],
  );
});

test('локальная дата меняется ровно в полночь по TZ, а не по UTC', () => {
  assert.equal(localDateISO(new Date('2026-09-15T20:59:59Z'), 'Europe/Moscow'), '2026-09-15');
  assert.equal(localDateISO(new Date('2026-09-15T21:00:00Z'), 'Europe/Moscow'), '2026-09-16');
  // та же метка в UTC — всё ещё 15-е
  assert.equal(localDateISO(new Date('2026-09-15T21:00:00Z'), 'UTC'), '2026-09-15');
});

test('полночь по ICU — это час 0, а не 24', () => {
  const parts = zonedParts(new Date('2026-09-15T21:00:00Z'), 'Europe/Moscow');
  assert.deepEqual(parts, { year: 2026, month: 9, day: 16, hour: 0, minute: 0, second: 0 });
});

test('сон через полночь честно делится между сутками', () => {
  const db = testDb();
  addSleep(db, msk(15, '22:00'), msk(16, '02:00'), 'night'); // 4 часа через полночь

  const days = dailySleep(db, cfg, 2, new Date(msk(16, '12:00')));
  assert.deepEqual(
    days.map((d) => [d.date, d.totalMin, d.nightMin, d.sessions]),
    [
      ['2026-09-15', 120, 120, 1],
      ['2026-09-16', 120, 120, 1],
    ],
  );
  const total = days.reduce((sum, d) => sum + d.totalMin, 0);
  assert.equal(total, 240, 'суммарно ни минуты не потеряно и ни одна не посчитана дважды');
});

test('сон ровно от полуночи до полуночи целиком принадлежит одним суткам', () => {
  const db = testDb();
  addSleep(db, msk(16, '00:00'), msk(17, '00:00'), 'night');

  const days = dailySleep(db, cfg, 3, new Date(msk(17, '12:00')));
  assert.deepEqual(
    days.map((d) => [d.date, d.totalMin]),
    [
      ['2026-09-15', 0],
      ['2026-09-16', 1440],
      ['2026-09-17', 0],
    ],
    'границы окна полуоткрыты: [начало суток, начало следующих)',
  );
});

test('смена суток во время открытого сна: новые сутки считают только свою часть', () => {
  const db = testDb();
  startSleep(db, cfg, { at: msk(15, '23:00') }); // сон идёт, конца нет

  const state = getState(db, cfg, new Date(msk(16, '01:00')));
  assert.equal(state.today.date, '2026-09-16', 'сутки уже новые');
  assert.equal(state.today.sleepTotalMin, 60, 'в новых сутках — только час после полуночи');
  assert.equal(state.today.sleepSessions, 1);
  assert.equal(state.sleep.status, 'asleep');
  assert.equal(state.sleep.currentDurationMin, 120, 'таймер текущего сна идёт от начала, не от полуночи');
});

test('открытый сон учитывается только до «сейчас», а не до конца суток', () => {
  const db = testDb();
  startSleep(db, cfg, { at: msk(16, '10:00') });

  const state = getState(db, cfg, new Date(msk(16, '11:30')));
  assert.equal(state.today.sleepTotalMin, 90);
  assert.equal(state.today.longestSleepMin, 90);
});

test('сон вчерашних суток не попадает в сегодняшнюю сводку', () => {
  const db = testDb();
  addSleep(db, msk(15, '10:00'), msk(15, '12:00'));

  const state = getState(db, cfg, new Date(msk(16, '09:00')));
  assert.equal(state.today.date, '2026-09-16');
  assert.equal(state.today.sleepTotalMin, 0);
  assert.equal(state.today.sleepSessions, 0);
  assert.equal(state.sleep.status, 'awake');
  assert.equal(state.sleep.lastSleep?.durationMin, 120, 'но последний сон помнится');
});

/* ------------------------------------------------------------------ */
/* Другие таймзоны                                                     */
/* ------------------------------------------------------------------ */

test('в UTC и в Москве одно и то же событие попадает в разные сутки', () => {
  const db = testDb();
  addSleep(db, '2026-09-15T22:00:00.000Z', '2026-09-15T23:00:00.000Z');

  const moscow = dailySleep(db, testConfig({ TZ: 'Europe/Moscow' }), 2, new Date('2026-09-16T10:00:00Z'));
  const utc = dailySleep(db, testConfig({ TZ: 'UTC' }), 2, new Date('2026-09-16T10:00:00Z'));

  assert.equal(moscow.find((d) => d.date === '2026-09-16')?.totalMin, 60, 'по Москве это уже 16-е');
  assert.equal(utc.find((d) => d.date === '2026-09-15')?.totalMin, 60, 'по UTC это ещё 15-е');
});

test('таймзона с получасовым смещением не сдвигает сутки на час', () => {
  assert.equal(
    new Date(localDayStartMs('2026-09-15', 'Asia/Kolkata')).toISOString(),
    '2026-09-14T18:30:00.000Z',
  );
  assert.equal(localDateISO(new Date('2026-09-14T18:29:00Z'), 'Asia/Kolkata'), '2026-09-14');
  assert.equal(localDateISO(new Date('2026-09-14T18:30:00Z'), 'Asia/Kolkata'), '2026-09-15');
});

test('перевод часов: сутки длиной 23 и 25 часов считаются по календарю, а не по 86400 с', () => {
  const springForward =
    localDayStartMs('2026-03-30', 'Europe/Berlin') - localDayStartMs('2026-03-29', 'Europe/Berlin');
  const fallBack =
    localDayStartMs('2026-10-26', 'Europe/Berlin') - localDayStartMs('2026-10-25', 'Europe/Berlin');

  assert.equal(springForward / 3_600_000, 23, 'в ночь перевода вперёд сутки короче');
  assert.equal(fallBack / 3_600_000, 25, 'в ночь перевода назад сутки длиннее');
});

test('сон через перевод часов не приобретает и не теряет час', () => {
  const db = testDb();
  const berlin = testConfig({ TZ: 'Europe/Berlin' });
  // 2026-03-29, Берлин: 01:30 -> 03:30 местного = ровно 60 минут реального времени
  addSleep(db, '2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z', 'night');

  const days = dailySleep(db, berlin, 1, new Date('2026-03-29T12:00:00Z'));
  assert.equal(days[0]?.date, '2026-03-29');
  assert.equal(days[0]?.totalMin, 60, 'считаем реальное время сна, а не разницу стрелок');
});

test('несуществующее локальное время в ночь перевода не даёт NaN', () => {
  const ms = civilToUtcMs({ year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 }, 'Europe/Berlin');
  assert.equal(Number.isFinite(ms), true);
  assert.equal(new Date(ms).toISOString(), '2026-03-29T01:30:00.000Z');
});

/* ------------------------------------------------------------------ */
/* Календарная арифметика                                              */
/* ------------------------------------------------------------------ */

test('сдвиг локальной даты идёт по календарю: месяцы, годы, високосный февраль', () => {
  assert.equal(shiftLocalDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftLocalDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftLocalDate('2026-02-28', 1), '2026-03-01');
  assert.equal(shiftLocalDate('2028-02-28', 1), '2028-02-29', '2028 — високосный');
  assert.equal(shiftLocalDate('2026-09-15', 0), '2026-09-15');
});

test('возраст ребёнка считается в целых сутках и не уходит в минус', () => {
  assert.equal(daysBetween('2026-03-01', '2026-03-01'), 0);
  assert.equal(daysBetween('2026-03-01', '2026-03-02'), 1);
  assert.equal(daysBetween('2026-03-01', '2026-09-15'), 198);
  assert.equal(daysBetween('2026-09-15', '2026-03-01'), -198);
  assert.equal(daysBetween('мусор', '2026-09-15'), 0, 'битая дата не роняет расчёт');

  const db = testDb();
  const state = getState(db, cfg, new Date(msk(15, '12:00')));
  assert.equal(state.child.ageDays, 198);

  // ребёнок «из будущего» — возраст не отрицательный
  const future = getState(db, testConfig({ CHILD_BIRTHDATE: '2027-01-01' }), new Date(msk(15, '12:00')));
  assert.equal(future.child.ageDays, 0);
});

test('приведение времени к UTC: смещение учитывается, мусор отбрасывается', () => {
  assert.equal(toIsoUtc('2026-09-15T10:00:00+03:00'), '2026-09-15T07:00:00.000Z');
  assert.equal(toIsoUtc('2026-09-15T07:00:00Z'), '2026-09-15T07:00:00.000Z');
  assert.equal(toIsoUtc('мусор'), null);
  assert.equal(toIsoUtc(''), null);
  assert.equal(minutesBetween('2026-09-15T10:00:00Z', '2026-09-15T11:30:59Z'), 90, 'округление вниз');
  assert.equal(minutesBetween('2026-09-15T11:00:00Z', '2026-09-15T10:00:00Z'), 0, 'минуса не бывает');
  assert.equal(minutesBetween('мусор', '2026-09-15T10:00:00Z'), 0);
});

test('окно сводки полуоткрыто: минута в начале входит, минута в конце — уже нет', () => {
  const db = testDb();
  const from = localDayStartMs('2026-09-16', cfg.tz);
  const to = localDayStartMs('2026-09-17', cfg.tz);

  addSleep(db, new Date(from).toISOString(), new Date(from + 60_000).toISOString());
  addSleep(db, new Date(to - 60_000).toISOString(), new Date(to).toISOString());
  addSleep(db, new Date(to).toISOString(), new Date(to + 60_000).toISOString());

  const stats = sleepStatsForRange(db, from, to, to);
  assert.equal(stats.sessions, 2, 'сон, начавшийся ровно в полночь следующих суток, сюда не входит');
  assert.equal(stats.totalMin, 2);
});
