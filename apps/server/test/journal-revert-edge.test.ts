/**
 * §9 — журнал и обратимость, крайние случаи.
 *
 * Единственное жёсткое требование заказчика: безвозвратной модификации данных
 * существовать не должно. Проверяем не «журнал пишется», а «после любой правки
 * дневник можно вернуть как было» — включая отмену отмены и правки, задевшие
 * несколько событий сразу.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig, testDb } from './helpers.ts';
import {
  MAX_AFFECTED_ROWS,
  listChangeSets,
  listRevisions,
  newChangeSetId,
  revertChangeSet,
  sqlExecute,
  type JournalContext,
} from '../src/journal.ts';
import { endSleep, insertEvent, queryEvents, softDeleteEvent, startSleep, updateEvent } from '../src/events.ts';
import { all } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import type { EventRow } from '../src/types.ts';

const cfg = testConfig();

function llm(changeSetId = newChangeSetId()): JournalContext {
  return { changeSetId, actor: 'alice-llm' };
}

function notes(db: Db): string[] {
  return queryEvents(db, { includeDeleted: true })
    .sort((a, b) => a.id - b.id)
    .map((e) => `${e.note ?? '-'}${e.deleted_at ? ' (удалено)' : ''}`);
}

function seedNotes(db: Db, count: number): EventRow[] {
  const rows: EventRow[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(
      insertEvent(db, {
        type: 'note',
        source: 'manual',
        started_at: `2026-09-15T10:0${i}:00.000Z`,
        note: `запись ${i}`,
      }).event,
    );
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Откат набора, задевшего несколько событий                           */
/* ------------------------------------------------------------------ */

test('откат возвращает ВСЕ события набора, а не последнее', () => {
  const db = testDb();
  seedNotes(db, 3);

  const ctx = llm();
  const res = sqlExecute(db, ctx, "UPDATE events SET note = 'переписано моделью' WHERE 1=1");
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.changes, 3);
  assert.equal(listRevisions(db, ctx.changeSetId).length, 3, 'по ревизии на каждую строку');

  const reverted = revertChangeSet(db, ctx.changeSetId, 'api');
  assert.equal(reverted.ok, true);
  assert.deepEqual(notes(db), ['запись 0', 'запись 1', 'запись 2']);
});

test('откат фразы возвращает и сон, и правки к нему — набор один на фразу (§10.3)', () => {
  const db = testDb();
  const shared = newChangeSetId();

  // быстрый матчер открыл сон
  const journal: JournalContext = { changeSetId: shared, actor: 'alice-fast', utteranceId: null };
  const sleep = startSleep(db, cfg, { at: '2026-09-15T10:00:00.000Z', journal });
  assert.equal(sleep.status, 'created');

  // модель дописала в тот же набор кормление и поправила время сна
  sqlExecute(
    db,
    { changeSetId: shared, actor: 'alice-llm' },
    `INSERT INTO events (type, subtype, started_at, source, created_at, updated_at)
     VALUES ('feed', 'breast', '2026-09-15T09:55:00.000Z', 'alice-llm', 't', 't')`,
  );
  sqlExecute(
    db,
    { changeSetId: shared, actor: 'alice-llm' },
    `UPDATE events SET started_at = '2026-09-15T09:30:00.000Z' WHERE type = 'sleep'`,
  );

  assert.equal(queryEvents(db).length, 2, 'в дневнике сон и кормление');

  const reverted = revertChangeSet(db, shared, 'api');
  assert.equal(reverted.ok, true);
  assert.deepEqual(queryEvents(db), [], 'откат фразы убирает её целиком, а не половину');
  assert.equal(
    queryEvents(db, { includeDeleted: true }).length,
    2,
    'физически ничего не исчезло — только скрыто',
  );
});

test('откат правки, сделанной поверх чужой правки, возвращает ровно предыдущее состояние', () => {
  const db = testDb();
  const [event] = seedNotes(db, 1);
  assert.ok(event);

  const first = llm();
  sqlExecute(db, first, `UPDATE events SET note = 'версия 2' WHERE id = ${event.id}`);
  const second = llm();
  sqlExecute(db, second, `UPDATE events SET note = 'версия 3' WHERE id = ${event.id}`);

  const reverted = revertChangeSet(db, second.changeSetId, 'api');
  assert.equal(reverted.ok, true);
  assert.deepEqual(notes(db), ['версия 2'], 'откат снимает только свою правку');

  const revertedFirst = revertChangeSet(db, first.changeSetId, 'api');
  assert.equal(revertedFirst.ok, true);
  assert.deepEqual(notes(db), ['запись 0'], 'а следом можно снять и предыдущую');
});

/* ------------------------------------------------------------------ */
/* Отмена отмены                                                       */
/* ------------------------------------------------------------------ */

test('отмену отмены тоже можно отменить — и так сколько угодно раз', () => {
  const db = testDb();
  seedNotes(db, 2);

  const change = llm();
  sqlExecute(db, change, "UPDATE events SET note = 'после модели' WHERE 1=1");
  assert.deepEqual(notes(db), ['после модели', 'после модели']);

  const undo = revertChangeSet(db, change.changeSetId, 'api');
  assert.equal(undo.ok, true);
  assert.deepEqual(notes(db), ['запись 0', 'запись 1']);

  const redo = revertChangeSet(db, undo.ok ? undo.revertChangeSetId : '', 'api');
  assert.equal(redo.ok, true);
  assert.deepEqual(notes(db), ['после модели', 'после модели'], 'вернули как было до отмены');

  const undoAgain = revertChangeSet(db, redo.ok ? redo.revertChangeSetId : '', 'api');
  assert.equal(undoAgain.ok, true);
  assert.deepEqual(notes(db), ['запись 0', 'запись 1'], 'третий уровень тоже работает');
});

test('сам откат записан в журнал как отдельный набор с op=revert', () => {
  const db = testDb();
  seedNotes(db, 1);
  const change = llm();
  sqlExecute(db, change, "UPDATE events SET note = 'x' WHERE 1=1");

  const undo = revertChangeSet(db, change.changeSetId, 'manual');
  assert.equal(undo.ok, true);
  const revertId = undo.ok ? undo.revertChangeSetId : '';

  const revisions = listRevisions(db, revertId);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]?.op, 'revert');
  assert.equal(revisions[0]?.actor, 'manual');
  assert.notEqual(revisions[0]?.before_json, null, 'снимок «до отката» обязателен');

  const sets = listChangeSets(db, 10);
  assert.equal(sets[0]?.id, revertId, 'набор-откат в истории самый свежий');
  assert.match(sets[0]?.summary ?? '', /Откат набора изменений/);
});

test('повторный откат того же набора идемпотентен и честно об этом сообщает', () => {
  const db = testDb();
  seedNotes(db, 1);
  const change = llm();
  sqlExecute(db, change, "UPDATE events SET note = 'x' WHERE 1=1");

  const first = revertChangeSet(db, change.changeSetId, 'api');
  assert.equal(first.ok && first.alreadyReverted, false);

  const second = revertChangeSet(db, change.changeSetId, 'api');
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.alreadyReverted, true, 'набор уже был отменён — это видно');
  assert.deepEqual(notes(db), ['запись 0'], 'данные не разъехались от повторного отката');
});

test('откат удаления возвращает событие в ленту', () => {
  const db = testDb();
  const [event] = seedNotes(db, 1);
  assert.ok(event);

  const ctx: JournalContext = { changeSetId: newChangeSetId(), actor: 'manual' };
  softDeleteEvent(db, event.id, ctx);
  assert.equal(queryEvents(db).length, 0);

  const undo = revertChangeSet(db, ctx.changeSetId, 'manual');
  assert.equal(undo.ok, true);
  assert.equal(queryEvents(db).length, 1, 'удаление обратимо');
  assert.equal(queryEvents(db)[0]?.deleted_at, null);
});

test('откат созданного сна прячет его и освобождает инвариант открытого сна', () => {
  const db = testDb();
  const ctx: JournalContext = { changeSetId: newChangeSetId(), actor: 'alice-fast' };
  startSleep(db, cfg, { at: '2026-09-15T10:00:00.000Z', journal: ctx });

  const undo = revertChangeSet(db, ctx.changeSetId, 'api');
  assert.equal(undo.ok, true);

  const open = all<EventRow>(
    db,
    `SELECT id FROM events WHERE type='sleep' AND ended_at IS NULL AND deleted_at IS NULL`,
  );
  assert.equal(open.length, 0, 'откат снял открытый сон');
  assert.equal(queryEvents(db, { includeDeleted: true }).length, 1, 'строка осталась в базе');

  // и можно снова начать сон, не упираясь в инвариант
  const again = startSleep(db, cfg, { at: '2026-09-15T11:00:00.000Z' });
  assert.equal(again.status, 'created');
});

test('закрытие сна обратимо: откат возвращает сон в открытое состояние', () => {
  const db = testDb();
  startSleep(db, cfg, { at: '2026-09-15T10:00:00.000Z' });

  const ctx: JournalContext = { changeSetId: newChangeSetId(), actor: 'alice-fast' };
  const closed = endSleep(db, cfg, { at: '2026-09-15T11:00:00.000Z', journal: ctx });
  assert.equal(closed.status, 'closed');

  const undo = revertChangeSet(db, ctx.changeSetId, 'api');
  assert.equal(undo.ok, true);
  assert.equal(queryEvents(db, { type: 'sleep' })[0]?.ended_at, null, 'сон снова идёт');
});

/* ------------------------------------------------------------------ */
/* Границы sql_execute                                                 */
/* ------------------------------------------------------------------ */

test('массовая правка сверх лимита строк отбивается до записи, а не после', () => {
  const db = testDb();
  db.exec(`
    INSERT INTO events (child_id, type, started_at, source, created_at, updated_at, note)
    SELECT 'andrey', 'note', '2026-09-15T10:00:00.000Z', 'manual', 't', 't', 'цел'
      FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${MAX_AFFECTED_ROWS + 1})
            SELECT x FROM c)
  `);

  const ctx = llm();
  const res = sqlExecute(db, ctx, "UPDATE events SET deleted_at = 't', updated_at = 't' WHERE 1=1");
  assert.equal(res.ok, false);
  assert.match(res.ok ? '' : res.error, /сузь условие WHERE/);
  assert.equal(queryEvents(db, { limit: 1 }).length, 1, 'дневник не тронут');
  assert.equal(listRevisions(db, ctx.changeSetId).length, 0, 'в журнал тоже ничего не попало');
});

test('отклонённый валидатором запрос не оставляет следов', () => {
  const db = testDb();
  seedNotes(db, 1);
  const ctx = llm();

  const res = sqlExecute(db, ctx, 'DELETE FROM events WHERE id = 1');
  assert.equal(res.ok, false);
  assert.match(res.ok ? '' : res.error, /deleted_at/);
  assert.deepEqual(notes(db), ['запись 0']);
  assert.equal(listRevisions(db, ctx.changeSetId).length, 0);
  assert.equal(listChangeSets(db, 10).length, 0, 'пустых наборов не заводим');
});

test(
  'БАГ: комментарий в конце WHERE ломает снимок «до» непонятной для модели ошибкой',
  () => {
    const db = testDb();
    seedNotes(db, 2);
    const res = sqlExecute(db, llm(), "UPDATE events SET note = 'x' WHERE id = 1 -- поправка мамы");
    assert.equal(res.ok, true, res.ok ? '' : `запрос законный, а отклонён: ${res.error}`);
  },
);

test(
  'БАГ: подмена id через oid делает правку необратимой',
  () => {
    const db = testDb();
    const [event] = seedNotes(db, 1);
    assert.ok(event);

    const ctx = llm();
    const res = sqlExecute(db, ctx, `UPDATE events SET oid = 500 WHERE id = ${event.id}`);
    assert.equal(res.ok, false, 'смена идентификатора события не должна быть возможна');

    // а если всё же прошла — откат обязан вернуть запись, а не спрятать её
    revertChangeSet(db, ctx.changeSetId, 'api');
    assert.deepEqual(notes(db), ['запись 0']);
  },
);

/* ------------------------------------------------------------------ */
/* Рубежи обороны при откате                                           */
/* ------------------------------------------------------------------ */

test('откат не удаляет строки физически и не переписывает журнал', () => {
  const db = testDb();
  seedNotes(db, 2);
  const ctx = llm();
  sqlExecute(db, ctx, "UPDATE events SET note = 'x' WHERE 1=1");
  const revisionsBefore = listRevisions(db, ctx.changeSetId).length;

  revertChangeSet(db, ctx.changeSetId, 'api');

  assert.equal(
    queryEvents(db, { includeDeleted: true }).length,
    2,
    'строки на месте — физического удаления не существует',
  );
  assert.equal(
    listRevisions(db, ctx.changeSetId).length,
    revisionsBefore,
    'журнал исходного набора не переписан откатом',
  );
  assert.throws(() => db.exec('DELETE FROM events'), /физическое удаление/);
  assert.throws(() => db.exec("UPDATE event_revisions SET before_json = NULL"), /только для добавления/);
  assert.throws(() => db.exec('DELETE FROM event_revisions'), /только для добавления/);
});

test('откат несуществующего и пустого набора объясняет, что не так', () => {
  const db = testDb();
  const missing = revertChangeSet(db, 'нет-такого-набора', 'api');
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.error, /не найден/);

  // набор есть, но изменений в нём нет
  const ctx = llm();
  sqlExecute(db, ctx, "UPDATE events SET note = 'x' WHERE id = 999999");
  const empty = revertChangeSet(db, ctx.changeSetId, 'api');
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? '' : empty.error, /не найден|откатывать нечего/);
});

test('правка руками журналируется наравне с правкой модели', () => {
  const db = testDb();
  const [event] = seedNotes(db, 1);
  assert.ok(event);

  const ctx: JournalContext = { changeSetId: newChangeSetId(), actor: 'manual' };
  updateEvent(db, event.id, { note: 'поправила мама' }, ctx);

  const revisions = listRevisions(db, ctx.changeSetId);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]?.op, 'update');
  assert.equal(revisions[0]?.actor, 'manual');

  revertChangeSet(db, ctx.changeSetId, 'manual');
  assert.deepEqual(notes(db), ['запись 0'], 'ручная правка так же обратима');
});
