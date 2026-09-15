/**
 * Общие типы. Строки времени — ВСЕГДА ISO 8601 UTC (`2026-09-15T14:32:05.123Z`),
 * см. §1 контракта. Локальная таймзона живёт только на слое представления.
 */

/** §10.2 — полная таксономия. */
export type EventType =
  | 'sleep'
  | 'feed'
  | 'pump'
  | 'diaper'
  | 'measure'
  | 'meds'
  | 'symptom'
  | 'activity'
  | 'note';

export type EventSource = 'alice-fast' | 'alice-llm' | 'api' | 'manual';
export type ValueUnit = 'ml' | 'g' | 'kg' | 'c' | 'cm' | 'min' | 'mg';
export type UtteranceStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';

/** Строка таблицы `events` — ровно как в §1 контракта (snake_case). */
export interface EventRow {
  id: number;
  child_id: string;
  type: string;
  subtype: string | null;
  started_at: string;
  ended_at: string | null;
  value_num: number | null;
  value_unit: string | null;
  note: string | null;
  source: string;
  utterance_id: number | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Строка таблицы `utterances` — §1 контракта. */
export interface UtteranceRow {
  id: number;
  raw_text: string;
  alice_user_id: string | null;
  session_id: string | null;
  received_at: string;
  status: string;
  fast_result: string | null;
  llm_result: string | null;
  llm_error: string | null;
  attempts: number;
  processed_at: string | null;
}

/** Вид utterance для API/SSE: JSON-поля уже распарсены. */
export interface UtteranceDto {
  id: number;
  raw_text: string;
  status: string;
  received_at: string;
  processed_at: string | null;
  attempts: number;
  llm_error: string | null;
  fast_result: unknown;
  llm_result: unknown;
}

/** §3.2 `GET /api/state`. */
export interface StateDto {
  now: string;
  child: { name: string; birthDate: string; ageDays: number };
  sleep: {
    status: 'asleep' | 'awake';
    since: string | null;
    currentDurationMin: number;
    lastSleep: { startedAt: string; endedAt: string; durationMin: number } | null;
  };
  today: {
    date: string;
    sleepTotalMin: number;
    sleepSessions: number;
    longestSleepMin: number;
  };
  pending: number;
}

/** §3.4 `GET /api/sleep/daily`. */
export interface DailySleepDto {
  date: string;
  totalMin: number;
  sessions: number;
  nightMin: number;
  napMin: number;
}

/* ------------------------------------------------------------------ */
/* Яндекс.Диалоги                                                      */
/* ------------------------------------------------------------------ */

export interface AliceEntityTokens {
  start?: number;
  end?: number;
}

export interface AliceEntity {
  type: string;
  tokens?: AliceEntityTokens;
  value?: unknown;
}

export interface AliceNlu {
  tokens?: string[];
  entities?: AliceEntity[];
  intents?: Record<string, unknown>;
}

export interface AliceRequestBody {
  meta?: {
    locale?: string;
    timezone?: string;
    client_id?: string;
    interfaces?: Record<string, unknown>;
  };
  session?: {
    message_id?: number;
    session_id?: string;
    skill_id?: string;
    user_id?: string;
    new?: boolean;
    user?: { user_id?: string };
    application?: { application_id?: string };
  };
  request?: {
    type?: string;
    command?: string;
    original_utterance?: string;
    nlu?: AliceNlu;
  };
  version?: string;
}

export interface AliceResponseBody {
  response: {
    text: string;
    tts: string;
    end_session: boolean;
  };
  version: string;
}

/** Значение сущности `YANDEX.DATETIME`. */
export interface YandexDateTimeValue {
  year?: number;
  year_is_relative?: boolean;
  month?: number;
  month_is_relative?: boolean;
  day?: number;
  day_is_relative?: boolean;
  hour?: number;
  hour_is_relative?: boolean;
  minute?: number;
  minute_is_relative?: boolean;
  second?: number;
  second_is_relative?: boolean;
}

/* ------------------------------------------------------------------ */
/* Fast-path (§4)                                                      */
/* ------------------------------------------------------------------ */

/**
 * §10.3. Два независимых признака «не закрывай фразу одним матчером»:
 *
 * - `mayContainMore` — во фразе может быть ещё событие, кроме распознанного.
 *   Без него «покушал и уснул» молча теряет кормление.
 * - `timeUnresolved` — во фразе есть указание на время, а разрешить его
 *   в абсолютный момент не удалось. Без него «заснул полтора часа назад»
 *   записывается на «сейчас» с уверенностью 0.95: правдоподобно и неверно.
 *
 * Любой из них при `true` отправляет фразу модели независимо от confidence
 * и политики очереди. Держать их раздельно важно: причина разная, и подсказка
 * модели в промпте тоже разная.
 */
export type FastResult =
  | {
      kind: 'sleep_start';
      confidence: number;
      at?: string;
      mayContainMore: boolean;
      timeUnresolved: boolean;
    }
  | {
      kind: 'sleep_end';
      confidence: number;
      at?: string;
      mayContainMore: boolean;
      timeUnresolved: boolean;
    }
  | { kind: 'query_state'; confidence: number; mayContainMore: boolean; timeUnresolved: boolean }
  | { kind: 'exit'; mayContainMore: boolean; timeUnresolved: boolean }
  | { kind: 'unknown'; mayContainMore: boolean; timeUnresolved: boolean };
