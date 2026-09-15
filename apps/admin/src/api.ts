import { ApiError } from './types';
import type { DailyStats, EventPatch, StatsResponse, TrackerEvent, Utterance } from './types';

/**
 * В dev база пустая: vite-прокси уводит /api на 8787.
 * В проде админка отдаётся тем же сервером по /dash, origin тот же — база снова пустая.
 */
const RAW_BASE = (import.meta.env.VITE_API_BASE ?? '').trim();
export const API_BASE = RAW_BASE.replace(/\/+$/, '');

function url(path: string): string {
  return `${API_BASE}${path}`;
}

/** Человеческий текст вместо «HTTP 401». Basic Auth стоит на Caddy (§10.4). */
function describe(status: number, path: string): string {
  if (status === 401) return 'Нужен вход: обновите страницу и введите логин и пароль.';
  if (status === 403) return 'Доступ закрыт.';
  if (status === 404 || status === 405) return `Сервер пока не умеет ${path}.`;
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
  params.set('limit', String(q.limit ?? 500));
  if (q.includeDeleted) params.set('include_deleted', 'true');
  const payload = await request<unknown>(`/api/events?${params}`, { signal });
  return pickArray<TrackerEvent>(payload, 'events', 'items', 'rows');
}

export async function fetchUtterances(limit = 200, signal?: AbortSignal): Promise<Utterance[]> {
  const payload = await request<unknown>(`/api/utterances?limit=${limit}`, { signal });
  return pickArray<Utterance>(payload, 'utterances', 'items', 'rows');
}

export async function patchEvent(id: number, patch: EventPatch): Promise<TrackerEvent | null> {
  const payload = await request<unknown>(`/api/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return pickEvent(payload);
}

/** Мягкое удаление (§9.1: физического не существует). */
export async function deleteEvent(id: number): Promise<TrackerEvent | null> {
  const payload = await request<unknown>(`/api/events/${id}`, { method: 'DELETE' });
  return pickEvent(payload);
}

/**
 * Возврат удалённого. Контракт отдельной ручки не фиксирует, поэтому сначала пробуем
 * очевидное — снять deleted_at патчем, и только если сервер не принял, идём в /restore.
 */
export async function restoreEvent(id: number): Promise<TrackerEvent | null> {
  try {
    return await patchEvent(id, { deleted_at: null });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 400 || err.status === 404 || err.status === 405)) {
      const payload = await request<unknown>(`/api/events/${id}/restore`, { method: 'POST' });
      return pickEvent(payload);
    }
    throw err;
  }
}

// ------------------------------------------------------------------ сводка

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function maybeNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Сводка приходит от ещё не дописанной ручки — приводим к своей форме мягко. */
function normalizeDay(raw: unknown): DailyStats | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  if (typeof r.date !== 'string') return null;
  return {
    date: r.date,
    feed: {
      count: num(r.feed?.count ?? r.feeds ?? r.feedCount),
      bottleMl: maybeNum(r.feed?.bottleMl ?? r.feed?.totalMl),
      breastMin: maybeNum(r.feed?.breastMin ?? r.feed?.totalMin),
    },
    diaper: {
      wet: num(r.diaper?.wet ?? r.diapersWet),
      dirty: num(r.diaper?.dirty ?? r.diapersDirty),
      both: num(r.diaper?.both),
    },
    sleep: {
      totalMin: num(r.sleep?.totalMin ?? r.sleepTotalMin ?? r.totalMin),
      sessions: num(r.sleep?.sessions ?? r.sleepSessions ?? r.sessions),
      nightMin: maybeNum(r.sleep?.nightMin ?? r.nightMin),
      napMin: maybeNum(r.sleep?.napMin ?? r.napMin),
    },
    measure: {
      weightG: maybeNum(r.measure?.weightG ?? r.weightG),
      heightCm: maybeNum(r.measure?.heightCm ?? r.heightCm),
      headCm: maybeNum(r.measure?.headCm ?? r.headCm),
      tempC: maybeNum(r.measure?.tempC ?? r.tempC),
    },
    norms: r.norms ?? undefined,
  };
}

export async function fetchStats(days = 7, signal?: AbortSignal): Promise<StatsResponse> {
  const payload = await request<any>(`/api/stats/daily?days=${days}`, { signal });
  const rows = pickArray<unknown>(payload, 'days', 'daily', 'items');
  return {
    child: payload && typeof payload === 'object' ? payload.child : undefined,
    days: rows.map(normalizeDay).filter((d): d is DailyStats => d !== null),
  };
}
