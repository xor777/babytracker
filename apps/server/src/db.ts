/**
 * SQLite через встроенный в Node модуль `node:sqlite`.
 *
 * Почему не better-sqlite3: на проде нет C++ тулчейна и мало диска, нативный
 * модуль там не соберётся. `node:sqlite` требует Node >= 24 (см. engines).
 *
 * Схема — дословно §1 контракта. Миграции идемпотентны и версионируются через
 * PRAGMA user_version, так что повторный запуск на существующей базе безопасен.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { EventRow, UtteranceRow } from './types.ts';

export type Db = DatabaseSync;

/** Значения, которые умеет принимать node:sqlite. `undefined` он не переваривает. */
export type SqlParam = string | number | bigint | null | Uint8Array;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS utterances (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text      TEXT    NOT NULL,
  alice_user_id TEXT,
  session_id    TEXT,
  received_at   TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',
  fast_result   TEXT,
  llm_result    TEXT,
  llm_error     TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  processed_at  TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id     TEXT    NOT NULL DEFAULT 'andrey',
  type         TEXT    NOT NULL,
  subtype      TEXT,
  started_at   TEXT    NOT NULL,
  ended_at     TEXT,
  value_num    REAL,
  value_unit   TEXT,
  note         TEXT,
  source       TEXT    NOT NULL,
  utterance_id INTEGER REFERENCES utterances(id),
  confidence   REAL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_started ON events(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_open    ON events(type, ended_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_utt_status     ON utterances(status, received_at);
`;

/**
 * §9.2 — журнал изменений и рубежи обороны.
 *
 * Триггеры здесь не «ещё одна проверка», а последняя линия: даже если валидатор
 * SQL обойдут или в коде появится баг, физически удалить событие будет нельзя.
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS change_sets (
  id           TEXT PRIMARY KEY,
  utterance_id INTEGER REFERENCES utterances(id),
  summary      TEXT,
  created_at   TEXT NOT NULL,
  reverted_at  TEXT
);

CREATE TABLE IF NOT EXISTS event_revisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id),
  event_id      INTEGER NOT NULL,
  op            TEXT NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  actor         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rev_cs    ON event_revisions(change_set_id);
CREATE INDEX IF NOT EXISTS idx_rev_event ON event_revisions(event_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_cs_created ON change_sets(created_at DESC);

-- Рубеж 1: физическое удаление невозможно ничем
CREATE TRIGGER IF NOT EXISTS events_no_hard_delete
BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'физическое удаление events запрещено: используй deleted_at');
END;

-- Рубеж 2: журнал только дописывается
CREATE TRIGGER IF NOT EXISTS revisions_no_update
BEFORE UPDATE ON event_revisions BEGIN
  SELECT RAISE(ABORT, 'event_revisions доступен только для добавления');
END;

CREATE TRIGGER IF NOT EXISTS revisions_no_delete
BEFORE DELETE ON event_revisions BEGIN
  SELECT RAISE(ABORT, 'event_revisions доступен только для добавления');
END;
`;

/**
 * Опознание владельца навыка (§3.1).
 *
 * Причина появления: `session.user_id` — устаревшее поле, оно идентифицирует
 * ЭКЗЕМПЛЯР ПРИЛОЖЕНИЯ, а не аккаунт. По документации Яндекса: «даже если
 * пользователь вошёл в один и тот же аккаунт в приложение Яндекс для Android
 * и iOS, Яндекс Диалоги присвоят отдельный user_id каждому из этих приложений».
 * Из-за этого белый список по нему блокировал владельца при каждой смене
 * устройства. Доверенные идентичности переезжают в БД, чтобы переживать
 * перезапуск и деплой и чтобы их можно было пополнять без правки .env.
 */
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS alice_identities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,          -- 'account' | 'device'
  identity       TEXT NOT NULL,
  status         TEXT NOT NULL,          -- 'trusted' | 'pending'
  account_id     TEXT,
  application_id TEXT,
  legacy_user_id TEXT,
  skill_id       TEXT,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  seen_count     INTEGER NOT NULL DEFAULT 1,
  source         TEXT NOT NULL,          -- 'tofu' | 'api' | 'enroll' | 'promoted'
  note           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alice_identity ON alice_identities(kind, identity);
CREATE INDEX IF NOT EXISTS idx_alice_status   ON alice_identities(status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Повторный разбор фразы (кнопка «разобрать заново» в админке).
 * Счётчик нужен модели: по нему она понимает, что события по этой фразе уже
 * могли быть созданы, и не плодит дубли.
 */
const SCHEMA_V4 = `
ALTER TABLE utterances ADD COLUMN reparse_count INTEGER NOT NULL DEFAULT 0;
`;

/**
 * Список миграций. Индекс + 1 == user_version после применения.
 * Добавлять только в конец, никогда не переписывать уже вышедшие.
 */
const MIGRATIONS: ReadonlyArray<(db: Db) => void> = [
  (db) => {
    db.exec(SCHEMA_V1);
  },
  (db) => {
    db.exec(SCHEMA_V2);
  },
  (db) => {
    db.exec(SCHEMA_V3);
  },
  (db) => {
    db.exec(SCHEMA_V4);
  },
];

export interface OpenDbOptions {
  /** Путь к файлу БД; `:memory:` для тестов. */
  path: string;
  /** MCP-серверу и воркеру нужен доступ к той же базе — WAL это позволяет. */
  readOnly?: boolean;
}

export function openDb(options: OpenDbOptions): Db {
  const isMemory = options.path === ':memory:';
  if (!isMemory) {
    fs.mkdirSync(path.dirname(options.path), { recursive: true });
  }

  const db = new DatabaseSync(options.path, {
    open: true,
    readOnly: options.readOnly ?? false,
  });

  if (!options.readOnly) {
    // WAL обязателен: сервер и MCP-сервер работают с файлом одновременно.
    if (!isMemory) db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA synchronous = NORMAL;');
    migrate(db);
  } else {
    db.exec('PRAGMA busy_timeout = 5000;');
  }

  return db;
}

/** Идемпотентно доводит схему до последней версии. */
export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);

  for (let version = current; version < MIGRATIONS.length; version++) {
    const migration = MIGRATIONS[version];
    if (!migration) continue;
    // node:sqlite не поддерживает параметры в PRAGMA, версия — число из кода, не из ввода.
    db.exec('BEGIN');
    try {
      migration(db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Типизированные хелперы                                              */
/* ------------------------------------------------------------------ */

export function all<T>(db: Db, sql: string, params: SqlParam[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function get<T>(db: Db, sql: string, params: SqlParam[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function run(
  db: Db,
  sql: string,
  params: SqlParam[] = [],
): { changes: number; lastInsertRowid: number } {
  const res = db.prepare(sql).run(...params);
  return {
    changes: Number(res.changes),
    lastInsertRowid: Number(res.lastInsertRowid),
  };
}

export function count(db: Db, sql: string, params: SqlParam[] = []): number {
  const row = get<{ n: number | bigint }>(db, sql, params);
  return row ? Number(row.n) : 0;
}

/** `undefined` -> `null`, числа/строки как есть. Для параметров node:sqlite. */
export function p(value: unknown): SqlParam {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  return String(value);
}

export const EVENT_COLUMNS =
  'id, child_id, type, subtype, started_at, ended_at, value_num, value_unit, note, source, utterance_id, confidence, created_at, updated_at, deleted_at';

export const UTTERANCE_COLUMNS =
  'id, raw_text, alice_user_id, session_id, received_at, status, fast_result, llm_result, ' +
  'llm_error, attempts, processed_at, reparse_count';

export function getEventById(db: Db, id: number): EventRow | undefined {
  return get<EventRow>(db, `SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`, [id]);
}

export function getUtteranceById(db: Db, id: number): UtteranceRow | undefined {
  return get<UtteranceRow>(db, `SELECT ${UTTERANCE_COLUMNS} FROM utterances WHERE id = ?`, [id]);
}

/**
 * Транзакция с защитой от вложенности: node:sqlite не умеет SAVEPOINT-обёртки,
 * а BEGIN внутри BEGIN — ошибка. Вложенный вызов просто выполняется в уже
 * открытой транзакции вызывающего.
 */
const inTx = new WeakSet<object>();

export function inTransaction<T>(db: Db, fn: () => T): T {
  if (inTx.has(db)) return fn();

  inTx.add(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* транзакция уже свёрнута самим SQLite */
    }
    throw err;
  } finally {
    inTx.delete(db);
  }
}

/** Проверка живости БД для /healthz. */
export function isDbAlive(db: Db): boolean {
  try {
    get(db, 'SELECT 1 AS ok');
    return true;
  } catch {
    return false;
  }
}
