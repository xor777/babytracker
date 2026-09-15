/**
 * §9.3 — рамки произвольного SQL.
 *
 * Обход этого валидатора = потеря данных заказчика, поэтому проверок много
 * и они намеренно злые. Ключевая идея: разбор по токенам, а не по подстрокам.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSqlExecute, checkSqlQuery, tokenizeSql } from '../src/sql-guard.ts';

function ok(sql: string): void {
  const res = checkSqlExecute(sql);
  assert.equal(res.ok, true, `должен быть принят, но отклонён: ${res.ok ? '' : res.error}\n  ${sql}`);
}

function rejected(sql: string, expect?: RegExp): string {
  const res = checkSqlExecute(sql);
  assert.equal(res.ok, false, `должен быть отклонён, но принят:\n  ${sql}`);
  const error = res.ok ? '' : res.error;
  if (expect) assert.match(error, expect, `текст ошибки не подсказывает решение:\n  ${error}`);
  return error;
}

/* ------------------------------------------------------------------ */
/* Токенизатор                                                         */
/* ------------------------------------------------------------------ */

test('токенизатор: строковый литерал поглощает всё внутри', () => {
  const { tokens } = tokenizeSql("UPDATE events SET note = 'drop; delete -- х'");
  const strings = tokens.filter((t) => t.type === 'string');
  assert.equal(strings.length, 1);
  assert.equal(strings[0]?.raw, "'drop; delete -- х'");
  assert.equal(tokens.some((t) => t.type === 'word' && t.upper === 'DROP'), false);
});

test('токенизатор: экранированная кавычка не рвёт литерал', () => {
  const { tokens, error } = tokenizeSql("UPDATE events SET note = 'it''s ok' WHERE id = 1");
  assert.equal(error, undefined);
  const strings = tokens.filter((t) => t.type === 'string');
  assert.equal(strings.length, 1, "«it''s» — одна строка, а не две");
  assert.equal(strings[0]?.raw, "'it''s ok'");
});

test('токенизатор: комментарии выбрасываются целиком', () => {
  const { tokens } = tokenizeSql('UPDATE /* тут DROP */ events -- и тут DROP\n SET note = 1');
  assert.equal(tokens.some((t) => t.upper === 'DROP'), false);
});

test('токенизатор: незакрытые конструкции — ошибка, а не молчаливый разбор', () => {
  assert.match(tokenizeSql("UPDATE events SET note = 'хвост").error ?? '', /незакрыт/);
  assert.match(tokenizeSql('UPDATE events /* без конца').error ?? '', /незакрыт/);
});

/* ------------------------------------------------------------------ */
/* Разрешённое                                                         */
/* ------------------------------------------------------------------ */

test('валидные UPDATE проходят', () => {
  ok("UPDATE events SET deleted_at = '2026-09-15T12:00:00.000Z' WHERE type = 'sleep'");
  ok("UPDATE events SET started_at = '2026-09-15T06:00:00.000Z', updated_at = '2026-09-15T12:00:00.000Z' WHERE id = 7");
  ok('UPDATE events SET value_num = value_num + 10 WHERE id = 3');
  ok("update events set note='x' where id=1");
  ok("UPDATE\n  events\n  SET   note = 'многострочно'\n  WHERE id = 1");
  ok("UPDATE main.events SET note = 'со схемой' WHERE id = 1");
  ok("UPDATE events SET note = 'x' WHERE id IN (SELECT id FROM events WHERE type = 'sleep')");
});

test('ключевое слово внутри литерала — это просто текст', () => {
  ok("UPDATE events SET note = 'не надо delete' WHERE id = 1");
  ok("UPDATE events SET note = 'DROP TABLE events' WHERE id = 1");
  ok("UPDATE events SET note = 'а;б;в' WHERE id = 1");
  ok("UPDATE events SET note = 'вчера -- было так' WHERE id = 1");
  ok("UPDATE events SET note = '/* не комментарий */' WHERE id = 1");
});

test('выражение CASE ... END не ломается о запрет транзакций', () => {
  ok(
    "UPDATE events SET subtype = CASE WHEN started_at < '2026-09-15T16:00:00Z' " +
      "THEN 'nap' ELSE 'night' END WHERE type = 'sleep'",
  );
});

test('функция replace() разрешена, REPLACE INTO — нет', () => {
  ok("UPDATE events SET note = replace(note, 'а', 'б') WHERE id = 1");
  rejected("REPLACE INTO events (type) VALUES ('sleep')", /REPLACE/);
  rejected("INSERT OR REPLACE INTO events (type) VALUES ('sleep')", /REPLACE/);
});

test('валидные INSERT проходят', () => {
  ok(
    "INSERT INTO events (type, subtype, started_at, source, created_at, updated_at) " +
      "VALUES ('sleep', 'nap', '2026-09-15T10:00:00.000Z', 'alice-llm', '2026-09-15T12:00:00.000Z', '2026-09-15T12:00:00.000Z')",
  );
  ok("insert into events (type, started_at, source, created_at, updated_at) values ('note','2026-09-15T10:00:00Z','alice-llm','x','y')");
});

test('точка с запятой в конце — не «вторая команда»', () => {
  ok("UPDATE events SET note = 'x' WHERE id = 1;");
  ok("UPDATE events SET note = 'x' WHERE id = 1;   \n  ");
});

/* ------------------------------------------------------------------ */
/* Запрещённое                                                         */
/* ------------------------------------------------------------------ */

test('DELETE отклоняется и подсказывает deleted_at', () => {
  const error = rejected('DELETE FROM events', /deleted_at/);
  assert.match(error, /UPDATE events SET deleted_at/, 'подсказка должна быть готовым рецептом');
  rejected("DELETE FROM events WHERE type = 'sleep'", /deleted_at/);
  rejected('delete from events', /deleted_at/);
  rejected('dElEtE FROM events', /deleted_at/);
});

test('вторая команда за «;» не проходит', () => {
  rejected("UPDATE events SET note='x'; DROP TABLE events", /один statement|DROP/i);
  rejected("UPDATE events SET note='x' ; DELETE FROM events", /один statement|deleted_at/i);
  rejected("INSERT INTO events (type) VALUES ('note'); UPDATE events SET note='y'", /один statement/i);
});

test('вторая команда, спрятанная за однострочным комментарием', () => {
  rejected("UPDATE events SET note='x' -- ;\nDROP TABLE events", /DROP/);
  rejected("UPDATE events SET note='x' --;\nDELETE FROM events", /deleted_at/);
  rejected("UPDATE events SET note='x'\n-- безобидный комментарий\n; DROP TABLE events", /DROP|statement/);
});

test('вторая команда, спрятанная за блочным комментарием', () => {
  rejected("UPDATE events SET note='x' /* ; */ DROP TABLE events", /DROP/);
  rejected("UPDATE events /* ; DROP */ SET note='x'; DROP TABLE events", /DROP|statement/);
  rejected("UPDATE events SET note='x'/*;*/;/*;*/DELETE FROM events", /deleted_at|statement/);
});

test('обращение к чужой таблице отклоняется', () => {
  rejected("UPDATE utterances SET raw_text = 'x'", /utterances/);
  rejected("INSERT INTO change_sets (id, created_at) VALUES ('x','y')", /change_sets/);
  rejected("UPDATE event_revisions SET before_json = NULL", /event_revisions/);
  rejected("INSERT INTO events (type) SELECT raw_text FROM utterances", /utterances/);
  rejected("UPDATE events SET note = 'x' FROM utterances", /utterances/);
  rejected('UPDATE "utterances" SET raw_text = 1', /utterances/);
  rejected('UPDATE [utterances] SET raw_text = 1', /utterances/);
});

test('DDL и служебные команды отклоняются в любом регистре', () => {
  for (const sql of [
    'DROP TABLE events',
    'dRoP TaBlE events',
    'ALTER TABLE events ADD COLUMN x TEXT',
    'CREATE TABLE evil (id INTEGER)',
    'VACUUM',
    "ATTACH DATABASE '/tmp/evil.db' AS evil",
    'DETACH DATABASE evil',
    'PRAGMA journal_mode = DELETE',
    'TRUNCATE TABLE events',
    'REINDEX events',
  ]) {
    rejected(sql);
  }
});

test('управление транзакциями запрещено', () => {
  rejected("BEGIN; UPDATE events SET note='x'", /транзакц|statement/i);
  rejected("UPDATE events SET note='x'; COMMIT", /транзакц|statement/i);
  rejected("ROLLBACK", /транзакц/i);
});

test('SELECT и прочее через sql_execute не проходят', () => {
  rejected('SELECT * FROM events', /sql_query/);
  rejected("WITH x AS (SELECT 1) UPDATE events SET note='y'", /WITH|CTE/);
});

test('защищённые колонки не изменить', () => {
  rejected('UPDATE events SET id = 5 WHERE id = 1', /id/);
  rejected("UPDATE events SET created_at = 'x' WHERE id = 1", /created_at/);
  rejected('UPDATE events SET utterance_id = 99 WHERE id = 1', /utterance_id/);
  rejected("UPDATE events SET note = 'x', id = 2 WHERE id = 1", /id/);
  rejected("UPDATE events SET rowid = 2 WHERE id = 1", /rowid/);
  rejected("INSERT INTO events (id, type) VALUES (5, 'note')", /id/);
  // created_at при вставке СВОЕЙ строки разрешён: колонка NOT NULL без DEFAULT,
  // без неё INSERT невозможен. Защищён он только от UPDATE — см. sql-guard.ts.
  ok("INSERT INTO events (type, started_at, source, created_at, updated_at) VALUES ('note','t','alice-llm','c','u')");
});

test('INSERT без списка колонок отклоняется: значение попало бы в id', () => {
  rejected("INSERT INTO events VALUES (1, 'andrey', 'sleep')", /колонки явно/);
});

test('колонка id внутри строки или как значение не считается попыткой её изменить', () => {
  ok("UPDATE events SET note = 'поменяй id' WHERE id = 1");
  ok('UPDATE events SET value_num = id WHERE id = 1');
});

test('мусор и пустой ввод отклоняются понятно', () => {
  rejected('', /пустой/);
  rejected('   ', /пустой/);
  rejected('-- только комментарий', /комментари/);
  rejected('абырвалг', /INSERT|UPDATE/);
});

/* ------------------------------------------------------------------ */
/* Разбор WHERE для снимка «до»                                        */
/* ------------------------------------------------------------------ */

test('WHERE вырезается точно, включая литералы с ключевыми словами', () => {
  const res = checkSqlExecute(
    "UPDATE events SET note = 'x' WHERE type = 'sleep' AND note != 'where delete'",
  );
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.value.where, "type = 'sleep' AND note != 'where delete'");
});

test('WHERE в подзапросе не путается с внешним', () => {
  const res = checkSqlExecute(
    "UPDATE events SET note = 'x' WHERE id IN (SELECT id FROM events WHERE type = 'sleep')",
  );
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.value.where, "id IN (SELECT id FROM events WHERE type = 'sleep')");
});

test('UPDATE без WHERE распознаётся как «без условия»', () => {
  const res = checkSqlExecute("UPDATE events SET note = 'x'");
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.value.where, null);
});

test('RETURNING не попадает в WHERE', () => {
  const res = checkSqlExecute("UPDATE events SET note = 'x' WHERE id = 1 RETURNING id");
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.value.where, 'id = 1');
});

/* ------------------------------------------------------------------ */
/* sql_query                                                           */
/* ------------------------------------------------------------------ */

test('sql_query: SELECT по любым таблицам разрешён', () => {
  for (const sql of [
    'SELECT * FROM events',
    'SELECT COUNT(*) FROM utterances',
    'SELECT e.id, r.op FROM events e JOIN event_revisions r ON r.event_id = e.id',
    'WITH t AS (SELECT 1 AS x) SELECT * FROM t',
    'select date(started_at) d, sum(1) from events group by d',
  ]) {
    assert.equal(checkSqlQuery(sql).ok, true, `должен быть принят: ${sql}`);
  }
});

test('sql_query: изменения и служебные команды не проходят', () => {
  for (const sql of [
    "UPDATE events SET note='x'",
    'DELETE FROM events',
    'DROP TABLE events',
    'PRAGMA table_info(events)',
    "SELECT 1; DROP TABLE events",
    "SELECT 1 -- ;\nDROP TABLE events",
  ]) {
    assert.equal(checkSqlQuery(sql).ok, false, `должен быть отклонён: ${sql}`);
  }
});

test('sql_query: точка с запятой в литерале не считается разделителем', () => {
  assert.equal(checkSqlQuery("SELECT * FROM events WHERE note = 'a;b'").ok, true);
});
