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
  /**
   * Что понял быстрый матчер (§4). По нему отличается вопрос к Алисе
   * («сколько спал») от фразы, которую действительно никто не разобрал.
   */
  fast_result?: unknown;
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
  /**
   * Исходная фраза плоским полем — так её отдаёт сервер (§10.4, LEFT JOIN по utterance_id).
   * Это основной и самый надёжный источник текста: он приходит вместе с самим событием.
   */
  utterance_text?: string | null;
  /** Та же фраза объектом: собирается на клиенте, со статусом разбора, если он известен. */
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

/**
 * Норма-ориентир из §10.1. `note` сервер пишет словами («с 5-го дня — 6 и более…») —
 * показываем именно его, а не свою переформулировку.
 */
export interface NormRange {
  min?: number | null;
  max?: number | null;
  note?: string | null;
}

/**
 * Сводка за сутки — ровно то, что отдаёт `GET /api/stats/daily` (§10.4).
 * Имена полей совпадают с сервером намеренно: любое «улучшение» здесь превращается
 * в тихие нули на экране.
 */
export interface DailyStats {
  date: string;
  ageDays?: number;
  feeds: {
    total: number;
    breast: number;
    bottle: number;
    solid: number;
    /** null — объём ни разу не называли. Это не ноль (§10.2). */
    volumeMl: number | null;
  };
  diapers: { wet: number; dirty: number; both: number; total: number };
  sleep: { totalMin: number; sessions: number; longestMin: number };
  measures: {
    weightG: number | null;
    heightCm: number | null;
    headCm: number | null;
    tempMaxC: number | null;
  };
  norms?: {
    feeds?: NormRange;
    wetDiapers?: NormRange;
    dirtyDiapers?: NormRange;
  };
}

export interface StatsResponse {
  days: DailyStats[];
}

/**
 * §9.2 — набор изменений. Ключевая вещь для журнала: фраза может не создать
 * ни одного события, а изменить существующее («проснулся» закрывает сон).
 * Связь «фраза → что она сделала» живёт только здесь, в `utterance_id` и `events`.
 */
export interface ChangeSet {
  id: string;
  utterance_id: number | null;
  summary: string | null;
  created_at: string;
  reverted_at: string | null;
  revisions: number;
  events: number[];
}

/** §3.2 — текущее состояние: шапка и раздел «Обзор». */
export interface TrackerState {
  now?: string;
  child?: { name?: string; birthDate?: string; ageDays?: number };
  sleep?: {
    status?: 'asleep' | 'awake' | string;
    since?: string | null;
    currentDurationMin?: number;
    lastSleep?: { startedAt: string; endedAt: string; durationMin: number } | null;
  };
  today?: {
    date?: string;
    sleepTotalMin?: number;
    sleepSessions?: number;
    longestSleepMin?: number;
  };
  /** Сколько фраз Алисы ещё разбирается. */
  pending?: number;
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
