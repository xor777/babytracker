/**
 * §9.1–9.3: три рубежа обороны и обратимость.
 *
 * Главная проверка здесь — триггер: физическое удаление события должно быть
 * невозможно на уровне SQLite, В ОБХОД валидатора и любого кода приложения.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testConfig, testDb } from './helpers.ts';
import { openDb, all, get } from '../src/db.ts';
import {
  createSnapshot,
  listChangeSets,
  listRevisions,
  newChangeSetId,
  pruneSnapshots,
  revertChangeSet,
  sqlExecute,
  type JournalContext,
} from '../src/journal.ts';
import { insertEvent, queryEvents, softDeleteEvent, updateEvent } from '../src/events.ts';
import type { EventRow } from '../src/types.ts';

function ctx(overrides: Partial<JournalContext> = {}): JournalContext {
  return { changeSetId: newChangeSetId(), actor: 'alice-llm', ...overrides };
}

function physicalCount(db: ReturnType<typeof testDb>): number {
  return Number(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM events')?.n ?? 0);
}

function seed(db: ReturnType<typeof testDb>, n = 3): EventRow[] {
  const rows: EventRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      insertEvent(db, {
        type: 'sleep',
        subtype: 'nap',
        started_at: `2026-09-15T0${i}:00:00.000Z`,
        ended_at: `2026-09-15T0${i}:45:00.000Z`,
        source: 'manual',
        note: `сон ${i}`,
      }).event,
    );
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Рубеж 1: триггеры                                                   */
/* ------------------------------------------------------------------ */

test('РУБЕЖ 1: DELETE FROM events отбивается триггером базы', () => {
  const db = testDb();
  seed(db, 2);

  assert.throws(
    () => db.exec('DELETE FROM events'),
    /физическое удаление events запрещено/,
    'прямой DELETE должен быть невозможен',
  );
  assert.throws(() => db.exec('DELETE FROM events WHERE id = 1'), /физическое удаление/);
  assert.throws(
    () => db.prepare('DELETE FROM events WHERE id = ?').run(1),
    /физическое удаление/,
  );

  assert.equal(physicalCount(db), 2, 'ни одна строка не исчезла');
  db.close();
});

test('РУБЕЖ 2: журнал ревизий нельзя ни изменить, ни удалить', () => {
  const db = testDb();
  const [event] = seed(db, 1);
  softDeleteEvent(db, event!.id, ctx());

  assert.equal(all(db, 'SELECT id FROM event_revisions').length, 1);

  assert.throws(
    () => db.exec("UPDATE event_revisions SET before_json = NULL"),
    /только для добавления/,
  );
  assert.throws(() => db.exec('DELETE FROM event_revisions'), /только для добавления/);

  assert.equal(all(db, 'SELECT id FROM event_revisions').length, 1, 'журнал на месте');
  db.close();
});

/* ------------------------------------------------------------------ */
/* Журналирование                                                      */
/* ------------------------------------------------------------------ */

test('insert/update/soft_delete попадают в журнал с правильным op', () => {
  const db = testDb();

  const c1 = ctx();
  const { event } = insertEvent(
    db,
    { type: 'feed', subtype: 'bottle', started_at: '2026-09-15T10:00:00.000Z', source: 'manual' },
    'close-previous',
    c1,
  );
  assert.equal(listRevisions(db, c1.changeSetId)[0]?.op, 'insert');
  assert.equal(listRevisions(db, c1.changeSetId)[0]?.before_json, null);

  const c2 = ctx();
  updateEvent(db, event.id, { note: 'поправлено' }, c2);
  const r2 = listRevisions(db, c2.changeSetId)[0];
  assert.equal(r2?.op, 'update');
  assert.equal((JSON.parse(r2?.before_json ?? '{}') as EventRow).note, null);
  assert.equal((JSON.parse(r2?.after_json ?? '{}') as EventRow).note, 'поправлено');

  const c3 = ctx();
  softDeleteEvent(db, event.id, c3);
  assert.equal(listRevisions(db, c3.changeSetId)[0]?.op, 'soft_delete');

  db.close();
});

test('изменение, которое ничего не меняет, журнал не засоряет', () => {
  const db = testDb();
  const [event] = seed(db, 1);
  const c = ctx();
  updateEvent(db, event!.id, { note: event!.note }, c);
  assert.equal(listRevisions(db, c.changeSetId).length, 0);
  db.close();
});

/* ------------------------------------------------------------------ */
/* sql_execute                                                         */
/* ------------------------------------------------------------------ */

test('sql_execute: массовое мягкое удаление журналируется построчно', () => {
  const db = testDb();
  seed(db, 3);
  const c = ctx({ summary: 'удалить всё за сегодня' });

  const res = sqlExecute(
    db,
    c,
    "UPDATE events SET deleted_at = '2026-09-15T20:00:00.000Z', updated_at = '2026-09-15T20:00:00.000Z' WHERE type = 'sleep'",
  );

  assert.equal(res.ok, true);
  assert.equal(res.ok && res.changes, 3);
  assert.equal(queryEvents(db, {}).length, 0, 'из выборок записи пропали');
  assert.equal(physicalCount(db), 3, 'физически строки на месте');

  const revisions = listRevisions(db, c.changeSetId);
  assert.equal(revisions.length, 3);
  assert.ok(revisions.every((r) => r.op === 'soft_delete'));
  assert.ok(revisions.every((r) => r.before_json && r.after_json));

  db.close();
});

test('sql_execute: отклонённый запрос ничего не пишет и объясняет причину', () => {
  const db = testDb();
  seed(db, 2);
  const c = ctx();

  const res = sqlExecute(db, c, 'DELETE FROM events');
  assert.equal(res.ok, false);
  assert.match(res.ok ? '' : res.error, /deleted_at/);
  assert.equal(physicalCount(db), 2);
  assert.equal(listChangeSets(db).length, 0, 'пустых наборов изменений не появилось');

  db.close();
});

test('sql_execute: INSERT журналируется как insert', () => {
  const db = testDb();
  const c = ctx();

  const res = sqlExecute(
    db,
    c,
    "INSERT INTO events (type, subtype, started_at, source, created_at, updated_at) " +
      "VALUES ('diaper', 'wet', '2026-09-15T10:00:00.000Z', 'alice-llm', '2026-09-15T10:00:00.000Z', '2026-09-15T10:00:00.000Z')",
  );

  assert.equal(res.ok, true);
  const revisions = listRevisions(db, c.changeSetId);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]?.op, 'insert');
  assert.equal(revisions[0]?.before_json, null);

  db.close();
});

test('sql_execute: снимок «до» снимается тем же WHERE, что и изменение', () => {
  const db = testDb();
  const rows = seed(db, 3);
  const c = ctx();

  const res = sqlExecute(db, c, `UPDATE events SET note = 'только один' WHERE id = ${rows[1]!.id}`);
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.changes, 1);

  const revisions = listRevisions(db, c.changeSetId);
  assert.equal(revisions.length, 1, 'журналируется ровно затронутая строка');
  assert.equal(revisions[0]?.event_id, rows[1]!.id);

  db.close();
});

/* ------------------------------------------------------------------ */
/* Откат                                                               */
/* ------------------------------------------------------------------ */

test('revert_change_set возвращает строки ровно как было', () => {
  const db = testDb();
  const before = seed(db, 3);
  const c = ctx({ summary: 'удалить всё' });

  sqlExecute(
    db,
    c,
    "UPDATE events SET deleted_at = '2026-09-15T20:00:00.000Z', note = 'затёрто' WHERE type = 'sleep'",
  );
  assert.equal(queryEvents(db, {}).length, 0);

  const reverted = revertChangeSet(db, c.changeSetId, 'api');
  assert.equal(reverted.ok, true);

  const after = queryEvents(db, {});
  assert.equal(after.length, 3, 'все записи вернулись');

  for (const original of before) {
    const restored = after.find((e) => e.id === original.id);
    assert.ok(restored, `событие ${original.id} должно вернуться`);
    assert.equal(restored?.deleted_at, null);
    assert.equal(restored?.note, original.note, 'note восстановлен');
    assert.equal(restored?.started_at, original.started_at);
    assert.equal(restored?.ended_at, original.ended_at);
  }

  db.close();
});

test('откат помечает исходный набор как отменённый', () => {
  const db = testDb();
  const [event] = seed(db, 1);
  const c = ctx();
  softDeleteEvent(db, event!.id, c);

  revertChangeSet(db, c.changeSetId, 'api');
  const cs = listChangeSets(db).find((x) => x.id === c.changeSetId);
  assert.ok(cs?.reverted_at, 'reverted_at проставлен');

  db.close();
});

test('отмену отмены тоже можно отменить', () => {
  const db = testDb();
  const [event] = seed(db, 1);
  const c = ctx();

  softDeleteEvent(db, event!.id, c);
  assert.equal(queryEvents(db, {}).length, 0);

  const first = revertChangeSet(db, c.changeSetId, 'api');
  assert.equal(first.ok, true);
  assert.equal(queryEvents(db, {}).length, 1, 'запись вернулась');

  const second = revertChangeSet(db, first.ok ? first.revertChangeSetId : '', 'api');
  assert.equal(second.ok, true);
  assert.equal(queryEvents(db, {}).length, 0, 'отмена отмены снова спрятала запись');

  const third = revertChangeSet(db, second.ok ? second.revertChangeSetId : '', 'api');
  assert.equal(third.ok, true);
  assert.equal(queryEvents(db, {}).length, 1, 'и так сколько угодно раз');

  db.close();
});

test('откат созданного набором события прячет его, но не удаляет физически', () => {
  const db = testDb();
  const c = ctx();

  const res = sqlExecute(
    db,
    c,
    "INSERT INTO events (type, started_at, source, created_at, updated_at) " +
      "VALUES ('note', '2026-09-15T10:00:00.000Z', 'alice-llm', 'c', 'u')",
  );
  assert.equal(res.ok, true);
  assert.equal(queryEvents(db, {}).length, 1);

  revertChangeSet(db, c.changeSetId, 'api');
  assert.equal(queryEvents(db, {}).length, 0, 'событие спрятано');
  assert.equal(physicalCount(db), 1, 'но физически на месте — удалять нечем');

  db.close();
});

test('откат несуществующего и пустого набора объясняет проблему', () => {
  const db = testDb();
  const missing = revertChangeSet(db, 'нет-такого', 'api');
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.error, /не найден/);
  db.close();
});

test('цепочка правок одного события откатывается корректно', () => {
  const db = testDb();
  const [event] = seed(db, 1);
  const c = ctx();

  // два изменения одной строки внутри одного набора
  sqlExecute(db, c, `UPDATE events SET note = 'шаг 1' WHERE id = ${event!.id}`);
  sqlExecute(db, c, `UPDATE events SET note = 'шаг 2' WHERE id = ${event!.id}`);
  assert.equal(queryEvents(db, {})[0]?.note, 'шаг 2');

  revertChangeSet(db, c.changeSetId, 'api');
  assert.equal(queryEvents(db, {})[0]?.note, event!.note, 'вернулось исходное значение');

  db.close();
});

/* ------------------------------------------------------------------ */
/* Рубеж 3: снимки                                                     */
/* ------------------------------------------------------------------ */

test('РУБЕЖ 3: VACUUM INTO делает читаемый снимок базы', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-snap-'));
  const dbPath = path.join(dir, 'babytracker.db');
  const db = openDb({ path: dbPath });
  seed(db, 2);

  const snapshot = createSnapshot(db, dbPath);
  assert.ok(snapshot, 'снимок создан');
  assert.ok(fs.existsSync(snapshot!));

  const copy = openDb({ path: snapshot! });
  assert.equal(all(copy, 'SELECT id FROM events').length, 2, 'данные в снимке на месте');
  copy.close();

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('снимок для базы в памяти не делается и не падает', () => {
  const db = testDb();
  assert.equal(createSnapshot(db, ':memory:'), null);
  db.close();
});

test('старые снимки подчищаются, последние 50 остаются', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-prune-'));
  for (let i = 0; i < 60; i++) {
    fs.writeFileSync(path.join(dir, `2026-09-15T00-00-${String(i).padStart(2, '0')}-000Z.db`), 'x');
  }
  const removed = pruneSnapshots(dir, 50);
  assert.equal(removed, 10);

  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 50);
  assert.equal(left[0], '2026-09-15T00-00-10-000Z.db', 'удалены самые старые');

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Совместная работа с доменным слоем                                  */
/* ------------------------------------------------------------------ */

test('инвариант одного открытого сна переживает журналирование', () => {
  const db = testDb();
  const cfg = testConfig();
  void cfg;

  const c = ctx();
  insertEvent(db, { type: 'sleep', started_at: '2026-09-15T10:00:00.000Z', source: 'manual' }, 'close-previous', c);
  insertEvent(db, { type: 'sleep', started_at: '2026-09-15T12:00:00.000Z', source: 'manual' }, 'close-previous', c);

  const open = all<EventRow>(
    db,
    "SELECT id FROM events WHERE type='sleep' AND ended_at IS NULL AND deleted_at IS NULL",
  );
  assert.equal(open.length, 1, 'открытый сон по-прежнему один');

  // в журнале: закрытие первого + вставка второго
  const ops = listRevisions(db, c.changeSetId).map((r) => r.op).sort();
  assert.deepEqual(ops, ['insert', 'insert', 'update']);

  db.close();
});
