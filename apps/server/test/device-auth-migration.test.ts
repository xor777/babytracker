/**
 * §11.11: миграция на авторизацию устройств обязана быть аддитивной.
 *
 * Это не формальность. Боевая база — единственный экземпляр истории жизни
 * ребёнка, восстановить её неоткуда, и мигрировать её будут поверх реальных
 * данных, а не пересоздавать. Поэтому проверяется не «схема применилась»,
 * а то, что после применения на месте ВСЁ: строки, значения, счётчики
 * автоинкремента, журнал ревизий и — отдельно — три триггера из §9, ради
 * которых физическое удаление событий невозможно в принципе.
 *
 * Тест намеренно строит базу версии 4 руками, а не берёт готовую: так видно,
 * что именно считается «состоянием до», и так проверка не сломается, когда
 * появится миграция шестая.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { all, get, migrate, openDb, type Db } from '../src/db.ts';
import { issueSession, startPairing } from '../src/device-auth.ts';

/* ------------------------------------------------------------------ */

/** Схема ровно в том виде, в каком она вышла на прод до §11 (user_version = 4). */
const SCHEMA_BEFORE = `
CREATE TABLE utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT, raw_text TEXT NOT NULL, alice_user_id TEXT,
  session_id TEXT, received_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  fast_result TEXT, llm_result TEXT, llm_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, processed_at TEXT,
  reparse_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, child_id TEXT NOT NULL DEFAULT 'andrey',
  type TEXT NOT NULL, subtype TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  value_num REAL, value_unit TEXT, note TEXT, source TEXT NOT NULL,
  utterance_id INTEGER REFERENCES utterances(id), confidence REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE change_sets (
  id TEXT PRIMARY KEY, utterance_id INTEGER REFERENCES utterances(id),
  summary TEXT, created_at TEXT NOT NULL, reverted_at TEXT
);
CREATE TABLE event_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, change_set_id TEXT NOT NULL REFERENCES change_sets(id),
  event_id INTEGER NOT NULL, op TEXT NOT NULL, before_json TEXT, after_json TEXT,
  actor TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE alice_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, identity TEXT NOT NULL,
  status TEXT NOT NULL, account_id TEXT, application_id TEXT, legacy_user_id TEXT,
  skill_id TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, note TEXT
);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TRIGGER events_no_hard_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'физическое удаление events запрещено: используй deleted_at');
END;
CREATE TRIGGER revisions_no_update BEFORE UPDATE ON event_revisions BEGIN
  SELECT RAISE(ABORT, 'event_revisions доступен только для добавления');
END;
CREATE TRIGGER revisions_no_delete BEFORE DELETE ON event_revisions BEGIN
  SELECT RAISE(ABORT, 'event_revisions доступен только для добавления');
END;

PRAGMA user_version = 4;
`;

/** Немного правдоподобных данных: сон, кормление, фраза, правка и её откат. */
function seed(db: Db): void {
  db.exec(`
    INSERT INTO utterances (id, raw_text, received_at, status, fast_result, attempts)
    VALUES (1, 'андрей заснул', '2026-09-14T18:02:00.000Z', 'done', '{"kind":"sleep_start"}', 1),
           (2, 'покушал и уснул', '2026-09-15T06:30:00.000Z', 'done', '{"kind":"sleep_start"}', 1);

    INSERT INTO events
      (id, type, subtype, started_at, ended_at, value_num, value_unit, note, source,
       utterance_id, confidence, created_at, updated_at, deleted_at)
    VALUES
      (1, 'sleep', 'night', '2026-09-14T18:02:00.000Z', '2026-09-15T04:11:00.000Z',
       NULL, NULL, NULL, 'alice-fast', 1, 0.95,
       '2026-09-14T18:02:01.000Z', '2026-09-15T04:11:01.000Z', NULL),
      (2, 'feed', 'bottle', '2026-09-15T06:28:00.000Z', NULL, 120, 'ml', NULL, 'alice-llm',
       2, 0.8, '2026-09-15T06:30:02.000Z', '2026-09-15T06:30:02.000Z', NULL),
      (3, 'diaper', 'wet', '2026-09-15T07:00:00.000Z', NULL, NULL, NULL, 'ошибка мамы',
       'manual', NULL, NULL, '2026-09-15T07:00:01.000Z', '2026-09-15T07:05:00.000Z',
       '2026-09-15T07:05:00.000Z');

    INSERT INTO change_sets (id, utterance_id, summary, created_at, reverted_at)
    VALUES ('cs-1', 2, 'разложил фразу на кормление и сон', '2026-09-15T06:30:02.000Z', NULL);

    INSERT INTO event_revisions
      (change_set_id, event_id, op, before_json, after_json, actor, created_at)
    VALUES ('cs-1', 2, 'insert', NULL, '{"id":2}', 'alice-llm', '2026-09-15T06:30:02.000Z');

    INSERT INTO alice_identities
      (kind, identity, status, first_seen_at, last_seen_at, seen_count, source)
    VALUES ('account', 'acc-1', 'trusted', '2026-09-01T10:00:00.000Z',
            '2026-09-15T06:30:00.000Z', 42, 'tofu');
  `);
}

interface Snapshot {
  events: unknown[];
  utterances: unknown[];
  changeSets: unknown[];
  revisions: unknown[];
  identities: unknown[];
  sequences: unknown[];
}

function snapshot(db: Db): Snapshot {
  return {
    events: all(db, 'SELECT * FROM events ORDER BY id'),
    utterances: all(db, 'SELECT * FROM utterances ORDER BY id'),
    changeSets: all(db, 'SELECT * FROM change_sets ORDER BY id'),
    revisions: all(db, 'SELECT * FROM event_revisions ORDER BY id'),
    identities: all(db, 'SELECT * FROM alice_identities ORDER BY id'),
    // Счётчики автоинкремента: если миграция их собьёт, новые события
    // начнут переиспользовать id уже существующих.
    sequences: all(db, 'SELECT name, seq FROM sqlite_sequence ORDER BY name'),
  };
}

function withFileDb(fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-migrate-'));
  try {
    fn(path.join(dir, 'babytracker.db'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ================================================================== */

test('миграция на §11 аддитивна: данные версии 4 переживают её без единого изменения', () => {
  withFileDb((file) => {
    // 1. Боевая база «до»: схема четвёртой версии с настоящими данными.
    const before = new DatabaseSync(file);
    before.exec('PRAGMA foreign_keys = ON;');
    before.exec(SCHEMA_BEFORE);
    seed(before);
    const expected = snapshot(before);
    assert.equal(
      Number((before.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
      4,
    );
    before.close();

    // 2. Открываем тем же кодом, что и сервер: openDb сам прогоняет миграции.
    const after = openDb({ path: file });

    const version = Number(
      (after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    assert.equal(version, 5, 'версия схемы поднялась ровно на одну');

    // 3. Данные — байт в байт те же.
    const actual = snapshot(after);
    assert.deepEqual(actual.events, expected.events, 'события не должны измениться ничем');
    assert.deepEqual(actual.utterances, expected.utterances, 'фразы не должны измениться');
    assert.deepEqual(actual.changeSets, expected.changeSets, 'журнал изменений не должен измениться');
    assert.deepEqual(actual.revisions, expected.revisions, 'ревизии не должны измениться');
    assert.deepEqual(actual.identities, expected.identities, 'доверенные идентичности на месте');
    assert.deepEqual(actual.sequences, expected.sequences, 'счётчики id не должны сбиться');

    // 4. Мягко удалённое событие осталось мягко удалённым, а не исчезло и не воскресло.
    const deleted = get<{ deleted_at: string | null }>(
      after,
      'SELECT deleted_at FROM events WHERE id = 3',
    );
    assert.equal(deleted?.deleted_at, '2026-09-15T07:05:00.000Z');

    after.close();
  });
});

test('миграция не трогает рубежи обороны §9', () => {
  withFileDb((file) => {
    const before = new DatabaseSync(file);
    before.exec(SCHEMA_BEFORE);
    seed(before);
    before.close();

    const db = openDb({ path: file });

    // Рубеж 1: физическое удаление события по-прежнему невозможно.
    assert.throws(
      () => db.exec('DELETE FROM events WHERE id = 1'),
      /физическое удаление events запрещено/,
      'триггер §9.1 обязан пережить миграцию',
    );

    // Рубеж 2: журнал ревизий только дописывается.
    assert.throws(
      () => db.exec("UPDATE event_revisions SET actor = 'кто-то другой' WHERE id = 1"),
      /только для добавления/,
    );
    assert.throws(() => db.exec('DELETE FROM event_revisions WHERE id = 1'), /только для добавления/);

    // И само событие на месте после всех трёх неудачных попыток.
    assert.equal(
      Number(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM events')?.n),
      3,
      'ни одна отклонённая операция не должна была ничего изменить',
    );

    db.close();
  });
});

test('после миграции новые таблицы работают, а старые не задеты', () => {
  withFileDb((file) => {
    const before = new DatabaseSync(file);
    before.exec(SCHEMA_BEFORE);
    seed(before);
    before.close();

    const db = openDb({ path: file });

    // Новые таблицы пустые и рабочие.
    assert.equal(Number(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM device_sessions')?.n), 0);
    assert.equal(Number(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM device_codes')?.n), 0);

    const issued = issueSession(db, { kind: 'tv', label: 'Телевизор' });
    assert.ok(issued.session.id);
    const started = startPairing(db, { kind: 'phone' });
    assert.ok(started.userCode);

    // Старые данные по-прежнему на месте и читаются.
    assert.equal(Number(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM events')?.n), 3);
    assert.equal(
      get<{ raw_text: string }>(db, 'SELECT raw_text FROM utterances WHERE id = 2')?.raw_text,
      'покушал и уснул',
    );

    db.close();
  });
});

test('повторный запуск миграции ничего не делает: она идемпотентна', () => {
  withFileDb((file) => {
    const before = new DatabaseSync(file);
    before.exec(SCHEMA_BEFORE);
    seed(before);
    before.close();

    const db = openDb({ path: file });
    issueSession(db, { kind: 'tv', label: 'Телевизор' });
    const expected = snapshot(db);
    const sessionsBefore = all(db, 'SELECT * FROM device_sessions');

    // Так выглядит повторный деплой на уже мигрированную базу.
    migrate(db);
    migrate(db);

    assert.deepEqual(snapshot(db), expected, 'повторная миграция не должна ничего менять');
    assert.deepEqual(all(db, 'SELECT * FROM device_sessions'), sessionsBefore, 'сессии на месте');
    assert.equal(
      Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
      5,
    );

    db.close();
  });
});

test('уникальность короткого кода среди ждущих: одобрение не уйдёт не тому', () => {
  withFileDb((file) => {
    const db = openDb({ path: file });

    // Частичный индекс не должен мешать истории: погашенные коды могут
    // повторяться сколько угодно, а вот два ЖДУЩИХ с одним кодом — нет.
    db.exec(`
      INSERT INTO device_codes
        (device_code_hash, user_code, kind, status, created_at, expires_at, interval_sec)
      VALUES ('h1', 'WDJBMJHT', 'tv', 'claimed', '2026-09-01T00:00:00.000Z',
              '2026-09-01T00:10:00.000Z', 5),
             ('h2', 'WDJBMJHT', 'tv', 'expired', '2026-09-02T00:00:00.000Z',
              '2026-09-02T00:10:00.000Z', 5),
             ('h3', 'WDJBMJHT', 'tv', 'pending', '2026-09-03T00:00:00.000Z',
              '2026-09-03T00:10:00.000Z', 5);
    `);

    assert.throws(
      () =>
        db.exec(`
          INSERT INTO device_codes
            (device_code_hash, user_code, kind, status, created_at, expires_at, interval_sec)
          VALUES ('h4', 'WDJBMJHT', 'tv', 'pending', '2026-09-03T00:05:00.000Z',
                  '2026-09-03T00:15:00.000Z', 5);
        `),
      /UNIQUE|constraint/i,
      'два ждущих устройства с одним кодом означали бы одобрение не тому',
    );

    db.close();
  });
});
