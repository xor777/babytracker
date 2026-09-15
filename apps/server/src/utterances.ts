/**
 * Очередь сырых фраз. Пишется в горячем пути вебхука, читается воркером.
 * Все операции синхронные и дешёвые — иначе не уложиться в бюджет 200 мс.
 */

import type { Db } from './db.ts';
import { all, get, run, count, p, UTTERANCE_COLUMNS } from './db.ts';
import type { UtteranceDto, UtteranceRow, UtteranceStatus } from './types.ts';
import { nowIso } from './time.ts';

export const UTTERANCES_LIMIT_DEFAULT = 20;
export const UTTERANCES_LIMIT_MAX = 200;
export const MAX_ATTEMPTS = 3;

export interface InsertUtteranceInput {
  rawText: string;
  aliceUserId?: string | null;
  sessionId?: string | null;
  fastResult?: unknown;
  status?: UtteranceStatus;
  /**
   * Пояснение для ленты распознавания. Используется не только для настоящих
   * ошибок, но и чтобы объяснить, почему фраза НЕ пошла модели (§9.4).
   */
  llmError?: string | null;
}

export function insertUtterance(db: Db, input: InsertUtteranceInput): UtteranceRow {
  const res = run(
    db,
    `INSERT INTO utterances
       (raw_text, alice_user_id, session_id, received_at, status, fast_result, llm_error, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p(input.rawText),
      p(input.aliceUserId),
      p(input.sessionId),
      p(nowIso()),
      p(input.status ?? 'pending'),
      p(input.fastResult === undefined ? null : JSON.stringify(input.fastResult)),
      p(input.llmError),
      p(input.status !== undefined && input.status !== 'pending' ? nowIso() : null),
    ],
  );
  const row = getUtterance(db, res.lastInsertRowid);
  if (!row) throw new Error('Не удалось прочитать только что вставленную фразу');
  return row;
}

export function getUtterance(db: Db, id: number): UtteranceRow | undefined {
  return get<UtteranceRow>(db, `SELECT ${UTTERANCE_COLUMNS} FROM utterances WHERE id = ?`, [id]);
}

export function listUtterances(db: Db, limit: number = UTTERANCES_LIMIT_DEFAULT): UtteranceRow[] {
  const n = Math.min(Math.max(1, Math.trunc(limit)), UTTERANCES_LIMIT_MAX);
  return all<UtteranceRow>(
    db,
    `SELECT ${UTTERANCE_COLUMNS} FROM utterances ORDER BY received_at DESC, id DESC LIMIT ?`,
    [n],
  );
}

/**
 * Берёт одну фразу в работу: pending + attempts < MAX -> processing, attempts += 1.
 * Конкурентность воркера = 1, но UPDATE ... WHERE status='pending' всё равно
 * пишем атомарно — на случай второго процесса поверх того же файла БД.
 */
export function claimNextPending(db: Db): UtteranceRow | null {
  const candidate = get<UtteranceRow>(
    db,
    `SELECT ${UTTERANCE_COLUMNS} FROM utterances
      WHERE status = 'pending' AND attempts < ?
      ORDER BY received_at ASC, id ASC LIMIT 1`,
    [MAX_ATTEMPTS],
  );
  if (!candidate) return null;

  const res = run(
    db,
    `UPDATE utterances SET status = 'processing', attempts = attempts + 1
      WHERE id = ? AND status = 'pending'`,
    [candidate.id],
  );
  if (res.changes === 0) return null;

  return getUtterance(db, candidate.id) ?? null;
}

export interface FinishUtteranceInput {
  status: UtteranceStatus;
  llmResult?: unknown;
  llmError?: string | null;
}

export function finishUtterance(
  db: Db,
  id: number,
  input: FinishUtteranceInput,
): UtteranceRow | undefined {
  run(
    db,
    `UPDATE utterances SET status = ?, llm_result = ?, llm_error = ?, processed_at = ?
      WHERE id = ?`,
    [
      p(input.status),
      p(input.llmResult === undefined ? null : JSON.stringify(input.llmResult)),
      p(input.llmError ?? null),
      p(nowIso()),
      p(id),
    ],
  );
  return getUtterance(db, id);
}

/**
 * Возврат в очередь без расхода попытки (§9.4): лимит подписки — это «позже»,
 * а не «не смогли». Три исчерпанных окна подряд не должны хоронить фразу.
 */
export function releaseUtterance(db: Db, id: number, note: string): UtteranceRow | undefined {
  run(
    db,
    `UPDATE utterances
        SET status = 'pending',
            attempts = MAX(0, attempts - 1),
            llm_error = ?
      WHERE id = ?`,
    [p(note.slice(0, 2000)), p(id)],
  );
  return getUtterance(db, id);
}

/**
 * Повторный разбор фразы по требованию человека («разобрать заново» в админке).
 *
 * Возвращает фразу в очередь НЕЗАВИСИМО от политики и от того, чем закончился
 * прошлый разбор: именно так чинится уже случившаяся потеря факта — иначе
 * пропущенное не вернуть, кроме как повторить вслух. Счётчик попыток
 * обнуляется (человек просит заново, а не система повторяет), а reparse_count
 * растёт — по нему модель понимает, что события по этой фразе уже могли быть
 * созданы, и не плодит дубли.
 */
export function reparseUtterance(db: Db, id: number): UtteranceRow | null {
  const existing = getUtterance(db, id);
  if (!existing) return null;

  run(
    db,
    `UPDATE utterances
        SET status = 'pending',
            attempts = 0,
            llm_error = NULL,
            processed_at = NULL,
            reparse_count = reparse_count + 1
      WHERE id = ?`,
    [p(id)],
  );
  return getUtterance(db, id) ?? null;
}

/** Возврат в очередь для повторной попытки. */
export function requeueUtterance(db: Db, id: number, error: string): UtteranceRow | undefined {
  run(db, `UPDATE utterances SET status = 'pending', llm_error = ? WHERE id = ?`, [
    p(error.slice(0, 2000)),
    p(id),
  ]);
  return getUtterance(db, id);
}

/**
 * Восстановление после падения: зависшие в processing возвращаем в очередь.
 * Вызывается один раз при старте воркера.
 */
export function resetStaleProcessing(db: Db): number {
  const res = run(
    db,
    `UPDATE utterances SET status = 'pending'
      WHERE status = 'processing' AND attempts < ?`,
    [MAX_ATTEMPTS],
  );
  const failed = run(
    db,
    `UPDATE utterances SET status = 'failed', llm_error = COALESCE(llm_error, 'прервано перезапуском сервера')
      WHERE status = 'processing' AND attempts >= ?`,
    [MAX_ATTEMPTS],
  );
  return res.changes + failed.changes;
}

export function queueDepth(db: Db): number {
  return count(db, `SELECT COUNT(*) AS n FROM utterances WHERE status = 'pending'`);
}

/**
 * Когда пришла самая старая фраза, ждущая разбора. null — очередь пуста.
 *
 * Отвечает на вопрос, на который глубина очереди не отвечает: очередь движется
 * или стоит? Две фразы, ждущие минуту, — это работа; две, ждущие с ночи, — это
 * простой, о котором никто не узнал.
 */
export function oldestPendingAt(db: Db): string | null {
  const row = get<{ received_at: string }>(
    db,
    `SELECT received_at FROM utterances
      WHERE status = 'pending' ORDER BY received_at ASC, id ASC LIMIT 1`,
  );
  return row?.received_at ?? null;
}

/** Статусы, из которых фразу имеет смысл возвращать в разбор пачкой. */
export const REQUEUABLE_STATUSES: readonly UtteranceStatus[] = ['failed', 'skipped'];

export interface RequeueManyInput {
  /** Конкретные id. Взаимоисключимо со `statuses` по смыслу, но можно оба. */
  ids?: number[];
  /** Вернуть все фразы в этих статусах (`failed` / `skipped`). */
  statuses?: string[];
  /** Не трогать фразы старше этого момента (ISO) — «разобрать за сегодня». */
  since?: string | null;
  /** Предохранитель от «вернуть в очередь весь дневник за полгода». */
  limit?: number;
}

export const REQUEUE_MANY_LIMIT_DEFAULT = 50;
export const REQUEUE_MANY_LIMIT_MAX = 500;

/**
 * Массовый возврат фраз в разбор (§9.4).
 *
 * Зачем сверх `reparse` по одному id: терминальный статус — это всегда либо
 * ошибка разбора, либо решение прошлой политики, и оба случая приходят пачками
 * (CLI падал час; политику переключили на `all`, а вчерашние фразы остались
 * погашенными старой). Возвращать такое по одной кнопке на фразу — работа,
 * которую человек просто не сделает, а значит дневник останется дырявым.
 *
 * Механика ровно та же, что у `reparseUtterance`: попытки обнуляются,
 * `reparse_count` растёт (по нему модель понимает, что события по фразе уже
 * могли быть созданы, и не плодит дубли). Порядок разбора — хронологический,
 * его обеспечивает `claimNextPending`.
 */
export function requeueMany(db: Db, input: RequeueManyInput): UtteranceRow[] {
  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit ?? REQUEUE_MANY_LIMIT_DEFAULT)),
    REQUEUE_MANY_LIMIT_MAX,
  );

  const where: string[] = [];
  const params: unknown[] = [];

  const ids = (input.ids ?? []).filter((id) => Number.isInteger(id) && id > 0);
  // Неизвестный статус молча игнорируем, а не расширяем им отбор.
  const statuses = (input.statuses ?? []).filter((s) =>
    (REQUEUABLE_STATUSES as readonly string[]).includes(s),
  );

  if (ids.length > 0 && statuses.length > 0) {
    where.push(
      `(id IN (${ids.map(() => '?').join(',')}) OR status IN (${statuses.map(() => '?').join(',')}))`,
    );
    params.push(...ids, ...statuses);
  } else if (ids.length > 0) {
    where.push(`id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  } else if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  } else {
    // Пустой отбор — это «верни всё»; молча делать такое нельзя.
    return [];
  }

  // Фразу, которая уже ждёт или разбирается прямо сейчас, трогать незачем:
  // сброс её attempts посреди работы воркера — гонка на ровном месте.
  where.push(`status NOT IN ('pending', 'processing')`);

  if (input.since) {
    where.push(`received_at >= ?`);
    params.push(input.since);
  }

  const candidates = all<UtteranceRow>(
    db,
    `SELECT ${UTTERANCE_COLUMNS} FROM utterances
      WHERE ${where.join(' AND ')}
      ORDER BY received_at ASC, id ASC
      LIMIT ?`,
    [...params.map((v) => p(v)), p(limit)],
  );

  const result: UtteranceRow[] = [];
  for (const row of candidates) {
    const updated = reparseUtterance(db, row.id);
    if (updated) result.push(updated);
  }
  return result;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    // не теряем данные, если в колонке оказался не-JSON
    return value;
  }
}

/**
 * Представление для API/SSE. `fast_result`/`llm_result` отдаём распарсенными
 * объектами — потребителю не надо делать JSON.parse поля JSON-ответа.
 */
export function toUtteranceDto(row: UtteranceRow): UtteranceDto {
  return {
    id: row.id,
    raw_text: row.raw_text,
    status: row.status,
    received_at: row.received_at,
    processed_at: row.processed_at,
    attempts: row.attempts,
    llm_error: row.llm_error,
    fast_result: parseJson(row.fast_result),
    llm_result: parseJson(row.llm_result),
    reparse_count: Number(row.reparse_count ?? 0),
  };
}
