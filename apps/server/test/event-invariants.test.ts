/**
 * Инварианты событий (§1, §4).
 *
 * Дневник ребёнка восстановить неоткуда, поэтому проверяется не «функция вернула
 * значение», а «в базе не может возникнуть состояние, которое врёт»: два открытых
 * сна, сон с отрицательной длительностью, событие, тихо выпавшее из сводок.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig, testDb } from './helpers.ts';
import {
  clampLimit,
  dailySleep,
  endSleep,
  findOpenSleep,
  getState,
  insertEvent,
  lastFinishedSleep,
  queryEvents,
  sleepStatsForRange,
  sleepSubtype,
  softDeleteEvent,
  startSleep,
  updateEvent,
} from '../src/events.ts';
import { all } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import type { EventRow } from '../src/types.ts';

const cfg = testConfig();

function openSleeps(db: Db): EventRow[] {
  return all<EventRow>(
    db,
    `SELECT id, started_at FROM events
      WHERE type = 'sleep' AND ended_at IS NULL AND deleted_at IS NULL`,
  );
}

/** Ни одно событие в базе не может кончаться раньше, чем началось. */
function assertNoNegativeDurations(db: Db, where: string): void {
  const broken = all<EventRow>(
    db,
    `SELECT id, started_at, ended_at FROM events
      WHERE ended_at IS NOT NULL AND ended_at < started_at`,
  );
  assert.deepEqual(broken, [], `${where}: событие кончается раньше, чем началось`);
}

/* ------------------------------------------------------------------ */
/* Один открытый сон                                                   */
/* ------------------------------------------------------------------ */

test('пять «заснул» подряд оставляют ровно один открытый сон', () => {
  const db = testDb();
  for (let i = 0; i < 5; i++) startSleep(db, cfg, { at: `2026-09-15T1${i}:00:00.000Z` });
  assert.equal(openSleeps(db).length, 1);
  // повторное «заснул» не плодит событий вообще: сон уже идёт
  assert.equal(queryEvents(db, { type: 'sleep' }).length, 1);
});

test('открытый сон, начатый РАНЬШЕ уже идущего, не ломает инвариант и не даёт минуса', () => {
  const db = testDb();
  insertEvent(db, { type: 'sleep', source: 'manual', started_at: '2026-09-15T12:00:00.000Z' });
  const res = insertEvent(
    db,
    { type: 'sleep', source: 'manual', started_at: '2026-09-15T10:00:00.000Z' },
    'close-previous',
  );

  assert.equal(openSleeps(db).length, 1, 'открытым может быть только один сон');
  assert.equal(res.closedPrevious?.ended_at, '2026-09-15T12:00:00.000Z');
  assertNoNegativeDurations(db, 'сон задним числом');
});

test('политика reject не закрывает чужой сон, а честно отказывает', () => {
  const db = testDb();
  insertEvent(db, { type: 'sleep', source: 'manual', started_at: '2026-09-15T12:00:00.000Z' });
  assert.throws(
    () =>
      insertEvent(
        db,
        { type: 'sleep', source: 'manual', started_at: '2026-09-15T13:00:00.000Z' },
        'reject',
      ),
    /открытый сон/,
  );
  assert.equal(openSleeps(db).length, 1);
  assert.equal(findOpenSleep(db)?.started_at, '2026-09-15T12:00:00.000Z');
});

test('закрытый сон больше не считается открытым и попадает в «последний сон»', () => {
  const db = testDb();
  startSleep(db, cfg, { at: '2026-09-15T10:00:00.000Z' });
  endSleep(db, cfg, { at: '2026-09-15T11:30:00.000Z' });

  assert.equal(findOpenSleep(db), null);
  assert.equal(lastFinishedSleep(db)?.ended_at, '2026-09-15T11:30:00.000Z');
  assert.equal(openSleeps(db).length, 0);
});

test('сон другого ребёнка не считается открытым сном нашего', () => {
  const db = testDb();
  insertEvent(db, {
    type: 'sleep',
    source: 'manual',
    started_at: '2026-09-15T10:00:00.000Z',
    child_id: 'sister',
  });
  assert.equal(findOpenSleep(db), null, 'открытый сон ищется по своему child_id');
  assert.equal(findOpenSleep(db, 'sister')?.child_id, 'sister');
});

/* ------------------------------------------------------------------ */
/* Пробуждение без сна и время не по порядку                           */
/* ------------------------------------------------------------------ */

test('«проснулся» без открытого сна фиксирует факт заметкой, а не теряет его', () => {
  const db = testDb();
  const res = endSleep(db, cfg, { at: '2026-09-15T10:00:00.000Z' });

  assert.equal(res.status, 'no_open_sleep');
  assert.equal(res.event.type, 'note');
  assert.match(res.event.note ?? '', /засыпание не было зафиксировано/);
  assert.equal(res.event.ended_at, '2026-09-15T10:00:00.000Z', 'заметка — точечное событие');
});

test('два «проснулся» подряд: второй не закрывает ничего повторно', () => {
  const db = testDb();
  startSleep(db, cfg, { at: '2026-09-15T10:00:00.000Z' });
  const first = endSleep(db, cfg, { at: '2026-09-15T11:00:00.000Z' });
  const second = endSleep(db, cfg, { at: '2026-09-15T11:05:00.000Z' });

  assert.equal(first.status, 'closed');
  assert.equal(second.status, 'no_open_sleep');
  assert.equal(queryEvents(db, { type: 'sleep' }).length, 1);
  assert.equal(queryEvents(db, { type: 'sleep' })[0]?.ended_at, '2026-09-15T11:00:00.000Z');
});

test('пробуждение раньше засыпания не создаёт отрицательной длительности', () => {
  const db = testDb();
  startSleep(db, cfg, { at: '2026-09-15T10:00:00.000Z' });
  const res = endSleep(db, cfg, { at: '2026-09-15T08:00:00.000Z' });

  assert.equal(res.status, 'closed');
  assert.equal(res.status === 'closed' && res.durationMin, 0);
  assert.equal(res.event.ended_at, '2026-09-15T10:00:00.000Z', 'конец прижат к началу');
  assertNoNegativeDurations(db, 'пробуждение задним числом');
});

test('вставка события с ended_at раньше started_at отклоняется', () => {
  const db = testDb();
  assert.throws(
    () =>
      insertEvent(db, {
        type: 'sleep',
        source: 'manual',
        started_at: '2026-09-15T12:00:00.000Z',
        ended_at: '2026-09-15T10:00:00.000Z',
      }),
    /ended_at раньше started_at/,
  );
  assert.equal(queryEvents(db).length, 0);
});

test(
  'БАГ: правка события может поставить начало после конца — и сон исчезнет из сводок',
  () => {
    const db = testDb();
    const sleep = insertEvent(db, {
      type: 'sleep',
      source: 'manual',
      started_at: '2026-09-15T10:00:00.000Z',
      ended_at: '2026-09-15T11:30:00.000Z',
    }).event;

    assert.throws(
      () => updateEvent(db, sleep.id, { started_at: '2026-09-15T23:00:00.000Z' }),
      /started_at|ended_at/,
      'правка, переворачивающая событие во времени, должна отклоняться',
    );
    assertNoNegativeDurations(db, 'ручная правка времени');
  },
);

test('перевёрнутая во времени правка отклоняется, и статистика остаётся целой', () => {
  // Раньше здесь фиксировалась ЦЕНА бага: updateEvent пропускал ended_at < started_at,
  // и полуторачасовой сон молча исчезал из статистики. Теперь правка отклоняется,
  // а исходные данные не страдают — это и проверяем.
  const db = testDb();
  const sleep = insertEvent(db, {
    type: 'sleep',
    source: 'manual',
    started_at: '2026-09-15T10:00:00.000Z',
    ended_at: '2026-09-15T11:30:00.000Z',
  }).event;

  const range = (): number =>
    sleepStatsForRange(
      db,
      Date.parse('2026-09-15T00:00:00.000Z'),
      Date.parse('2026-09-16T00:00:00.000Z'),
      Date.parse('2026-09-15T12:00:00.000Z'),
    ).totalMin;

  assert.equal(range(), 90);

  assert.throws(
    () => updateEvent(db, sleep.id, { started_at: '2026-09-15T23:00:00.000Z' }),
    /started_at|ended_at/,
  );
  assert.equal(range(), 90, 'отклонённая правка не должна была ничего изменить');

  // сдвиг ended_at ниже started_at — тот же отказ
  assert.throws(
    () => updateEvent(db, sleep.id, { ended_at: '2026-09-15T09:00:00.000Z' }),
    /started_at|ended_at/,
  );
  assert.equal(range(), 90);

  // а законный сдвиг обоих границ проходит
  const moved = updateEvent(db, sleep.id, {
    started_at: '2026-09-15T08:00:00.000Z',
    ended_at: '2026-09-15T09:00:00.000Z',
  });
  assert.equal(moved?.started_at, '2026-09-15T08:00:00.000Z');
  assert.equal(range(), 60);
  assertNoNegativeDurations(db, 'после законной правки');
});

test('события, записанные не по порядку, отдаются по времени, а не по порядку вставки', () => {
  const db = testDb();
  insertEvent(db, { type: 'feed', source: 'manual', started_at: '2026-09-15T12:00:00.000Z' });
  insertEvent(db, { type: 'feed', source: 'manual', started_at: '2026-09-15T08:00:00.000Z' });
  insertEvent(db, { type: 'feed', source: 'manual', started_at: '2026-09-15T10:00:00.000Z' });

  const order = queryEvents(db).map((e) => e.started_at);
  assert.deepEqual(order, [
    '2026-09-15T12:00:00.000Z',
    '2026-09-15T10:00:00.000Z',
    '2026-09-15T08:00:00.000Z',
  ]);
});

test('события с одинаковым временем упорядочены стабильно, по id', () => {
  const db = testDb();
  const at = '2026-09-15T10:00:00.000Z';
  const a = insertEvent(db, { type: 'feed', source: 'manual', started_at: at }).event;
  const b = insertEvent(db, { type: 'diaper', source: 'manual', started_at: at }).event;
  assert.deepEqual(
    queryEvents(db).map((e) => e.id),
    [b.id, a.id],
    'при равном времени новее то, что записано позже',
  );
});

test('сон, дописанный задним числом, попадает в сводку тех суток, к которым относится', () => {
  const db = testDb();
  // сначала записали сегодняшний сон
  insertEvent(db, {
    type: 'sleep',
    source: 'manual',
    started_at: '2026-09-15T09:00:00.000Z',
    ended_at: '2026-09-15T10:00:00.000Z',
  });
  // потом вспомнили про вчерашний
  insertEvent(db, {
    type: 'sleep',
    source: 'manual',
    started_at: '2026-09-14T09:00:00.000Z',
    ended_at: '2026-09-14T11:00:00.000Z',
  });

  const days = dailySleep(db, cfg, 2, new Date('2026-09-15T14:00:00.000Z'));
  assert.deepEqual(
    days.map((d) => [d.date, d.totalMin]),
    [
      ['2026-09-14', 120],
      ['2026-09-15', 60],
    ],
  );
});

/* ------------------------------------------------------------------ */
/* Мягкое удаление                                                     */
/* ------------------------------------------------------------------ */

test('мягко удалённый открытый сон освобождает место для нового', () => {
  const db = testDb();
  const first = startSleep(db, cfg, { at: '2026-09-15T10:00:00.000Z' });
  assert.equal(first.status, 'created');
  softDeleteEvent(db, first.event.id);

  assert.equal(findOpenSleep(db), null, 'удалённый сон больше не считается открытым');
  const second = startSleep(db, cfg, { at: '2026-09-15T11:00:00.000Z' });
  assert.equal(second.status, 'created');
  assert.equal(openSleeps(db).length, 1);
});

test('удалённое событие не правится и не удаляется повторно', () => {
  const db = testDb();
  const event = insertEvent(db, {
    type: 'note',
    source: 'manual',
    started_at: '2026-09-15T10:00:00.000Z',
  }).event;
  softDeleteEvent(db, event.id);

  assert.equal(updateEvent(db, event.id, { note: 'поздно' }), null);
  assert.equal(softDeleteEvent(db, event.id), null);
  assert.equal(updateEvent(db, 999_999, { note: 'нет такого' }), null);
  assert.equal(softDeleteEvent(db, 999_999), null);
});

test('удалённый сон не считается в сводках, но виден при include_deleted', () => {
  const db = testDb();
  const sleep = insertEvent(db, {
    type: 'sleep',
    source: 'manual',
    started_at: '2026-09-15T09:00:00.000Z',
    ended_at: '2026-09-15T10:00:00.000Z',
  }).event;
  softDeleteEvent(db, sleep.id);

  const state = getState(db, cfg, new Date('2026-09-15T12:00:00.000Z'));
  assert.equal(state.today.sleepTotalMin, 0);
  assert.equal(state.sleep.lastSleep, null);
  assert.equal(queryEvents(db).length, 0);
  assert.equal(queryEvents(db, { includeDeleted: true }).length, 1);
});

/* ------------------------------------------------------------------ */
/* Границы выборок                                                     */
/* ------------------------------------------------------------------ */

test('бессмысленный лимит заменяется значением по умолчанию, а не обнуляет выдачу', () => {
  // limit = 0 в SQL означает «не отдавать ничего»: лента истории опустела бы,
  // и это выглядело бы как «событий нет», а не как «запрос кривой».
  assert.equal(clampLimit(0, 200, 1000), 200);
  assert.equal(clampLimit(-1, 200, 1000), 200);
  assert.equal(clampLimit(Number.NaN, 200, 1000), 200);
  assert.equal(clampLimit(Number.POSITIVE_INFINITY, 200, 1000), 200);
  assert.equal(clampLimit(null, 200, 1000), 200);
  assert.equal(clampLimit('мусор', 200, 1000), 200);
  assert.equal(clampLimit(1001, 200, 1000), 1000, 'сверх максимума — максимум');
  assert.equal(clampLimit(1.9, 200, 1000), 1, 'дробный обрезается вниз');
  assert.equal(clampLimit('5', 200, 1000), 5, 'строка-число понимается');

  const db = testDb();
  for (let i = 0; i < 3; i++) {
    insertEvent(db, { type: 'note', source: 'manual', started_at: `2026-09-15T10:0${i}:00.000Z` });
  }
  assert.equal(queryEvents(db, { limit: 0 }).length, 3, 'limit=0 не должен прятать историю');
  assert.equal(queryEvents(db, { limit: -5 }).length, 3);
  assert.equal(queryEvents(db, { limit: 2 }).length, 2);
});

/* ------------------------------------------------------------------ */
/* Ночь и день                                                         */
/* ------------------------------------------------------------------ */

test('граница ночь/день: 19:00 — уже ночь, 06:00 — уже день (локальное время)', () => {
  const local = (hhmm: string): string => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(2026, 8, 15, (h ?? 0) - 3, m ?? 0)).toISOString();
  };
  assert.equal(sleepSubtype(local('18:59'), cfg.tz), 'nap');
  assert.equal(sleepSubtype(local('19:00'), cfg.tz), 'night');
  assert.equal(sleepSubtype(local('23:59'), cfg.tz), 'night');
  assert.equal(sleepSubtype(local('00:00'), cfg.tz), 'night');
  assert.equal(sleepSubtype(local('05:59'), cfg.tz), 'night');
  assert.equal(sleepSubtype(local('06:00'), cfg.tz), 'nap');
});
