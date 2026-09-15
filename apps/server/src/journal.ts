/**
 * Журнал изменений и обратимость (§9.1–9.3).
 *
 * Главное требование заказчика: безвозвратной модификации данных не существует.
 * Здесь реализованы рубежи 2 и 3 (журнал ревизий и снимки базы); рубеж 1 —
 * триггеры SQLite — живёт в db.ts и работает независимо от этого кода.
 *
 * Правило: любое изменение events идёт через `journaledChange`. Только так
 * гарантируется, что в `event_revisions` останется строка «до».
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db, SqlParam } from './db.ts';
import { EVENT_COLUMNS, all, get, inTransaction, p, run } from './db.ts';
import type { EventRow } from './types.ts';
import { nowIso } from './time.ts';
import { checkSqlExecute } from './sql-guard.ts';

export type RevisionOp = 'insert' | 'update' | 'soft_delete' | 'revert';
/**
 * Кто внёс изменение. §9.2 перечисляет три значения; добавлен 'alice-fast',
 * потому что быстрый матчер — отдельный источник, и путать его с 'manual'
 * при разборе истории было бы неверно.
 */
export type Actor = 'alice-llm' | 'api' | 'manual' | 'alice-fast';

export interface ChangeSetRow {
  id: string;
  utterance_id: number | null;
  summary: string | null;
  created_at: string;
  reverted_at: string | null;
}

export interface RevisionRow {
  id: number;
  change_set_id: string;
  event_id: number;
  op: string;
  before_json: string | null;
  after_json: string | null;
  actor: string;
  created_at: string;
}

const CHANGE_SET_COLUMNS = 'id, utterance_id, summary, created_at, reverted_at';
const REVISION_COLUMNS =
  'id, change_set_id, event_id, op, before_json, after_json, actor, created_at';

/** Сколько строк максимум трогаем одним sql_execute — защита от «UPDATE без WHERE». */
export const MAX_AFFECTED_ROWS = 5_000;
/** Сколько строк максимум отдаём из sql_query (§9.3). */
export const SQL_QUERY_MAX_ROWS = 500;

export function newChangeSetId(): string {
  return randomUUID();
}

/* ------------------------------------------------------------------ */
/* Наборы изменений                                                    */
/* ------------------------------------------------------------------ */

export interface EnsureChangeSetInput {
  id: string;
  utteranceId?: number | null;
  summary?: string | null;
}

/** Идемпотентно создаёт набор изменений. Пустых наборов не плодим: зовём лениво. */
export function ensureChangeSet(db: Db, input: EnsureChangeSetInput): string {
  const existing = get<ChangeSetRow>(
    db,
    `SELECT ${CHANGE_SET_COLUMNS} FROM change_sets WHERE id = ?`,
    [input.id],
  );
  if (existing) return existing.id;

  run(
    db,
    `INSERT INTO change_sets (id, utterance_id, summary, created_at) VALUES (?, ?, ?, ?)`,
    [p(input.id), p(input.utteranceId), p(input.summary), p(nowIso())],
  );
  return input.id;
}

export function setChangeSetSummary(db: Db, id: string, summary: string): void {
  run(db, 'UPDATE change_sets SET summary = ? WHERE id = ?', [p(summary.slice(0, 2000)), p(id)]);
}

export interface ChangeSetDto extends ChangeSetRow {
  revisions: number;
  events: number[];
}

export function listChangeSets(db: Db, limit = 20): ChangeSetDto[] {
  const n = Math.min(Math.max(1, Math.trunc(limit)), 200);
  const rows = all<ChangeSetRow>(
    db,
    `SELECT ${CHANGE_SET_COLUMNS} FROM change_sets ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [n],
  );

  return rows.map((row) => {
    const revisions = all<{ event_id: number }>(
      db,
      'SELECT DISTINCT event_id FROM event_revisions WHERE change_set_id = ? ORDER BY event_id',
      [row.id],
    );
    const total = get<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM event_revisions WHERE change_set_id = ?',
      [row.id],
    );
    return {
      ...row,
      revisions: Number(total?.n ?? 0),
      events: revisions.map((r) => Number(r.event_id)),
    };
  });
}

export function getChangeSet(db: Db, id: string): ChangeSetRow | null {
  return (
    get<ChangeSetRow>(db, `SELECT ${CHANGE_SET_COLUMNS} FROM change_sets WHERE id = ?`, [id]) ?? null
  );
}

/**
 * §10.3: одна фраза — один набор изменений. Быстрый матчер уже мог создать набор
 * по этой фразе; модель должна дописывать в него же, иначе «отмени последнее»
 * откатит половину фразы — сон вернётся, а кормление останется.
 */
export function findChangeSetByUtterance(db: Db, utteranceId: number): ChangeSetRow | null {
  return (
    get<ChangeSetRow>(
      db,
      `SELECT ${CHANGE_SET_COLUMNS} FROM change_sets
        WHERE utterance_id = ? AND reverted_at IS NULL
        ORDER BY created_at ASC LIMIT 1`,
      [utteranceId],
    ) ?? null
  );
}

/** Сколько ревизий в наборе внёс конкретный актор. */
export function countRevisionsByActor(db: Db, changeSetId: string, actor: Actor): number {
  const row = get<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM event_revisions WHERE change_set_id = ? AND actor = ?',
    [changeSetId, actor],
  );
  return Number(row?.n ?? 0);
}

export function listRevisions(db: Db, changeSetId: string): RevisionRow[] {
  return all<RevisionRow>(
    db,
    `SELECT ${REVISION_COLUMNS} FROM event_revisions WHERE change_set_id = ? ORDER BY id ASC`,
    [changeSetId],
  );
}

/* ------------------------------------------------------------------ */
/* Запись ревизий                                                      */
/* ------------------------------------------------------------------ */

export interface RecordRevisionInput {
  changeSetId: string;
  eventId: number;
  op: RevisionOp;
  before: EventRow | null;
  after: EventRow | null;
  actor: Actor;
}

export function recordRevision(db: Db, input: RecordRevisionInput): void {
  run(
    db,
    `INSERT INTO event_revisions
       (change_set_id, event_id, op, before_json, after_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      p(input.changeSetId),
      p(input.eventId),
      p(input.op),
      p(input.before === null ? null : JSON.stringify(input.before)),
      p(input.after === null ? null : JSON.stringify(input.after)),
      p(input.actor),
      p(nowIso()),
    ],
  );
}

/**
 * Изменилось ли хоть что-то по существу. `updated_at` не в счёт: он обновляется
 * при любой записи, и без этой проверки повторный одинаковый UPDATE плодил бы
 * пустые ревизии, засоряя историю, которую читает модель и человек.
 */
function sameExceptUpdatedAt(a: EventRow, b: EventRow): boolean {
  const strip = (row: EventRow): Omit<EventRow, 'updated_at'> => {
    const { updated_at: _ignored, ...rest } = row;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** Какой это вид правки с точки зрения журнала. */
function classify(before: EventRow | null, after: EventRow | null): RevisionOp {
  if (before === null) return 'insert';
  if (before.deleted_at === null && after?.deleted_at) return 'soft_delete';
  return 'update';
}

function eventById(db: Db, id: number): EventRow | null {
  return get<EventRow>(db, `SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`, [id]) ?? null;
}

export interface JournalContext {
  changeSetId: string;
  actor: Actor;
  utteranceId?: number | null;
  summary?: string | null;
}

/**
 * Выполняет изменение в транзакции, журналируя снимки «до» и «после».
 *
 * `affectedIds` вызывается ДО изменения и должен вернуть id строк, которые
 * изменение затронет. Для INSERT возвращает пустой список — новые строки
 * находятся по возросшему max(id).
 */
export function journaledChange<T>(
  db: Db,
  ctx: JournalContext,
  affectedIds: () => number[],
  apply: () => T,
): { result: T; touched: EventRow[] } {
  return inTransaction(db, () => {
    ensureChangeSet(db, {
      id: ctx.changeSetId,
      utteranceId: ctx.utteranceId ?? null,
      summary: ctx.summary ?? null,
    });

    const maxIdBefore = Number(
      get<{ m: number | null }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM events')?.m ?? 0,
    );

    const ids = affectedIds();
    const before = new Map<number, EventRow>();
    for (const id of ids) {
      const row = eventById(db, id);
      if (row) before.set(id, row);
    }

    const result = apply();

    // новые строки: всё, что получило id больше прежнего максимума
    const inserted = all<EventRow>(
      db,
      `SELECT ${EVENT_COLUMNS} FROM events WHERE id > ? ORDER BY id ASC`,
      [maxIdBefore],
    );

    const touched: EventRow[] = [];

    for (const id of before.keys()) {
      const after = eventById(db, id);
      const beforeRow = before.get(id) ?? null;
      if (!after) continue; // физически исчезнуть строка не может, но не падаем
      if (beforeRow && sameExceptUpdatedAt(beforeRow, after)) continue;
      recordRevision(db, {
        changeSetId: ctx.changeSetId,
        eventId: id,
        op: classify(beforeRow, after),
        before: beforeRow,
        after,
        actor: ctx.actor,
      });
      touched.push(after);
    }

    for (const row of inserted) {
      recordRevision(db, {
        changeSetId: ctx.changeSetId,
        eventId: row.id,
        op: 'insert',
        before: null,
        after: row,
        actor: ctx.actor,
      });
      touched.push(row);
    }

    return { result, touched };
  });
}

/* ------------------------------------------------------------------ */
/* sql_execute                                                         */
/* ------------------------------------------------------------------ */

export interface SqlExecuteResult {
  ok: true;
  changes: number;
  changeSetId: string;
  touched: EventRow[];
}

export interface SqlExecuteError {
  ok: false;
  error: string;
}

/**
 * Произвольный INSERT/UPDATE по events с журналированием (§9.3).
 * Валидатор вызывается здесь же — чтобы никакой путь в обход него не существовал.
 */
export function sqlExecute(
  db: Db,
  ctx: JournalContext,
  sql: string,
): SqlExecuteResult | SqlExecuteError {
  const check = checkSqlExecute(sql);
  if (!check.ok) return { ok: false, error: check.error };

  const plan = check.value;

  try {
    const { result, touched } = journaledChange(
      db,
      ctx,
      () => {
        if (plan.kind === 'insert') return [];
        // снимок «до» снимаем ТЕМ ЖЕ условием, что и само изменение
        const where = plan.where === null ? '1=1' : plan.where;
        const rows = all<{ id: number }>(
          db,
          `SELECT id FROM events WHERE ${where} LIMIT ?`,
          [MAX_AFFECTED_ROWS + 1],
        );
        if (rows.length > MAX_AFFECTED_ROWS) {
          throw new Error(
            `запрос затрагивает больше ${MAX_AFFECTED_ROWS} строк — сузь условие WHERE`,
          );
        }
        return rows.map((r) => Number(r.id));
      },
      () => db.prepare(sql).run(),
    );

    return {
      ok: true,
      changes: Number(result.changes ?? 0),
      changeSetId: ctx.changeSetId,
      touched,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/* ------------------------------------------------------------------ */
/* Откат                                                               */
/* ------------------------------------------------------------------ */

/** Колонки events в порядке, в котором их восстанавливает откат (id не трогаем). */
const RESTORE_COLUMNS = [
  'child_id',
  'type',
  'subtype',
  'started_at',
  'ended_at',
  'value_num',
  'value_unit',
  'note',
  'source',
  'utterance_id',
  'confidence',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;

export interface RevertResult {
  ok: true;
  changeSetId: string;
  revertChangeSetId: string;
  restored: EventRow[];
  alreadyReverted: boolean;
}

export interface RevertError {
  ok: false;
  error: string;
}

/**
 * Откат набора изменений (§9.3): строки восстанавливаются из `before_json`.
 *
 * Сам откат тоже пишется в журнал с op='revert' — поэтому отмену отмены
 * тоже можно отменить, и так сколько угодно раз.
 */
export function revertChangeSet(
  db: Db,
  changeSetId: string,
  actor: Actor,
): RevertResult | RevertError {
  const target = getChangeSet(db, changeSetId);
  if (!target) return { ok: false, error: `набор изменений ${changeSetId} не найден` };

  const revisions = listRevisions(db, changeSetId);
  if (revisions.length === 0) {
    return { ok: false, error: `в наборе ${changeSetId} нет изменений — откатывать нечего` };
  }

  const revertId = newChangeSetId();
  const restored: EventRow[] = [];

  inTransaction(db, () => {
    ensureChangeSet(db, {
      id: revertId,
      utteranceId: target.utterance_id,
      summary: `Откат набора изменений ${changeSetId}`,
    });

    // идём от последнего изменения к первому — так корректно ложатся цепочки правок
    for (const revision of [...revisions].reverse()) {
      const current = eventById(db, revision.event_id);
      if (!current) continue;

      const before = revision.before_json
        ? (JSON.parse(revision.before_json) as EventRow)
        : null;

      let next: EventRow;
      if (before === null) {
        // строку создал этот набор — физически удалить нельзя, значит прячем
        next = { ...current, deleted_at: current.deleted_at ?? nowIso(), updated_at: nowIso() };
      } else {
        next = { ...before, id: current.id, updated_at: nowIso() };
      }

      const params: SqlParam[] = RESTORE_COLUMNS.map((c) => p(next[c]));
      params.push(p(current.id));
      run(
        db,
        `UPDATE events SET ${RESTORE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        params,
      );

      const after = eventById(db, current.id);
      if (!after) continue;

      recordRevision(db, {
        changeSetId: revertId,
        eventId: current.id,
        op: 'revert',
        before: current,
        after,
        actor,
      });
      restored.push(after);
    }

    if (target.reverted_at === null) {
      run(db, 'UPDATE change_sets SET reverted_at = ? WHERE id = ?', [p(nowIso()), p(changeSetId)]);
    }
  });

  return {
    ok: true,
    changeSetId,
    revertChangeSetId: revertId,
    restored,
    alreadyReverted: target.reverted_at !== null,
  };
}

/* ------------------------------------------------------------------ */
/* Рубеж 3: снимки базы                                                */
/* ------------------------------------------------------------------ */

export const SNAPSHOT_KEEP = 50;

/**
 * `VACUUM INTO` перед каждым запуском модели. Страховка на случай, если модель
 * наворотит что-то массовое: журнал вернёт строки, а снимок вернёт всю базу.
 *
 * Возвращает путь к снимку или null, если снимок не делается (БД в памяти).
 */
export function createSnapshot(db: Db, dbPath: string, now: Date = new Date()): string | null {
  if (dbPath === ':memory:') return null;

  const dir = path.join(path.dirname(dbPath), 'snapshots');
  fs.mkdirSync(dir, { recursive: true });

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let target = path.join(dir, `${stamp}.db`);
  let suffix = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${stamp}-${suffix++}.db`);
  }

  // VACUUM не работает внутри транзакции и не принимает параметры — путь
  // формируем сами и экранируем кавычку по правилам SQL.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  pruneSnapshots(dir);
  return target;
}

export function pruneSnapshots(dir: string, keep: number = SNAPSHOT_KEEP): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
  } catch {
    return 0;
  }
  if (entries.length <= keep) return 0;

  // имена начинаются с ISO-времени, поэтому лексикографическая сортировка = хронологическая
  entries.sort();
  const doomed = entries.slice(0, entries.length - keep);
  let removed = 0;
  for (const name of doomed) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed++;
    } catch {
      /* снимок мог быть удалён снаружи */
    }
  }
  return removed;
}
