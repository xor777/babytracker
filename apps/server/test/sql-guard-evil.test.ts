/**
 * §9.3 — вторая порция проверок валидатора SQL, злая.
 *
 * Здесь не «работает ли разрешённое», а «нельзя ли пролезть». Модель пишет SQL
 * по свободной русской фразе и правит данные, которые восстановить неоткуда;
 * §9 требует, чтобы безвозвратной модификации не существовало. Всё, что
 * проскочило сюда, ломает это требование напрямую.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSqlExecute, checkSqlQuery, tokenizeSql } from '../src/sql-guard.ts';

function accepted(sql: string): void {
  const res = checkSqlExecute(sql);
  assert.equal(res.ok, true, `должен быть принят, но отклонён (${res.ok ? '' : res.error}):\n  ${sql}`);
}

function rejected(sql: string, expect?: RegExp): string {
  const res = checkSqlExecute(sql);
  assert.equal(res.ok, false, `ДЫРА: запрос принят, хотя не должен:\n  ${sql}`);
  const error = res.ok ? '' : res.error;
  if (expect) assert.match(error, expect, `текст ошибки не подсказывает выход:\n  ${error}`);
  return error;
}

const INSERT_COLUMNS = '(type, started_at, source, created_at, updated_at)';
const INSERT_VALUES = "('note', 't', 'alice-llm', 't', 't')";

/* ------------------------------------------------------------------ */
/* Идентификатор строки — прямой путь к необратимой потере             */
/* ------------------------------------------------------------------ */

test('явная попытка сменить id отбивается во всех написаниях', () => {
  rejected('UPDATE events SET id = 5 WHERE id = 1', /id/);
  rejected('UPDATE events SET ID = 5 WHERE id = 1', /id/);
  rejected('UPDATE events SET "id" = 5 WHERE id = 1', /id/);
  rejected('UPDATE events SET [id] = 5 WHERE id = 1', /id/);
  rejected('UPDATE events SET `id` = 5 WHERE id = 1', /id/);
  rejected('UPDATE events SET rowid = 5 WHERE id = 1', /rowid/);
  rejected('UPDATE events SET ROWID = 5 WHERE id = 1', /rowid/);
  rejected('UPDATE events SET note = 1, id = 5', /id/);
  rejected('UPDATE events SET (note, id) = (1, 5)', /id/);
});

test(
  'БАГ: псевдонимы rowid (oid, _rowid_) проходят мимо защиты и меняют id события',
  () => {
    rejected('UPDATE events SET oid = 500 WHERE id = 1', /oid|id/);
    rejected('UPDATE events SET _rowid_ = 500 WHERE id = 1', /rowid|id/);
    rejected('UPDATE events SET OID = 500 WHERE id = 1', /oid|id/);
    rejected(`INSERT INTO events (oid, type, started_at, source, created_at, updated_at)
              VALUES (500, 'note', 't', 'alice-llm', 't', 't')`, /oid|id/);
  },
);

test('перезапись истории и чужой привязки к фразе запрещена', () => {
  rejected("UPDATE events SET created_at = 'подделка'", /created_at|неизменяем/);
  rejected('UPDATE events SET utterance_id = 7 WHERE id = 1', /utterance_id/);
  // а читать эти колонки в условии можно
  accepted("UPDATE events SET note = 'x' WHERE utterance_id = 7 AND created_at > 't'");
});

test(
  'БАГ: ON CONFLICT ... DO UPDATE SET не проверяется на защищённые колонки',
  () => {
    rejected(
      `INSERT INTO events ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}
       ON CONFLICT(id) DO UPDATE SET created_at = 'подделка'`,
      /created_at/,
    );
    rejected(
      `INSERT INTO events ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}
       ON CONFLICT(id) DO UPDATE SET id = 9999`,
      /id/,
    );
  },
);

/* ------------------------------------------------------------------ */
/* Ключевые слова: токен против подстроки                              */
/* ------------------------------------------------------------------ */

test('запрещённое слово внутри данных — это просто данные', () => {
  accepted("UPDATE events SET note = 'не надо delete'");
  accepted("UPDATE events SET note = 'DROP TABLE events'");
  accepted("UPDATE events SET note = 'DELETE; VACUUM; ATTACH'");
  accepted("UPDATE events SET note = 'a;b' WHERE note LIKE '%delete%'");
  accepted("UPDATE events SET note = 'it''s a pragma'");
  accepted(`INSERT INTO events (type, note, started_at, source, created_at, updated_at)
            VALUES ('note', 'DROP TABLE events', 't', 'alice-llm', 't', 't')`);
});

test('запрещённое слово как токен — отказ, в любом регистре и написании', () => {
  rejected('DELETE FROM events', /deleted_at/);
  rejected('delete from events WHERE id = 1', /deleted_at/);
  rejected('DrOp TaBlE events', /схем/);
  rejected('ALTER TABLE events ADD COLUMN x', /схем/);
  rejected('CREATE TABLE x (a)', /схем/);
  rejected('TRUNCATE events', /deleted_at|команд/);
  rejected("VACUUM INTO '/tmp/x.db'", /служебн/);
  rejected("ATTACH DATABASE '/tmp/x.db' AS x", /основной баз/);
  rejected('DETACH x', /основной баз/);
  rejected('PRAGMA journal_mode = DELETE', /служебн/);
  rejected('REINDEX events', /служебн/);
  rejected('ANALYZE events', /служебн/);
});

test('управление транзакцией не отдаём: снимок «до» снимает сервер', () => {
  for (const sql of [
    "BEGIN; UPDATE events SET note = 'x'",
    "UPDATE events SET note = 'x'; COMMIT",
    'ROLLBACK',
    "SAVEPOINT s; UPDATE events SET note = 'x'",
    'RELEASE s',
  ]) {
    rejected(sql, /транзакц|statement/);
  }
});

test('REPLACE: функция разрешена, затирающая форма — нет', () => {
  accepted("UPDATE events SET note = replace(note, 'а', 'б')");
  accepted("UPDATE events SET note = REPLACE(note, 'а', 'б') WHERE id = 1");
  rejected("REPLACE INTO events (type) VALUES ('note')", /REPLACE/);
  rejected(`INSERT OR REPLACE INTO events ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}`, /REPLACE/);
});

/* ------------------------------------------------------------------ */
/* Спрятанная вторая команда                                           */
/* ------------------------------------------------------------------ */

test('вторая команда не прячется ни за комментарием, ни за переносом строки', () => {
  rejected("UPDATE events SET note = 'x' -- \n; DROP TABLE events", /statement|DROP/);
  rejected("UPDATE events SET note = 'x' /* тут */ ; DELETE FROM events", /statement|DELETE/);
  rejected("UPDATE events SET note = 'x'\n;\nUPDATE events SET note = 'y'", /statement/);
  rejected("UPDATE events SET note = 'x';;", /statement/);
  rejected("UPDATE events SET note = 'x'; SELECT 1", /statement/);
});

test('точка с запятой внутри литерала и в конце запроса — не разделитель', () => {
  accepted("UPDATE events SET note = 'первое; второе'");
  accepted("UPDATE events SET note = 'x' WHERE id = 1;");
  accepted("UPDATE events SET note = 'x' WHERE id = 1; -- всё");
  accepted("UPDATE events SET note = 'x' WHERE id = 1; /* всё */");
});

test('запрос только из комментариев или пустой отклоняется понятно', () => {
  rejected('', /пуст/);
  rejected('   \n\t ', /пуст/);
  rejected('-- ничего', /комментар/);
  rejected('/* ничего */', /комментар/);
  rejected('/* незакрытый', /комментар/);
});

/* ------------------------------------------------------------------ */
/* Чужие таблицы                                                       */
/* ------------------------------------------------------------------ */

test('любая таблица кроме events закрыта — и в SET, и в WHERE, и в источнике', () => {
  rejected("UPDATE utterances SET raw_text = 'x'", /events/);
  rejected("UPDATE change_sets SET reverted_at = NULL", /events/);
  rejected('UPDATE event_revisions SET before_json = NULL', /events/);
  rejected("UPDATE events SET note = (SELECT raw_text FROM utterances LIMIT 1)", /utterances/);
  rejected("UPDATE events SET note = 'x' WHERE id IN (SELECT id FROM sqlite_master)", /sqlite_master/);
  rejected("UPDATE events SET note = 'x' FROM utterances", /utterances/);
  rejected(`INSERT INTO events ${INSERT_COLUMNS} SELECT 1,2,3,4,5 FROM utterances`, /utterances/);
});

test('похожее на events имя — это не events', () => {
  rejected("UPDATE events2 SET note = 'x'", /events2/);
  rejected("UPDATE my_events SET note = 'x'", /my_events/);
  // кириллическая «е» в середине слова — визуально то же самое, для базы другое
  rejected("UPDATE evеnts SET note = 'x'", /запрещен/);
});

test('своя таблица в любом написании остаётся своей', () => {
  accepted("UPDATE main.events SET note = 'x'");
  accepted(`UPDATE "events" SET note = 'x'`);
  accepted("UPDATE [events] SET note = 'x'");
  accepted('UPDATE `events` SET note = \'x\'');
  accepted("UpDaTe EvEnTs SeT note = 'x'");
  accepted("UPDATE events SET note = 'x' WHERE id IN (SELECT id FROM events WHERE type = 'sleep')");
});

/* ------------------------------------------------------------------ */
/* Форма запроса                                                       */
/* ------------------------------------------------------------------ */

test('INSERT без явного списка колонок не проходит: значение попало бы в id', () => {
  rejected("INSERT INTO events VALUES (1, 'andrey', 'sleep')", /перечисли колонки/);
  rejected('INSERT INTO events DEFAULT VALUES', /перечисли колонки/);
});

test('через sql_execute нельзя ни читать, ни начинать с CTE', () => {
  rejected('SELECT * FROM events', /sql_query/);
  rejected('WITH x AS (SELECT 1) UPDATE events SET note = 1', /WITH|CTE/);
  rejected("'строка вместо команды'", /INSERT INTO events|UPDATE events/);
  rejected('42', /INSERT INTO events|UPDATE events/);
});

test('незакрытые кавычки — ошибка, а не молчаливый разбор половины запроса', () => {
  rejected("UPDATE events SET note = 'хвост оборван", /незакрыт/);
  rejected('UPDATE events SET `колонка = 1', /незакрыт/);
  rejected('UPDATE events SET "колонка = 1', /незакрыт/);
  rejected('UPDATE events SET note = [колонка', /незакрыт/);
  rejected("UPDATE events SET note = x'4142", /незакрыт/);
});

test('нормальная работа с данными по-прежнему разрешена', () => {
  accepted("UPDATE events SET deleted_at = '2026-09-15T10:00:00.000Z', updated_at = '2026-09-15T10:00:00.000Z' WHERE type = 'sleep' AND started_at >= '2026-09-15'");
  accepted("UPDATE events SET started_at = '2026-09-15T14:00:00.000Z' WHERE id = 42");
  accepted('UPDATE events SET value_num = 1e2, value_unit = \'ml\' WHERE id = 42');
  accepted("UPDATE events SET note = CASE WHEN note IS NULL THEN 'a' ELSE note END");
  accepted(`INSERT INTO events ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}`);
  accepted(`INSERT INTO events ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}, ${INSERT_VALUES}`);
  accepted("UPDATE events SET note = 'x' WHERE id = (SELECT MAX(id) FROM events)");
});

/* ------------------------------------------------------------------ */
/* WHERE для снимка «до»                                               */
/* ------------------------------------------------------------------ */

test('условие вырезается целиком и без лишнего', () => {
  const plan = (sql: string) => {
    const res = checkSqlExecute(sql);
    assert.equal(res.ok, true, res.ok ? '' : res.error);
    return res.ok ? res.value : null;
  };

  assert.equal(plan("UPDATE events SET note = 'x' WHERE id = 1")?.where, 'id = 1');
  assert.equal(plan("UPDATE events SET note = 'x'")?.where, null, 'нет условия — null, а не пусто');
  assert.equal(
    plan("UPDATE events SET note = 'x' WHERE note = 'where id = 2'")?.where,
    "note = 'where id = 2'",
    'слово WHERE внутри литерала не начинает новое условие',
  );
  assert.equal(
    plan("UPDATE events SET note = 'x' WHERE id IN (SELECT id FROM events WHERE type = 'sleep')")?.where,
    "id IN (SELECT id FROM events WHERE type = 'sleep')",
    'внутренний WHERE не путается с внешним',
  );
  assert.equal(plan("UPDATE events SET note = 'x' WHERE id = 1 RETURNING id")?.where, 'id = 1');
  assert.equal(plan("UPDATE events SET note = 'x' WHERE id = 1;")?.where, 'id = 1');
  assert.equal(plan(`INSERT INTO events ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}`)?.where, null);
});

/* ------------------------------------------------------------------ */
/* Токенизатор                                                         */
/* ------------------------------------------------------------------ */

test('токенизатор: литералы, экранирование и blob остаются одним токеном', () => {
  assert.deepEqual(
    tokenizeSql("UPDATE events SET note = 'it''s; drop' -- хвост").tokens.map((t) => t.raw),
    ['UPDATE', 'events', 'SET', 'note', '=', "'it''s; drop'"],
  );
  assert.deepEqual(
    tokenizeSql("x'4142' , 1").tokens.map((t) => [t.type, t.raw]),
    [
      ['blob', "x'4142'"],
      ['punct', ','],
      ['number', '1'],
    ],
  );
  assert.deepEqual(
    tokenizeSql('"кол""онка"').tokens.map((t) => [t.type, t.raw]),
    [['ident', '"кол""онка"']],
  );
});

test('токенизатор: комментарии исчезают целиком, включая спрятанное в них', () => {
  assert.deepEqual(
    tokenizeSql("UPDATE /* DROP TABLE */ events -- DELETE\nSET note = 1").tokens.map((t) => t.upper),
    ['UPDATE', 'EVENTS', 'SET', 'NOTE', '=', '1'],
  );
});

test('токенизатор сообщает о незакрытых конструкциях, а не молчит', () => {
  assert.match(tokenizeSql("SELECT 'хвост").error ?? '', /незакрыт/);
  assert.match(tokenizeSql('SELECT /* хвост').error ?? '', /незакрыт/);
  assert.match(tokenizeSql('SELECT "хвост').error ?? '', /незакрыт/);
  assert.match(tokenizeSql('SELECT [хвост').error ?? '', /незакрыт/);
  assert.equal(tokenizeSql("SELECT 'закрыт'").error, undefined);
});

/* ------------------------------------------------------------------ */
/* sql_query — только чтение                                           */
/* ------------------------------------------------------------------ */

test('sql_query читает любые таблицы, но ничего не меняет', () => {
  for (const sql of [
    'SELECT * FROM events',
    'SELECT COUNT(*) FROM utterances',
    'SELECT * FROM change_sets JOIN event_revisions ON 1 = 1',
    'WITH a AS (SELECT 1 AS x) SELECT * FROM a',
    'VALUES (1), (2)',
    "SELECT ';' AS точка_с_запятой",
    "SELECT 'DROP TABLE events' AS текст",
  ]) {
    assert.equal(checkSqlQuery(sql).ok, true, `должен читаться: ${sql}`);
  }

  for (const [sql, expect] of [
    ["UPDATE events SET note = 'x'", /sql_execute/],
    [`INSERT INTO events ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}`, /sql_execute/],
    ['DELETE FROM events', /deleted_at/],
    ['PRAGMA table_info(events)', /служебн/],
    ['DROP TABLE events', /схем/],
    ['SELECT 1; DROP TABLE events', /statement/],
    ['', /пуст/],
  ] as Array<[string, RegExp]>) {
    const res = checkSqlQuery(sql);
    assert.equal(res.ok, false, `ДЫРА: sql_query принял «${sql}»`);
    assert.match(res.ok ? '' : res.error, expect);
  }
});

test('каждый отказ объясняет, что делать вместо — иначе модель зациклится', () => {
  assert.match(rejected('DELETE FROM events WHERE id = 1'), /UPDATE events SET deleted_at/);
  assert.match(rejected("UPDATE utterances SET raw_text = 'x'"), /sql_query/);
  assert.match(rejected('INSERT INTO events VALUES (1)'), /перечисли колонки/);
  assert.match(rejected("UPDATE events SET note = 'x'; SELECT 1"), /по одному вызову/);
  assert.match(rejected('SELECT * FROM events'), /sql_query/);
});
