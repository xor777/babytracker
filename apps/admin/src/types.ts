/**
 * Типы строго по docs/CONTRACT.md §1, §2, §10.2, §10.4.
 * Часть эндпоинтов бэкенд доделывает параллельно, поэтому читаем терпимо:
 * лишние поля не мешают, отсутствующие не роняют экран.
 */

/** §10.2 — полная таксономия. Строку оставляем: неизвестный тип не повод терять событие. */
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

export type UtteranceStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';

/** Фраза, как её услышала Алиса (§0, §1). */
export interface Utterance {
  id: number;
  raw_text: string;
  received_at?: string | null;
  processed_at?: string | null;
  status?: UtteranceStatus | string;
  llm_error?: string | null;
}

/** §1 — строка events. `utterance` подмешивает сервер (§10.4), но мы умеем и без неё. */
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
  source?: EventSource | string;
  utterance_id?: number | null;
  confidence?: number | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  /** Присоединённая фраза. Если сервер её не отдал — джойним сами по utterance_id. */
  utterance?: Utterance | null;
}

/** Поля, которые правятся руками из админки (§10.4). */
export interface EventPatch {
  type?: string;
  subtype?: string | null;
  started_at?: string;
  ended_at?: string | null;
  value_num?: number | null;
  value_unit?: string | null;
  note?: string | null;
  deleted_at?: string | null;
}

/** Норма-ориентир из §10.1: диапазон либо только нижняя граница. */
export interface NormRange {
  min?: number | null;
  max?: number | null;
}

/** Сводка за сутки. `GET /api/stats/daily` (§10.4). */
export interface DailyStats {
  date: string;
  feed: { count: number; bottleMl?: number | null; breastMin?: number | null };
  diaper: { wet: number; dirty: number; both: number };
  sleep: { totalMin: number; sessions: number; nightMin?: number | null; napMin?: number | null };
  measure?: {
    weightG?: number | null;
    heightCm?: number | null;
    headCm?: number | null;
    tempC?: number | null;
  };
  norms?: {
    feed?: NormRange;
    diaperWet?: NormRange;
    diaperDirty?: NormRange;
    sleepMin?: NormRange;
  };
}

export interface StatsResponse {
  child?: { name?: string; birthDate?: string; ageDays?: number };
  days: DailyStats[];
}

/** Точка ростовой кривой — собираем из событий measure. */
export interface GrowthPoint {
  at: number;
  value: number;
}

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** Ошибка сети с понятным для человека текстом (401 от Caddy — отдельный случай). */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
