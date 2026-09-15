/**
 * Типы строго по docs/CONTRACT.md. Менять только вместе с контрактом.
 */

export type EventType = 'sleep' | 'feed' | 'diaper' | 'measure' | 'meds' | 'note';

export type SleepStatus = 'asleep' | 'awake';

export type UtteranceStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';

/** §1 — строка таблицы events */
export interface TrackerEvent {
  id: number;
  child_id?: string;
  type: EventType | string;
  subtype?: string | null;
  started_at: string;
  ended_at?: string | null;
  value_num?: number | null;
  value_unit?: string | null;
  note?: string | null;
  source?: string;
  utterance_id?: number | null;
  confidence?: number | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

/** §4 — результат fast-path. Сервер отдаёт его объектом, не строкой. */
export interface FastResult {
  kind?: string;
  confidence?: number;
  at?: string;
  [key: string]: unknown;
}

/** §1 — строка таблицы utterances (SSE присылает урезанный набор полей) */
export interface Utterance {
  id: number;
  raw_text: string;
  status: UtteranceStatus | string;
  received_at?: string | null;
  processed_at?: string | null;
  /** В БД это TEXT, но наружу сервер отдаёт разобранный объект. Строку тоже переживаем. */
  fast_result?: FastResult | string | null;
  llm_result?: FastResult | string | null;
  llm_error?: string | null;
  attempts?: number;
}

/** §3.8 — /healthz. Поля worker'а сверх контракта приходят от реального сервера. */
export interface Health {
  ok?: boolean;
  db?: boolean;
  worker?: {
    alive?: boolean;
    lastRunAt?: string | null;
    queueDepth?: number;
    claudeAvailable?: boolean;
    claudeProblem?: string | null;
  };
}

/** §3.2 — GET /api/state */
export interface TrackerState {
  now: string;
  child: { name: string; birthDate: string; ageDays: number };
  sleep: {
    status: SleepStatus;
    since: string;
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

/** §3.4 — GET /api/sleep/daily */
export interface DailySleep {
  date: string;
  totalMin: number;
  sessions: number;
  nightMin?: number;
  napMin?: number;
}

/** §3.6 — SSE event: `event` */
export interface EventMessage {
  action: 'created' | 'updated' | 'deleted';
  event: TrackerEvent;
}

/** Состояние канала связи с сервером */
export type LinkStatus = 'connecting' | 'online' | 'offline';
