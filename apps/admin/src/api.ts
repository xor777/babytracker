import { ApiError } from './types';
import type {
  ChangeSet,
  DailyStats,
  EventPatch,
  NormRange,
  StatsResponse,
  TrackerEvent,
  TrackerState,
  Utterance,
} from './types';

/**
 * В dev база пустая: vite-прокси уводит /api на 8787.
 * В проде админка отдаётся тем же сервером по /dash, origin тот же — база снова пустая.
 */
const RAW_BASE = (import.meta.env.VITE_API_BASE ?? '').trim();
export const API_BASE = RAW_BASE.replace(/\/+$/, '');

/** Сервер режет limit жёстко и отвечает 400 (apps/server/src/api.ts). Держим его границы. */
export const UTTERANCES_LIMIT_MAX = 200;
export const EVENTS_LIMIT_MAX = 1000;

function url(path: string): string {
  return `${API_BASE}${path}`;
}

/** Человеческий текст вместо «HTTP 401». Basic Auth стоит на Caddy (§10.4). */
function describe(status: number, path: string): string {
  if (status === 401) return 'Нужен вход: обновите страницу и введите логин и пароль.';
  if (status === 403) return 'Доступ закрыт.';
  if (status === 400) return `Сервер не принял запрос ${path}.`;
  if (status === 404 || status === 405) return `Сервер пока не умеет ${path}.`;
  if (status === 409) return 'Изменение конфликтует с текущим состоянием.';
  if (status >= 500) return 'Сервер отвечает ошибкой. Попробуйте ещё раз.';
  return `Запрос не прошёл (${status}).`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(path), {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : null),
        ...init?.headers,
      },
      cache: 'no-store',
    });
  } catch (cause) {
    if ((cause as Error)?.name === 'AbortError') throw cause;
    throw new ApiError(0, 'Нет связи с сервером.');
  }
  if (!res.ok) throw new ApiError(res.status, describe(res.status, path));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Контракт фиксирует обёртку {events}/{days}, но голый массив тоже переживём. */
function pickArray<T>(payload: unknown, ...keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    for (const key of keys) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

function pickEvent(payload: unknown): TrackerEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const box = payload as Record<string, unknown>;
  if (typeof box.id === 'number') return box as unknown as TrackerEvent;
  const nested = box.event;
  if (nested && typeof nested === 'object') return nested as TrackerEvent;
  return null;
}

export interface EventsQuery {
  from?: string;
  to?: string;
  types?: string[];
  limit?: number;
  includeDeleted?: boolean;
}

export async function fetchEvents(q: EventsQuery, signal?: AbortSignal): Promise<TrackerEvent[]> {
  const params = new URLSearchParams();
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);
  // §3.3 знает один type. Несколько — фильтруем на клиенте, чтобы не изобретать контракт.
  if (q.types && q.types.length === 1) params.set('type', q.types[0]);
  params.set('limit', String(Math.min(EVENTS_LIMIT_MAX, q.limit ?? 500)));
  if (q.includeDeleted) params.set('include_deleted', 'true');
  const payload = await request<unknown>(`/api/events?${params}`, { signal });
  return pickArray<TrackerEvent>(payload, 'events', 'items', 'rows');
}

export async function fetchUtterances(limit = 200, signal?: AbortSignal): Promise<Utterance[]> {
  const n = Math.min(UTTERANCES_LIMIT_MAX, Math.max(1, limit));
  const payload = await request<unknown>(`/api/utterances?limit=${n}`, { signal });
  return pickArray<Utterance>(payload, 'utterances', 'items', 'rows');
}

export async function fetchState(signal?: AbortSignal): Promise<TrackerState> {
  return request<TrackerState>('/api/state', { signal });
}

export async function patchEvent(id: number, patch: EventPatch): Promise<TrackerEvent | null> {
  const payload = await request<unknown>(`/api/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return pickEvent(payload);
}

export interface DeleteResult {
  event: TrackerEvent | null;
  /** Набор изменений, которым это удаление можно отменить (§9.6). */
  revertWith: string | null;
}

/** Мягкое удаление (§9.1: физического не существует). */
export async function deleteEvent(id: number): Promise<DeleteResult> {
  const payload = await request<any>(`/api/events/${id}`, { method: 'DELETE' });
  return {
    event: pickEvent(payload),
    revertWith: payload?.revertWith ?? payload?.changeSetId ?? null,
  };
}

// ------------------------------------------------------------------ откат

/**
 * Возврат удалённого идёт единственной дорогой, которая у сервера есть, — через журнал
 * ревизий (§9.6). Отдельной ручки «восстановить событие» не существует, и снять
 * `deleted_at` патчем тоже нельзя: в схеме PATCH такого поля нет.
 */
export async function revertChangeSet(changeSetId: string): Promise<TrackerEvent[]> {
  const payload = await request<any>(`/api/change-sets/${changeSetId}/revert`, { method: 'POST' });
  return pickArray<TrackerEvent>(payload?.restored, 'restored');
}

/** Журнал изменений: по нему видно, что фраза сделала с данными (§9.2). */
export async function fetchChangeSets(limit = 200, signal?: AbortSignal): Promise<ChangeSet[]> {
  const payload = await request<any>(`/api/change-sets?limit=${limit}`, { signal });
  return pickArray<ChangeSet>(payload, 'changeSets', 'change_sets', 'items');
}

/**
 * Каким изменением событие удалили, если мы удаляли его не в этой сессии.
 * Список наборов уже несёт `events: number[]`, поэтому хватает одного запроса.
 */
export async function findChangeSetForEvent(eventId: number): Promise<string | null> {
  const sets = await fetchChangeSets(200);
  // Список приходит от свежих к старым — берём первый непогашенный, который трогал событие.
  const found = sets.find((cs) => !cs.reverted_at && Array.isArray(cs.events) && cs.events.includes(eventId));
  return found?.id ?? null;
}

// ------------------------------------------------------------------ сводка

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function maybeNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function norm(raw: any): NormRange | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return { min: maybeNum(raw.min), max: maybeNum(raw.max), note: raw.note ?? null };
}

/**
 * Имена полей — ровно как у сервера (`feeds`, `diapers`, `measures`,
 * `norms.wetDiapers`). Никаких догадок: мимо названия — молчаливый ноль на экране.
 */
function normalizeDay(raw: unknown): DailyStats | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  if (typeof r.date !== 'string') return null;
  return {
    date: r.date,
    ageDays: maybeNum(r.ageDays) ?? undefined,
    feeds: {
      total: num(r.feeds?.total),
      breast: num(r.feeds?.breast),
      bottle: num(r.feeds?.bottle),
      solid: num(r.feeds?.solid),
      volumeMl: maybeNum(r.feeds?.volumeMl),
    },
    diapers: {
      wet: num(r.diapers?.wet),
      dirty: num(r.diapers?.dirty),
      both: num(r.diapers?.both),
      total: num(r.diapers?.total),
    },
    sleep: {
      totalMin: num(r.sleep?.totalMin),
      sessions: num(r.sleep?.sessions),
      longestMin: num(r.sleep?.longestMin),
    },
    measures: {
      weightG: maybeNum(r.measures?.weightG),
      heightCm: maybeNum(r.measures?.heightCm),
      headCm: maybeNum(r.measures?.headCm),
      tempMaxC: maybeNum(r.measures?.tempMaxC),
    },
    norms: r.norms
      ? {
          feeds: norm(r.norms.feeds),
          wetDiapers: norm(r.norms.wetDiapers),
          dirtyDiapers: norm(r.norms.dirtyDiapers),
        }
      : undefined,
  };
}

export async function fetchStats(days = 7, signal?: AbortSignal): Promise<StatsResponse> {
  const payload = await request<any>(`/api/stats/daily?days=${days}`, { signal });
  const rows = pickArray<unknown>(payload, 'days', 'daily', 'items');
  const parsed = rows.map(normalizeDay).filter((d): d is DailyStats => d !== null);
  // Сервер отдаёт дни по возрастанию. Сортируем сами, а не полагаемся на порядок:
  // «сегодня» определяется датой, а не позицией в массиве.
  parsed.sort((a, b) => b.date.localeCompare(a.date));
  return { days: parsed };
}
