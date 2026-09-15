/**
 * Доменная логика событий.
 *
 * Здесь живёт инвариант из §1 контракта: в каждый момент времени существует
 * не более одного события `type='sleep' AND ended_at IS NULL AND deleted_at IS NULL`.
 * Все записи в events идут через функции этого модуля — иначе инвариант не удержать.
 */

import type { Db, SqlParam } from './db.ts';
import { all, get, run, count, p, EVENT_COLUMNS, getEventById } from './db.ts';
import type { JournalContext } from './journal.ts';
import { journaledChange } from './journal.ts';
import type { Config } from './config.ts';
import { normsForAge, type AgeNorms } from './taxonomy.ts';
// Маркер допущения — общий контракт для записей матчера и модели: по нему
// одинаково видно «в этой записи есть то, чего родитель не говорил».
import { ASSUMPTION_MARK } from './prompt.ts';
import type { DailySleepDto, EventRow, EventSource, StateDto } from './types.ts';
import {
  localDateISO,
  localDayStartMs,
  shiftLocalDate,
  daysBetween,
  nowIso,
  toIsoUtc,
  zonedParts,
} from './time.ts';

export const DEFAULT_CHILD_ID = 'andrey';

// Таксономия живёт в одном месте — см. taxonomy.ts (§10.2)
export { EVENT_TYPES } from './taxonomy.ts';

/* ------------------------------------------------------------------ */
/* Вставка / изменение                                                 */
/* ------------------------------------------------------------------ */

export interface EventInput {
  type: string;
  subtype?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  value_num?: number | null;
  value_unit?: string | null;
  note?: string | null;
  source: EventSource;
  utterance_id?: number | null;
  confidence?: number | null;
  child_id?: string | null;
}

export type OpenSleepPolicy = 'reject' | 'close-previous';

export interface InsertEventResult {
  event: EventRow;
  /** Кого пришлось закрыть ради инварианта одного открытого сна. */
  closedPrevious: EventRow | null;
}

export class OpenSleepConflictError extends Error {
  readonly existing: EventRow;

  constructor(existing: EventRow) {
    super(`Уже есть открытый сон id=${existing.id} (начат ${existing.started_at})`);
    this.name = 'OpenSleepConflictError';
    this.existing = existing;
  }
}

/** Единственный открытый сон, если он есть. */
export function findOpenSleep(db: Db, childId: string = DEFAULT_CHILD_ID): EventRow | null {
  return (
    get<EventRow>(
      db,
      `SELECT ${EVENT_COLUMNS} FROM events
        WHERE type = 'sleep' AND ended_at IS NULL AND deleted_at IS NULL AND child_id = ?
        ORDER BY started_at DESC LIMIT 1`,
      [childId],
    ) ?? null
  );
}

/**
 * Вставка события с соблюдением инварианта открытого сна.
 * `policy='reject'` — бросает OpenSleepConflictError, `close-previous` — закрывает старый.
 */
export function insertEvent(
  db: Db,
  input: EventInput,
  policy: OpenSleepPolicy = 'close-previous',
  journal?: JournalContext | null,
): InsertEventResult {
  if (journal) {
    // снимок «до» нужен только для сна, который придётся закрыть ради инварианта
    return journaledChange(
      db,
      journal,
      () => {
        if (input.type !== 'sleep' || input.ended_at) return [];
        const open = findOpenSleep(db, input.child_id ?? DEFAULT_CHILD_ID);
        return open ? [open.id] : [];
      },
      () => insertEventRaw(db, input, policy),
    ).result;
  }
  return insertEventRaw(db, input, policy);
}

function insertEventRaw(
  db: Db,
  input: EventInput,
  policy: OpenSleepPolicy,
): InsertEventResult {
  const now = nowIso();
  const childId = input.child_id ?? DEFAULT_CHILD_ID;
  const startedAt = toIsoUtc(input.started_at ?? now) ?? now;
  const endedAt = input.ended_at ? toIsoUtc(input.ended_at) : null;

  if (endedAt !== null && Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new Error('ended_at раньше started_at');
  }

  let closedPrevious: EventRow | null = null;

  if (input.type === 'sleep' && endedAt === null) {
    const open = findOpenSleep(db, childId);
    if (open) {
      if (policy === 'reject') throw new OpenSleepConflictError(open);
      // Закрываем предыдущий сон моментом начала нового — дыр в ленте не остаётся.
      const closeAt = Date.parse(startedAt) >= Date.parse(open.started_at) ? startedAt : open.started_at;
      closedPrevious = closeEvent(db, open.id, closeAt);
    }
  }

  const res = run(
    db,
    `INSERT INTO events
       (child_id, type, subtype, started_at, ended_at, value_num, value_unit, note,
        source, utterance_id, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p(childId),
      p(input.type),
      p(input.subtype),
      p(startedAt),
      p(endedAt),
      p(input.value_num),
      p(input.value_unit),
      p(input.note),
      p(input.source),
      p(input.utterance_id),
      p(input.confidence),
      p(now),
      p(now),
    ],
  );

  const event = getEventById(db, res.lastInsertRowid);
  if (!event) throw new Error('Не удалось прочитать только что вставленное событие');
  return { event, closedPrevious };
}

/** Закрывает событие (проставляет ended_at). */
export function closeEvent(db: Db, id: number, endedAtIso: string): EventRow {
  const now = nowIso();
  run(db, 'UPDATE events SET ended_at = ?, updated_at = ? WHERE id = ?', [
    p(endedAtIso),
    p(now),
    p(id),
  ]);
  const row = getEventById(db, id);
  if (!row) throw new Error(`Событие id=${id} не найдено`);
  return row;
}

export interface EventPatch {
  type?: string;
  subtype?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  value_num?: number | null;
  value_unit?: string | null;
  note?: string | null;
  confidence?: number | null;
  source?: EventSource;
}

const PATCHABLE: ReadonlyArray<keyof EventPatch> = [
  'type',
  'subtype',
  'started_at',
  'ended_at',
  'value_num',
  'value_unit',
  'note',
  'confidence',
  'source',
];

/** Частичное обновление. Возвращает null, если события нет или оно удалено. */
export function updateEvent(
  db: Db,
  id: number,
  patch: EventPatch,
  journal?: JournalContext | null,
): EventRow | null {
  if (journal) {
    return journaledChange(db, journal, () => [id], () => updateEventRaw(db, id, patch)).result;
  }
  return updateEventRaw(db, id, patch);
}

function updateEventRaw(db: Db, id: number, patch: EventPatch): EventRow | null {
  const existing = getEventById(db, id);
  if (!existing || existing.deleted_at !== null) return null;

  const sets: string[] = [];
  const params: SqlParam[] = [];

  for (const key of PATCHABLE) {
    if (!(key in patch)) continue;
    let value = patch[key] as unknown;
    if (value === undefined) continue;
    if ((key === 'started_at' || key === 'ended_at') && typeof value === 'string') {
      const iso = toIsoUtc(value);
      if (iso === null) throw new Error(`${key}: не разбирается как дата — "${value}"`);
      value = iso;
    }
    sets.push(`${key} = ?`);
    params.push(p(value));
  }

  if (sets.length === 0) return existing;

  // Тот же инвариант, что и при вставке. Без него правка из админки могла
  // перевернуть событие во времени, и sleepSegments отбрасывал такой отрезок:
  // полуторачасовой сон МОЛЧА пропадал из /api/state и /api/sleep/daily.
  // Это хуже кривой цифры — данные выглядят целыми, а сна нет.
  const nextStartedAt =
    'started_at' in patch && patch.started_at
      ? (toIsoUtc(patch.started_at) ?? existing.started_at)
      : existing.started_at;
  const nextEndedAt =
    'ended_at' in patch
      ? patch.ended_at
        ? (toIsoUtc(patch.ended_at) ?? existing.ended_at)
        : null
      : existing.ended_at;

  if (nextEndedAt !== null && Date.parse(nextEndedAt) < Date.parse(nextStartedAt)) {
    throw new Error(
      `ended_at (${nextEndedAt}) раньше started_at (${nextStartedAt}): ` +
        'событие нельзя перевернуть во времени — такой отрезок выпал бы из статистики сна',
    );
  }

  sets.push('updated_at = ?');
  params.push(p(nowIso()));
  params.push(p(id));

  run(db, `UPDATE events SET ${sets.join(', ')} WHERE id = ?`, params);
  return getEventById(db, id) ?? null;
}

/** Мягкое удаление (§1: все выборки фильтруют deleted_at IS NULL). */
export function softDeleteEvent(
  db: Db,
  id: number,
  journal?: JournalContext | null,
): EventRow | null {
  if (journal) {
    return journaledChange(db, journal, () => [id], () => softDeleteEventRaw(db, id)).result;
  }
  return softDeleteEventRaw(db, id);
}

function softDeleteEventRaw(db: Db, id: number): EventRow | null {
  const existing = getEventById(db, id);
  if (!existing || existing.deleted_at !== null) return null;
  const now = nowIso();
  run(db, 'UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ?', [
    p(now),
    p(now),
    p(id),
  ]);
  return getEventById(db, id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Сон: открыть / закрыть                                              */
/* ------------------------------------------------------------------ */

/** Ночной сон или дневной — по локальному времени начала (19:00..06:00 = ночь). */
export function sleepSubtype(startedAtIso: string, tz: string): 'night' | 'nap' {
  const hour = zonedParts(new Date(startedAtIso), tz).hour;
  return hour >= 19 || hour < 6 ? 'night' : 'nap';
}

export interface SleepActionOptions {
  at?: string;
  utteranceId?: number | null;
  source?: EventSource;
  confidence?: number | null;
  childId?: string;
  /** Если задан — изменение попадёт в журнал и станет обратимым (§9). */
  journal?: JournalContext | null;
}

export type StartSleepResult =
  | { status: 'created'; event: EventRow }
  | { status: 'already_open'; event: EventRow; durationMin: number };

/**
 * Открыть сон. Если сон уже открыт — НЕ создаём второй (инвариант §1),
 * возвращаем существующий: Алисе надо ответить «уже спит, с 17:32».
 */
export function startSleep(db: Db, cfg: Config, options: SleepActionOptions = {}): StartSleepResult {
  const childId = options.childId ?? DEFAULT_CHILD_ID;
  const at = toIsoUtc(options.at ?? nowIso()) ?? nowIso();

  const open = findOpenSleep(db, childId);
  if (open) {
    return {
      status: 'already_open',
      event: open,
      durationMin: minutesSince(open.started_at),
    };
  }

  const { event } = insertEvent(
    db,
    {
      type: 'sleep',
      subtype: sleepSubtype(at, cfg.tz),
      started_at: at,
      ended_at: null,
      source: options.source ?? 'alice-fast',
      utterance_id: options.utteranceId ?? null,
      confidence: options.confidence ?? null,
      child_id: childId,
    },
    'reject',
    options.journal ?? null,
  );

  return { status: 'created', event };
}

export type EndSleepResult =
  | { status: 'closed'; event: EventRow; durationMin: number }
  | { status: 'no_open_sleep'; event: EventRow };

/**
 * Закрыть сон. Если открытого сна нет — не падаем: записываем заметку,
 * чтобы факт пробуждения не потерялся, и отдаём это наверх (§4: «А он и не спал»).
 */
export function endSleep(db: Db, cfg: Config, options: SleepActionOptions = {}): EndSleepResult {
  const childId = options.childId ?? DEFAULT_CHILD_ID;
  const at = toIsoUtc(options.at ?? nowIso()) ?? nowIso();

  const open = findOpenSleep(db, childId);
  if (!open) {
    const { event } = insertEvent(
      db,
      {
        type: 'note',
        subtype: null,
        started_at: at,
        ended_at: at,
        // Пробел в журнале, а не факт: когда он заснул — неизвестно, и выдумывать
        // это время нельзя ни матчеру, ни модели. Маркер делает пробел видимым.
        note: `${ASSUMPTION_MARK} Проснулся, засыпание не было зафиксировано — когда заснул, неизвестно`,
        source: options.source ?? 'alice-fast',
        utterance_id: options.utteranceId ?? null,
        confidence: options.confidence ?? null,
        child_id: childId,
      },
      'close-previous',
      options.journal ?? null,
    );
    return { status: 'no_open_sleep', event };
  }

  // Часы могут разъехаться или пользователь назовёт время раньше начала сна —
  // не даём создать отрицательную длительность.
  const endedAt = Date.parse(at) < Date.parse(open.started_at) ? open.started_at : at;
  const closed = options.journal
    ? (journaledChange(
        db,
        options.journal,
        () => [open.id],
        () => closeEvent(db, open.id, endedAt),
      ).result as EventRow)
    : closeEvent(db, open.id, endedAt);
  return {
    status: 'closed',
    event: closed,
    durationMin: minutesOf(closed.started_at, endedAt),
  };
}

function minutesSince(fromIso: string): number {
  return minutesOf(fromIso, nowIso());
}

function minutesOf(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 60_000));
}

/* ------------------------------------------------------------------ */
/* Выборки                                                             */
/* ------------------------------------------------------------------ */

export interface QueryEventsParams {
  from?: string | null;
  to?: string | null;
  type?: string | null;
  limit?: number | null;
  /** §9.6: показать в том числе мягко удалённое — «а что пропало». */
  includeDeleted?: boolean;
}

export const EVENTS_LIMIT_DEFAULT = 200;
export const EVENTS_LIMIT_MAX = 1000;

/** §10.4: событие вместе с исходной фразой — чтобы видеть, как речь стала записью. */
export interface EventWithUtterance extends EventRow {
  utterance_text: string | null;
}

/**
 * Те же события, но с подтянутым текстом фразы (LEFT JOIN по utterance_id).
 * Нужно ленте истории в админ-дашборде: без исходного текста нельзя поймать
 * ошибку разбора.
 */
export function queryEventsWithUtterance(
  db: Db,
  params: QueryEventsParams = {},
): EventWithUtterance[] {
  const { where, sql } = buildEventsWhere(params);
  // все колонки условия относятся к events — префиксуем, чтобы JOIN не был двусмысленным
  const joinWhere = where.replace(/\b(deleted_at|started_at|type)\b/g, 'e.$1');
  return all<EventWithUtterance>(
    db,
    `SELECT ${EVENT_COLUMNS.split(', ').map((c) => `e.${c}`).join(', ')}, u.raw_text AS utterance_text
       FROM events e
       LEFT JOIN utterances u ON u.id = e.utterance_id
      WHERE ${joinWhere}
      ORDER BY e.started_at DESC, e.id DESC LIMIT ?`,
    sql,
  );
}

interface EventsWhere {
  where: string;
  sql: SqlParam[];
}

function buildEventsWhere(params: QueryEventsParams): EventsWhere {
  const where: string[] = [];
  const sql: SqlParam[] = [];

  if (!params.includeDeleted) where.push('deleted_at IS NULL');
  if (params.from) {
    where.push('started_at >= ?');
    sql.push(p(toIsoUtc(params.from) ?? params.from));
  }
  if (params.to) {
    where.push('started_at <= ?');
    sql.push(p(toIsoUtc(params.to) ?? params.to));
  }
  if (params.type) {
    where.push('type = ?');
    sql.push(p(params.type));
  }

  sql.push(clampLimit(params.limit, EVENTS_LIMIT_DEFAULT, EVENTS_LIMIT_MAX));
  return { where: where.length > 0 ? where.join(' AND ') : '1=1', sql };
}

export function queryEvents(db: Db, params: QueryEventsParams = {}): EventRow[] {
  const where: string[] = [];
  const sql: SqlParam[] = [];

  if (!params.includeDeleted) where.push('deleted_at IS NULL');

  if (params.from) {
    where.push('started_at >= ?');
    sql.push(p(toIsoUtc(params.from) ?? params.from));
  }
  if (params.to) {
    where.push('started_at <= ?');
    sql.push(p(toIsoUtc(params.to) ?? params.to));
  }
  if (params.type) {
    where.push('type = ?');
    sql.push(p(params.type));
  }

  const limit = clampLimit(params.limit, EVENTS_LIMIT_DEFAULT, EVENTS_LIMIT_MAX);
  sql.push(limit);

  return all<EventRow>(
    db,
    `SELECT ${EVENT_COLUMNS} FROM events WHERE ${where.length > 0 ? where.join(' AND ') : '1=1'}
      ORDER BY started_at DESC, id DESC LIMIT ?`,
    sql,
  );
}

export function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

/** Последний завершённый сон. */
export function lastFinishedSleep(db: Db, childId: string = DEFAULT_CHILD_ID): EventRow | null {
  return (
    get<EventRow>(
      db,
      `SELECT ${EVENT_COLUMNS} FROM events
        WHERE type = 'sleep' AND ended_at IS NOT NULL AND deleted_at IS NULL AND child_id = ?
        ORDER BY ended_at DESC LIMIT 1`,
      [childId],
    ) ?? null
  );
}

interface SleepSegment {
  id: number;
  startMs: number;
  endMs: number;
  subtype: string | null;
}

/**
 * Куски сна, пересекающие [fromMs, toMs). Открытый сон считается идущим до `nowMs`.
 * Отрезки обрезаются границами окна — поэтому ночной сон честно делится между сутками.
 */
function sleepSegments(
  db: Db,
  fromMs: number,
  toMs: number,
  nowMs: number,
  childId: string,
): SleepSegment[] {
  const rows = all<EventRow>(
    db,
    `SELECT ${EVENT_COLUMNS} FROM events
      WHERE type = 'sleep' AND deleted_at IS NULL AND child_id = ?
        AND started_at < ?
        AND (ended_at IS NULL OR ended_at > ?)
      ORDER BY started_at ASC`,
    [childId, new Date(toMs).toISOString(), new Date(fromMs).toISOString()],
  );

  const segments: SleepSegment[] = [];
  for (const row of rows) {
    const startMs = Date.parse(row.started_at);
    const rawEnd = row.ended_at === null ? nowMs : Date.parse(row.ended_at);
    if (Number.isNaN(startMs) || Number.isNaN(rawEnd)) continue;
    const endMs = Math.max(startMs, rawEnd);
    const clippedStart = Math.max(startMs, fromMs);
    const clippedEnd = Math.min(endMs, toMs);
    if (clippedEnd <= clippedStart) continue;
    segments.push({ id: row.id, startMs: clippedStart, endMs: clippedEnd, subtype: row.subtype });
  }
  return segments;
}

export interface DaySleepStats {
  totalMin: number;
  sessions: number;
  longestMin: number;
  nightMin: number;
  napMin: number;
}

export function sleepStatsForRange(
  db: Db,
  fromMs: number,
  toMs: number,
  nowMs: number,
  childId: string = DEFAULT_CHILD_ID,
): DaySleepStats {
  const segments = sleepSegments(db, fromMs, toMs, nowMs, childId);
  let totalMin = 0;
  let longestMin = 0;
  let nightMin = 0;
  let napMin = 0;

  for (const seg of segments) {
    const min = Math.round((seg.endMs - seg.startMs) / 60_000);
    totalMin += min;
    if (min > longestMin) longestMin = min;
    if (seg.subtype === 'night') nightMin += min;
    else napMin += min;
  }

  return { totalMin, sessions: segments.length, longestMin, nightMin, napMin };
}

/* ------------------------------------------------------------------ */
/* Состояние и сводки                                                  */
/* ------------------------------------------------------------------ */

export function pendingCount(db: Db): number {
  return count(
    db,
    `SELECT COUNT(*) AS n FROM utterances WHERE status IN ('pending', 'processing')`,
  );
}

/** §3.2 GET /api/state. */
export function getState(db: Db, cfg: Config, now: Date = new Date()): StateDto {
  const nowMs = now.getTime();
  const nowIsoStr = new Date(nowMs).toISOString();
  const todayISO = localDateISO(now, cfg.tz);
  const dayStart = localDayStartMs(todayISO, cfg.tz);
  const dayEnd = localDayStartMs(shiftLocalDate(todayISO, 1), cfg.tz);

  const open = findOpenSleep(db);
  const last = lastFinishedSleep(db);
  const today = sleepStatsForRange(db, dayStart, dayEnd, nowMs);

  const lastSleep =
    last && last.ended_at
      ? {
          startedAt: last.started_at,
          endedAt: last.ended_at,
          durationMin: minutesOf(last.started_at, last.ended_at),
        }
      : null;

  const status: 'asleep' | 'awake' = open ? 'asleep' : 'awake';
  const since = open ? open.started_at : (last?.ended_at ?? null);
  const currentDurationMin = since ? Math.max(0, Math.round((nowMs - Date.parse(since)) / 60_000)) : 0;

  return {
    now: nowIsoStr,
    child: {
      name: cfg.childName,
      birthDate: cfg.childBirthDate,
      ageDays: Math.max(0, daysBetween(cfg.childBirthDate, todayISO)),
    },
    sleep: { status, since, currentDurationMin, lastSleep },
    today: {
      date: todayISO,
      sleepTotalMin: today.totalMin,
      sleepSessions: today.sessions,
      longestSleepMin: today.longestMin,
    },
    pending: pendingCount(db),
  };
}

export const DAILY_DAYS_DEFAULT = 14;
export const DAILY_DAYS_MAX = 90;

/** §3.4 GET /api/sleep/daily. Сутки идут от старых к новым. */
export function dailySleep(
  db: Db,
  cfg: Config,
  days: number = DAILY_DAYS_DEFAULT,
  now: Date = new Date(),
): DailySleepDto[] {
  const total = Math.min(Math.max(1, Math.trunc(days)), DAILY_DAYS_MAX);
  const todayISO = localDateISO(now, cfg.tz);
  const nowMs = now.getTime();
  const result: DailySleepDto[] = [];

  for (let i = total - 1; i >= 0; i--) {
    const date = shiftLocalDate(todayISO, -i);
    const from = localDayStartMs(date, cfg.tz);
    const to = localDayStartMs(shiftLocalDate(date, 1), cfg.tz);
    const stats = sleepStatsForRange(db, from, to, nowMs);
    result.push({
      date,
      totalMin: stats.totalMin,
      sessions: stats.sessions,
      nightMin: stats.nightMin,
      napMin: stats.napMin,
    });
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* §10.4: суточная статистика для админ-дашборда                       */
/* ------------------------------------------------------------------ */

export interface DailyStatsDto {
  date: string;
  ageDays: number;
  feeds: { total: number; breast: number; bottle: number; solid: number; volumeMl: number | null };
  diapers: { wet: number; dirty: number; both: number; total: number };
  sleep: { totalMin: number; sessions: number; longestMin: number };
  /** Последнее за сутки измерение; null — в этот день не измеряли. */
  measures: { weightG: number | null; heightCm: number | null; headCm: number | null; tempMaxC: number | null };
  norms: AgeNorms;
}

/** Последнее за день измерение нужного подтипа, приведённое к базовой единице. */
function lastMeasure(
  rows: EventRow[],
  subtype: string,
  convert: (value: number, unit: string | null) => number,
): number | null {
  const found = rows
    .filter((e) => e.type === 'measure' && e.subtype === subtype && e.value_num !== null)
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .at(-1);
  return found?.value_num === null || found === undefined
    ? null
    : convert(found.value_num, found.value_unit);
}

export function dailyStats(
  db: Db,
  cfg: Config,
  days: number = DAILY_DAYS_DEFAULT,
  now: Date = new Date(),
): DailyStatsDto[] {
  const total = Math.min(Math.max(1, Math.trunc(days)), DAILY_DAYS_MAX);
  const todayISO = localDateISO(now, cfg.tz);
  const nowMs = now.getTime();
  const result: DailyStatsDto[] = [];

  for (let i = total - 1; i >= 0; i--) {
    const date = shiftLocalDate(todayISO, -i);
    const from = localDayStartMs(date, cfg.tz);
    const to = localDayStartMs(shiftLocalDate(date, 1), cfg.tz);

    const rows = all<EventRow>(
      db,
      `SELECT ${EVENT_COLUMNS} FROM events
        WHERE deleted_at IS NULL AND started_at >= ? AND started_at < ?
        ORDER BY started_at ASC`,
      [new Date(from).toISOString(), new Date(to).toISOString()],
    );

    const feeds = rows.filter((e) => e.type === 'feed');
    const volumes = feeds.filter((e) => e.value_unit === 'ml' && e.value_num !== null);
    const diapers = rows.filter((e) => e.type === 'diaper');
    const sleep = sleepStatsForRange(db, from, to, nowMs);

    // «both» — это один подгузник, который был И мокрым, И грязным. По нормам
    // §10.1 он засчитывается в обе категории: иначе дашборд сравнивает с нормой
    // «с 5-го дня 6+ мокрых» заниженное число и даёт ложное спокойствие по
    // главному признаку достаточного питья.
    const both = diapers.filter((e) => e.subtype === 'both').length;
    const wet = diapers.filter((e) => e.subtype === 'wet').length + both;
    const dirty = diapers.filter((e) => e.subtype === 'dirty').length + both;

    result.push({
      date,
      ageDays: Math.max(0, daysBetween(cfg.childBirthDate, date)),
      feeds: {
        total: feeds.length,
        breast: feeds.filter((e) => e.subtype === 'breast').length,
        bottle: feeds.filter((e) => e.subtype === 'bottle').length,
        solid: feeds.filter((e) => e.subtype === 'solid').length,
        // объём необязателен (§10.2): нет ни одного названного — отдаём null, а не 0
        volumeMl:
          volumes.length === 0
            ? null
            : Math.round(volumes.reduce((sum, e) => sum + (e.value_num ?? 0), 0)),
      },
      diapers: {
        // wet и dirty уже включают both — сравнивать с нормой надо именно их
        wet,
        dirty,
        both,
        // сколько подгузников сменили физически
        total: diapers.length,
      },
      sleep: { totalMin: sleep.totalMin, sessions: sleep.sessions, longestMin: sleep.longestMin },
      measures: {
        weightG: lastMeasure(rows, 'weight', (v, u) => (u === 'kg' ? Math.round(v * 1000) : v)),
        heightCm: lastMeasure(rows, 'height', (v) => v),
        headCm: lastMeasure(rows, 'head', (v) => v),
        tempMaxC:
          rows
            .filter((e) => e.type === 'measure' && e.subtype === 'temp' && e.value_num !== null)
            .reduce<number | null>((max, e) => Math.max(max ?? -Infinity, e.value_num ?? 0), null),
      },
      norms: normsForAge(Math.max(0, daysBetween(cfg.childBirthDate, date))),
    });
  }

  return result;
}
