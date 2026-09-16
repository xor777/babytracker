/**
 * Температура в «Сводке» (§10.2, §10.4).
 *
 * Врач спрашивает про температуру три вещи: записывали ли вообще, какая была
 * самая высокая и когда. Ни на один из этих вопросов страница раньше
 * не отвечала: число доезжало до приложения в `measures.tempMaxC` и нигде
 * не показывалось, а жар, записанный как `symptom/fever`, не доезжал и туда.
 *
 * Что тесты сторожат:
 *
 *   1. ОБА источника градусов — `measure/temp` и `symptom/fever`. Читать одно
 *      место значит терять записанное; в базе лежат записи обоих видов.
 *   2. Суточный максимум, а не последний замер: врачу нужен пик.
 *   3. «Не было» и «не записали» — разные вещи. Суток без записей в списке
 *      нет вовсе, ноль туда не подставляется.
 *   4. Никаких оценок. Здесь нет и не может быть ни «нормы», ни «жара»,
 *      ни порога — только число и время.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { temperatureFacts } from '../src/lib/summary';
import type { TrackerEvent } from '../src/types';

function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

const BIRTH = local(2026, 9, 2, 4, 35);
const WINDOW_START = local(2026, 9, 5, 0, 0);

let seq = 0;
function ev(
  type: string,
  subtype: string | null,
  at: number,
  value_num: number | null,
  value_unit: string | null = 'c',
): TrackerEvent {
  return {
    id: ++seq,
    type,
    subtype,
    started_at: new Date(at).toISOString(),
    ended_at: new Date(at).toISOString(),
    value_num,
    value_unit,
  } as TrackerEvent;
}

const temp = (at: number, c: number | null, unit: string | null = 'c') =>
  ev('measure', 'temp', at, c, unit);
const fever = (at: number, c: number | null, unit: string | null = 'c') =>
  ev('symptom', 'fever', at, c, unit);

const facts = (events: TrackerEvent[]) =>
  temperatureFacts(events, { birthMs: BIRTH, windowStartMs: WINDOW_START });

/* ================================================================== *
 * 1. Оба источника
 * ================================================================== */

test('градусы, записанные симптомом, попадают в сводку наравне с замером', () => {
  const f = facts([fever(local(2026, 9, 10, 21, 30), 38.4)]);

  assert.equal(f.records, 1, 'запись есть');
  assert.equal(f.peak?.c, 38.4);
  assert.equal(f.days.length, 1);
  assert.equal(f.days[0].maxC, 38.4);
});

test('пик считается по обоим источникам сразу', () => {
  const f = facts([
    temp(local(2026, 9, 10, 8, 0), 37.2),
    fever(local(2026, 9, 10, 14, 0), 38.6),
    temp(local(2026, 9, 10, 21, 0), 36.9),
  ]);

  assert.equal(f.records, 3);
  assert.equal(f.peak?.c, 38.6, 'пик мог лежать в любом из двух мест');
  assert.equal(f.peak?.day, 9, '10 сентября — 9-й день жизни');
});

test('запись без числа градусами не считается', () => {
  // «Он горячий» — факт, но не температура. Выдумывать число нельзя.
  const f = facts([fever(local(2026, 9, 10, 12, 0), null, null)]);

  assert.equal(f.records, 0);
  assert.equal(f.peak, null);
  assert.deepEqual(f.days, []);
});

test('чужая единица за градусы не выдаётся', () => {
  const f = facts([fever(local(2026, 9, 10, 12, 0), 120, 'ml')]);
  assert.equal(f.records, 0, '120 мл — это не 120 градусов');
});

test('число без единицы у температуры считается градусами', () => {
  const f = facts([temp(local(2026, 9, 10, 12, 0), 37.8, null)]);
  assert.equal(f.peak?.c, 37.8, 'терять число из-за незаполненного поля нельзя');
});

test('удалённая запись не влияет ни на пик, ни на счёт', () => {
  const dead = { ...temp(local(2026, 9, 10, 12, 0), 41), deleted_at: new Date().toISOString() };
  const f = facts([temp(local(2026, 9, 10, 8, 0), 37.1), dead as TrackerEvent]);

  assert.equal(f.records, 1);
  assert.equal(f.peak?.c, 37.1);
});

/* ================================================================== *
 * 2. Сутки: максимум, а не последний замер
 * ================================================================== */

test('за сутки показывается самое высокое значение, а не последнее', () => {
  const f = facts([
    temp(local(2026, 9, 10, 8, 0), 37.2),
    temp(local(2026, 9, 10, 14, 0), 38.4),
    temp(local(2026, 9, 10, 22, 0), 36.8),
  ]);

  assert.equal(f.days.length, 1, 'одни сутки');
  assert.equal(f.days[0].maxC, 38.4, 'врачу нужен пик, а не то, чем закончился день');
  assert.equal(f.days[0].records, 3);
  assert.equal(f.days[0].day, 9);
});

test('сутки идут от старых к новым, и пустых среди них нет', () => {
  const f = facts([
    temp(local(2026, 9, 12, 9, 0), 36.8),
    temp(local(2026, 9, 10, 9, 0), 38.1),
  ]);

  assert.deepEqual(
    f.days.map((d) => d.day),
    [9, 11],
    '11 сентября записей не было — суток в списке нет вовсе',
  );
  // Ноль здесь означал бы «температуры не было», а дневник знает только
  // «не записали». Разница та же, что у подгузников, и она принципиальна.
  assert.ok(
    f.days.every((d) => d.maxC > 0),
    'подставленных нулей в списке нет',
  );
});

test('при равных значениях пиком остаётся первое по времени', () => {
  const f = facts([
    temp(local(2026, 9, 10, 8, 0), 38.0),
    temp(local(2026, 9, 11, 8, 0), 38.0),
  ]);

  assert.equal(f.peak?.day, 9, 'повторный такой же замер не переносит «когда было выше всего»');
});

/* ================================================================== *
 * 3. Край окна: «не смотрели» ≠ «не было»
 * ================================================================== */

test('запись в первые сутки окна помечает край', () => {
  const f = facts([temp(local(2026, 9, 5, 10, 0), 37.4)]);
  assert.equal(
    f.atWindowEdge,
    true,
    'период начинается с этих суток — что было раньше, в него не попало',
  );
});

test('запись позже первых суток окна край не помечает', () => {
  const f = facts([temp(local(2026, 9, 9, 10, 0), 37.4)]);
  assert.equal(f.atWindowEdge, false);
});

test('температуры не записывали — пусто, без нулей и без пика', () => {
  const f = facts([ev('feed', 'breast', local(2026, 9, 10, 9, 0), 60, 'ml')]);

  assert.deepEqual(f.days, []);
  assert.equal(f.peak, null);
  assert.equal(f.records, 0);
  assert.equal(f.atWindowEdge, false);
});

/* ================================================================== *
 * 4. Границы: фактов много, оценок ноль
 * ================================================================== */

test('неправдоподобное значение показывается как записано, а не «чинится»', () => {
  // 41.5 — повод усомниться в записи, но не повод её править или прятать.
  // Решает врач; наше дело — показать, что записали.
  const f = facts([temp(local(2026, 9, 10, 12, 0), 41.5)]);
  assert.equal(f.peak?.c, 41.5);

  const low = facts([temp(local(2026, 9, 10, 12, 0), 34.2)]);
  assert.equal(low.peak?.c, 34.2, 'низкое значение тоже не отбрасывается');
});

test('в фактах нет ни порога, ни ярлыка — только числа и время', () => {
  const f = facts([temp(local(2026, 9, 10, 12, 0), 38.9)]);
  const asText = JSON.stringify(f);

  for (const verdict of ['норм', 'высок', 'жар', 'опасн', 'тревог', 'повышен']) {
    assert.ok(!asText.includes(verdict), `оценки «${verdict}» в фактах быть не должно`);
  }
});
