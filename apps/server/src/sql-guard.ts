/**
 * Рамки произвольного SQL от модели (§9.3).
 *
 * Это второй по важности файл в проекте после триггеров БД: его обход означает
 * потерю данных заказчика. Поэтому здесь НЕТ проверок по подстрокам — только
 * полноценная токенизация в стиле SQLite. Разница принципиальная:
 *
 *   UPDATE events SET note = 'не надо delete'       -- валидно, слово внутри литерала
 *   UPDATE events SET note='x' -- ;\nDROP TABLE     -- отказ: DROP это токен, а не текст
 *   UPDATE events SET note='a;b'                    -- валидно, ';' внутри литерала
 *   UPDATE events SET note='it''s'                  -- валидно, экранированная кавычка
 *
 * Тексты ошибок обязаны подсказывать, что делать вместо, иначе модель зациклится
 * на неверном запросе.
 */

export type SqlTokenType = 'word' | 'string' | 'ident' | 'number' | 'blob' | 'param' | 'punct';

export interface SqlToken {
  type: SqlTokenType;
  /** Исходный текст токена. */
  raw: string;
  /** Для word/ident — значение в верхнем регистре (для сравнения с ключевыми словами). */
  upper: string;
  start: number;
  end: number;
}

export interface TokenizeResult {
  tokens: SqlToken[];
  error?: string;
}

const WORD_START = /[A-Za-z_\u0080-\uFFFF]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const DIGIT = /[0-9]/;

/**
 * Разбор на токены. Комментарии и пробелы отбрасываются, но строковые литералы
 * и закавыченные идентификаторы сохраняются целиком — именно на этом держится
 * защита от «ключевого слова внутри строки».
 */
export function tokenizeSql(sql: string): TokenizeResult {
  const tokens: SqlToken[] = [];
  const n = sql.length;
  let i = 0;

  const push = (type: SqlTokenType, start: number, end: number): void => {
    const raw = sql.slice(start, end);
    tokens.push({ type, raw, upper: raw.toUpperCase(), start, end });
  };

  while (i < n) {
    const ch = sql[i] as string;

    // пробелы
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }

    // однострочный комментарий: до конца строки
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }

    // блочный комментарий
    if (ch === '/' && sql[i + 1] === '*') {
      const closed = sql.indexOf('*/', i + 2);
      if (closed === -1) return { tokens, error: 'незакрытый комментарий /* ... */' };
      i = closed + 2;
      continue;
    }

    // строковый литерал; '' внутри — экранированная кавычка
    if (ch === "'") {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { tokens, error: 'незакрытый строковый литерал' };
      push('string', start, i);
      continue;
    }

    // blob-литерал x'..'
    if ((ch === 'x' || ch === 'X') && sql[i + 1] === "'") {
      const start = i;
      i += 2;
      const closed = sql.indexOf("'", i);
      if (closed === -1) return { tokens, error: 'незакрытый blob-литерал' };
      i = closed + 1;
      push('blob', start, i);
      continue;
    }

    // закавыченные идентификаторы: "x", `x`, [x]
    if (ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { tokens, error: 'незакрытый идентификатор в кавычках' };
      push('ident', start, i);
      continue;
    }
    if (ch === '[') {
      const start = i;
      const closed = sql.indexOf(']', i + 1);
      if (closed === -1) return { tokens, error: 'незакрытый идентификатор в скобках' };
      i = closed + 1;
      push('ident', start, i);
      continue;
    }

    // числа
    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(sql[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9A-Fa-fxX.]/.test(sql[i] as string)) i++;
      if ((sql[i] === 'e' || sql[i] === 'E') && /[0-9+-]/.test(sql[i + 1] ?? '')) {
        i += 2;
        while (i < n && DIGIT.test(sql[i] as string)) i++;
      }
      push('number', start, i);
      continue;
    }

    // параметры
    if (ch === '?' || ch === ':' || ch === '@' || ch === '$') {
      const start = i;
      i++;
      while (i < n && WORD_CHAR.test(sql[i] as string)) i++;
      push('param', start, i);
      continue;
    }

    // слова и идентификаторы
    if (WORD_START.test(ch)) {
      const start = i;
      while (i < n && WORD_CHAR.test(sql[i] as string)) i++;
      push('word', start, i);
      continue;
    }

    // всё прочее — односимвольная пунктуация
    push('punct', i, i + 1);
    i++;
  }

  return { tokens };
}

/** Значение закавыченного идентификатора без кавычек. */
function identValue(token: SqlToken): string {
  if (token.type !== 'ident') return token.raw;
  const q = token.raw[0];
  const body = token.raw.slice(1, -1);
  if (q === '"') return body.replace(/""/g, '"');
  if (q === '`') return body.replace(/``/g, '`');
  return body; // [x]
}

function nameOf(token: SqlToken): string {
  return (token.type === 'ident' ? identValue(token) : token.raw).toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Списки запрещённого                                                 */
/* ------------------------------------------------------------------ */

interface Forbidden {
  hint: string;
}

const FORBIDDEN: Record<string, Forbidden> = {
  DELETE: {
    hint:
      'физическое удаление запрещено на уровне БД (триггер events_no_hard_delete). ' +
      "Используй UPDATE events SET deleted_at = '<время ISO UTC>', updated_at = '<время ISO UTC>' WHERE ...",
  },
  DROP: { hint: 'менять схему нельзя. Данные правятся только INSERT/UPDATE по таблице events' },
  ALTER: { hint: 'менять схему нельзя. Данные правятся только INSERT/UPDATE по таблице events' },
  CREATE: { hint: 'менять схему нельзя. Данные правятся только INSERT/UPDATE по таблице events' },
  TRUNCATE: { hint: 'такой команды нет; массовое удаление — UPDATE events SET deleted_at = ...' },
  VACUUM: { hint: 'служебные команды недоступны; снимки базы сервер делает сам' },
  ATTACH: { hint: 'работа возможна только с основной базой' },
  DETACH: { hint: 'работа возможна только с основной базой' },
  PRAGMA: { hint: 'служебные команды недоступны' },
  REINDEX: { hint: 'служебные команды недоступны' },
  ANALYZE: { hint: 'служебные команды недоступны' },
  BEGIN: { hint: 'транзакцией управляет сервер, открывать её не нужно' },
  COMMIT: { hint: 'транзакцией управляет сервер' },
  ROLLBACK: { hint: 'транзакцией управляет сервер' },
  SAVEPOINT: { hint: 'транзакцией управляет сервер' },
  RELEASE: { hint: 'транзакцией управляет сервер' },
};

/**
 * Колонки таблицы events, которые модель вправе менять.
 *
 * ЭТО СПИСОК РАЗРЕШЁННОГО, А НЕ ЗАПРЕЩЁННОГО, и так сделано после реального
 * инцидента. Раньше здесь был перечень запрещённых колонок, и он не знал про
 * `oid`: в SQLite `rowid`, `oid` и `_rowid_` — три имени ОДНОГО И ТОГО ЖЕ поля,
 * поэтому «UPDATE events SET oid = 500» проходил валидатор и менял
 * идентификатор события. Журнал принимал это за появление новой строки,
 * писал before_json = NULL, и правка становилась НЕОБРАТИМОЙ — ровно то,
 * чего по §9 существовать не должно.
 *
 * Со списком разрешённого любое имя, которого мы не предусмотрели — включая
 * будущие псевдонимы и колонки, добавленные миграцией, — отвергается по
 * умолчанию. Безопасность перестаёт зависеть от полноты перечня угроз.
 */
const UPDATABLE_COLUMNS = new Set([
  'child_id',
  'type',
  'subtype',
  'started_at',
  'ended_at',
  'value_num',
  'value_unit',
  'note',
  'source',
  'confidence',
  'updated_at',
  'deleted_at',
]);

/** При вставке своей строки можно ещё created_at и привязку к фразе. */
const INSERTABLE_COLUMNS = new Set([
  ...UPDATABLE_COLUMNS,
  'created_at',
  'utterance_id',
]);

/** Все имена идентификатора строки в SQLite — это одно и то же поле. */
const ROWID_ALIASES = new Set(['id', 'rowid', 'oid', '_rowid_']);

/** Понятное объяснение для колонок, про которые модель точно спросит «почему». */
function explainForbiddenColumn(column: string, forInsert: boolean): string {
  if (ROWID_ALIASES.has(column)) {
    return (
      `колонку «${column}» задавать нельзя: в SQLite id, rowid, oid и _rowid_ — ` +
      'это одно и то же поле, идентификатор строки. Он неизменяем, иначе правку ' +
      'невозможно откатить. Новая строка получает id автоматически'
    );
  }
  if (column === 'created_at') {
    return 'колонку «created_at» менять нельзя: id и created_at неизменяемы, это история записи';
  }
  if (column === 'utterance_id') {
    return (
      'колонку «utterance_id» менять нельзя: она связывает событие с исходной фразой, ' +
      'перепривязывать чужую запись нельзя'
    );
  }
  const allowed = [...(forInsert ? INSERTABLE_COLUMNS : UPDATABLE_COLUMNS)].sort().join(', ');
  return `колонки «${column}» в таблице events нет. Доступны: ${allowed}`;
}

/**
 * Сверяет список колонок со списком разрешённого.
 * Возвращает текст ошибки либо null, если всё в порядке.
 */
function checkColumns(columns: readonly string[], forInsert: boolean): string | null {
  const allowed = forInsert ? INSERTABLE_COLUMNS : UPDATABLE_COLUMNS;
  for (const column of columns) {
    if (!allowed.has(column)) return explainForbiddenColumn(column, forInsert);
  }
  return null;
}

const TABLE_INTRO = new Set(['INTO', 'FROM', 'JOIN', 'UPDATE']);
const SET_CLAUSE_END = new Set(['WHERE', 'FROM', 'RETURNING']);

/** Глубина вложенности скобок для каждого токена. */
function depthsOf(tokens: SqlToken[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === 'punct' && t.raw === '(') {
      depths.push(depth);
      depth++;
      continue;
    }
    if (t.type === 'punct' && t.raw === ')') {
      depth--;
      depths.push(depth);
      continue;
    }
    depths.push(depth);
  }
  return depths;
}

/**
 * Колонки, которым присваиваются значения в SET-клаузе, начиная с `setIdx`.
 * Используется и для UPDATE, и для ветки upsert `ON CONFLICT ... DO UPDATE SET`:
 * проверять надо каждую такую клаузу, а не только список колонок INSERT.
 */
function collectSetColumns(tokens: SqlToken[], depths: number[], setIdx: number): string[] {
  let endIdx = tokens.length;
  for (let k = setIdx + 1; k < tokens.length; k++) {
    const t = tokens[k] as SqlToken;
    if (depths[k] === 0 && t.type === 'word' && SET_CLAUSE_END.has(t.upper)) {
      endIdx = k;
      break;
    }
    if (depths[k] === 0 && t.type === 'punct' && t.raw === ';') {
      endIdx = k;
      break;
    }
  }

  const columns: string[] = [];
  let expectColumn = true;
  for (let k = setIdx + 1; k < endIdx; k++) {
    const t = tokens[k] as SqlToken;
    // форма SET (a, b) = (...)
    if (depths[k] === 1 && expectColumn && (t.type === 'word' || t.type === 'ident')) {
      columns.push(nameOf(t));
      continue;
    }
    if (depths[k] !== 0) continue;
    if (t.type === 'punct' && t.raw === ',') {
      expectColumn = true;
      continue;
    }
    if (expectColumn && (t.type === 'word' || t.type === 'ident')) {
      columns.push(nameOf(t));
      expectColumn = false;
    }
  }
  return columns;
}

/** Все SET-клаузы запроса: основная и upsert-ветка. */
function allSetColumns(tokens: SqlToken[], depths: number[]): string[] {
  const columns: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (depths[i] === 0 && t?.type === 'word' && t.upper === 'SET') {
      columns.push(...collectSetColumns(tokens, depths, i));
    }
  }
  return columns;
}

export type SqlCheck<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(message: string): SqlCheck<never> {
  return { ok: false, error: message };
}

/**
 * Один ли это statement. `;` внутри литерала или комментария сюда не попадает —
 * его съел токенизатор.
 */
function checkSingleStatement(tokens: SqlToken[]): string | null {
  const idx = tokens.findIndex((t) => t.type === 'punct' && t.raw === ';');
  if (idx === -1) return null;
  const rest = tokens.slice(idx + 1);
  if (rest.length === 0) return null;
  return (
    `после первого «;» есть ещё команда («${rest[0]?.raw}»), а разрешён ровно один statement. ` +
    'Выполни изменения по одному вызову на команду'
  );
}

function checkForbiddenWords(tokens: SqlToken[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.type !== 'word') continue;

    // REPLACE как функция replace(a,b,c) — законна; запрещён только REPLACE INTO / OR REPLACE
    if (t.upper === 'REPLACE') {
      const next = tokens[i + 1];
      if (next && next.type === 'punct' && next.raw === '(') continue;
      return (
        'REPLACE INTO и INSERT OR REPLACE запрещены: они молча затирают строку мимо журнала. ' +
        'Используй отдельные INSERT и UPDATE'
      );
    }

    const forbidden = FORBIDDEN[t.upper];
    if (forbidden) return `команда ${t.upper} запрещена — ${forbidden.hint}`;
  }
  return null;
}

/** Все таблицы, к которым обращается запрос (после INTO/FROM/JOIN/UPDATE). */
function collectTables(tokens: SqlToken[]): string[] {
  const tables: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.type !== 'word' || !TABLE_INTRO.has(t.upper)) continue;

    let j = i + 1;
    // UPDATE OR IGNORE events / INSERT OR ABORT INTO events
    while (tokens[j]?.type === 'word' && tokens[j]?.upper === 'OR') j += 2;

    const next = tokens[j];
    if (!next) continue;
    // подзапрос: FROM (SELECT ...)
    if (next.type === 'punct' && next.raw === '(') continue;
    // upsert: ON CONFLICT DO UPDATE SET ...
    if (t.upper === 'UPDATE' && next.type === 'word' && next.upper === 'SET') continue;
    if (next.type !== 'word' && next.type !== 'ident') continue;

    // схема.таблица
    const dot = tokens[j + 1];
    if (dot?.type === 'punct' && dot.raw === '.' && tokens[j + 2]) {
      const schema = nameOf(next);
      const table = nameOf(tokens[j + 2] as SqlToken);
      tables.push(schema === 'main' ? table : `${schema}.${table}`);
    } else {
      tables.push(nameOf(next));
    }
  }

  return tables;
}

export interface SqlExecutePlan {
  kind: 'insert' | 'update';
  /** Текст условия WHERE без самого слова (для снимка «до»); null — условия нет. */
  where: string | null;
}

/**
 * Проверка INSERT/UPDATE по таблице events (§9.3).
 * При успехе отдаёт разобранный план, по которому воркер снимет снимок строк «до».
 */
export function checkSqlExecute(sqlRaw: string): SqlCheck<SqlExecutePlan> {
  const sql = typeof sqlRaw === 'string' ? sqlRaw : '';
  if (sql.trim().length === 0) return fail('пустой запрос');

  const { tokens, error } = tokenizeSql(sql);
  if (error) return fail(`${error}. Проверь кавычки и комментарии`);
  if (tokens.length === 0) return fail('запрос состоит только из комментариев');

  const multi = checkSingleStatement(tokens);
  if (multi) return fail(multi);

  const forbidden = checkForbiddenWords(tokens);
  if (forbidden) return fail(forbidden);

  const first = tokens[0] as SqlToken;
  if (first.type !== 'word') {
    return fail('запрос должен начинаться с INSERT INTO events или UPDATE events');
  }
  if (first.upper === 'WITH') {
    return fail('CTE (WITH ...) не поддерживается — перенеси подзапрос прямо в WHERE или VALUES');
  }
  if (first.upper !== 'INSERT' && first.upper !== 'UPDATE') {
    return fail(
      `через sql_execute доступны только INSERT и UPDATE, а запрос начинается с ${first.upper}. ` +
        'Для чтения есть отдельный инструмент sql_query',
    );
  }

  // все таблицы — только events
  const tables = collectTables(tokens);
  const alien = tables.find((t) => t !== 'events');
  if (alien !== undefined) {
    return fail(
      `обращение к таблице «${alien}» запрещено: sql_execute работает только с таблицей events. ` +
        'Читать другие таблицы можно через sql_query',
    );
  }
  if (tables.length === 0) {
    return fail('не удалось определить таблицу. Ожидается INSERT INTO events ... или UPDATE events ...');
  }

  return first.upper === 'INSERT' ? checkInsert(sql, tokens) : checkUpdate(sql, tokens);
}

function checkInsert(_sql: string, tokens: SqlToken[]): SqlCheck<SqlExecutePlan> {
  const intoIdx = tokens.findIndex((t) => t.type === 'word' && t.upper === 'INTO');
  if (intoIdx === -1) return fail('ожидается INSERT INTO events (...)');

  // events | main.events, затем, возможно, список колонок
  let j = intoIdx + 1;
  if (tokens[j + 1]?.raw === '.') j += 2;
  j += 1;

  const open = tokens[j];
  if (!open || open.type !== 'punct' || open.raw !== '(') {
    return fail(
      'перечисли колонки явно: INSERT INTO events (type, started_at, source, created_at, updated_at) VALUES (...). ' +
        'Без списка колонок значение попадёт в идентификатор строки',
    );
  }

  const columns: string[] = [];
  let depth = 0;
  for (let k = j; k < tokens.length; k++) {
    const t = tokens[k] as SqlToken;
    if (t.type === 'punct' && t.raw === '(') {
      depth++;
      continue;
    }
    if (t.type === 'punct' && t.raw === ')') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && (t.type === 'word' || t.type === 'ident')) columns.push(nameOf(t));
  }

  const badColumn = checkColumns(columns, true);
  if (badColumn) return fail(badColumn);

  // Ветка upsert: «ON CONFLICT (...) DO UPDATE SET ...» — это настоящий UPDATE,
  // и защищённые колонки в ней должны проверяться так же строго.
  const depths = depthsOf(tokens);
  const upsertColumns = allSetColumns(tokens, depths);
  const badUpsert = checkColumns(upsertColumns, false);
  if (badUpsert) return fail(badUpsert);

  return { ok: true, value: { kind: 'insert', where: null } };
}

function checkUpdate(sql: string, tokens: SqlToken[]): SqlCheck<SqlExecutePlan> {
  const depths = depthsOf(tokens);

  const setIdx = tokens.findIndex(
    (t, i) => depths[i] === 0 && t.type === 'word' && t.upper === 'SET',
  );
  if (setIdx === -1) return fail('ожидается UPDATE events SET колонка = значение ...');

  // Проверяем ВСЕ SET-клаузы запроса, а не только первую.
  const columns = allSetColumns(tokens, depths);
  if (columns.length === 0) return fail('в SET не найдено ни одной колонки');

  const badColumn = checkColumns(columns, false);
  if (badColumn) return fail(badColumn);

  // WHERE верхнего уровня -> текст условия для снимка «до»
  const whereIdx = tokens.findIndex(
    (t, i) => depths[i] === 0 && t.type === 'word' && t.upper === 'WHERE',
  );

  let where: string | null = null;
  if (whereIdx !== -1) {
    let stop = sql.length;
    for (let k = whereIdx + 1; k < tokens.length; k++) {
      const t = tokens[k] as SqlToken;
      if (depths[k] === 0 && t.type === 'word' && t.upper === 'RETURNING') {
        stop = t.start;
        break;
      }
      if (depths[k] === 0 && t.type === 'punct' && t.raw === ';') {
        stop = t.start;
        break;
      }
    }
    where = sql.slice((tokens[whereIdx] as SqlToken).end, stop).trim();
    if (where.length === 0) where = null;
  }

  return { ok: true, value: { kind: 'update', where } };
}

/**
 * Проверка произвольного SELECT (§9.3): читать можно любые таблицы,
 * но строго один statement и без служебных команд.
 */
export function checkSqlQuery(sqlRaw: string): SqlCheck<{ kind: 'select' }> {
  const sql = typeof sqlRaw === 'string' ? sqlRaw : '';
  if (sql.trim().length === 0) return fail('пустой запрос');

  const { tokens, error } = tokenizeSql(sql);
  if (error) return fail(`${error}. Проверь кавычки и комментарии`);
  if (tokens.length === 0) return fail('запрос состоит только из комментариев');

  const multi = checkSingleStatement(tokens);
  if (multi) return fail(multi);

  const forbidden = checkForbiddenWords(tokens);
  if (forbidden) return fail(forbidden);

  const first = tokens[0] as SqlToken;
  if (first.type !== 'word' || !['SELECT', 'WITH', 'VALUES'].includes(first.upper)) {
    return fail(
      'sql_query выполняет только SELECT (допустимы WITH ... SELECT и VALUES). ' +
        'Для изменения данных есть sql_execute',
    );
  }

  // INSERT/UPDATE внутри CTE SQLite не поддерживает, но проверим явно
  for (const t of tokens) {
    if (t.type === 'word' && (t.upper === 'INSERT' || t.upper === 'UPDATE')) {
      return fail('sql_query только читает. Изменения — через sql_execute');
    }
  }

  return { ok: true, value: { kind: 'select' } };
}
