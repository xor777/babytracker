import type { DailySleep, TrackerEvent, TrackerState, Utterance } from './types';

/**
 * База API. В dev — пустая строка (работает vite-прокси на 8787).
 * В проде дашборд отдаётся статикой того же сервера, поэтому по умолчанию тоже пусто
 * (тот же origin). Если фронт живёт отдельно — VITE_API_BASE=http://tracker.local:8787
 */
const RAW_BASE = (import.meta.env.VITE_API_BASE ?? '').trim();
export const API_BASE = RAW_BASE.replace(/\/+$/, '');

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(path), {
    signal,
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Контракт §3.5 не фиксирует обёртку для /api/utterances, а §3.3/§3.4 фиксируют
 * ({events}, {days}). Поэтому достаём массив максимально терпимо: и голый массив,
 * и любую из вероятных обёрток. Это единственное место, где мы себе такое позволяем.
 */
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

export async function fetchState(signal?: AbortSignal): Promise<TrackerState> {
  return getJson<TrackerState>('/api/state', signal);
}

export async function fetchDaily(days = 14, signal?: AbortSignal): Promise<DailySleep[]> {
  const payload = await getJson<unknown>(`/api/sleep/daily?days=${days}`, signal);
  return pickArray<DailySleep>(payload, 'days', 'daily', 'items');
}

export async function fetchUtterances(limit = 20, signal?: AbortSignal): Promise<Utterance[]> {
  const payload = await getJson<unknown>(`/api/utterances?limit=${limit}`, signal);
  return pickArray<Utterance>(payload, 'utterances', 'items', 'rows');
}

/** Сны за последние 24 часа + небольшой запас назад, чтобы поймать начало ночного сна. */
export async function fetchSleepEvents(signal?: AbortSignal): Promise<TrackerEvent[]> {
  const from = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
  const payload = await getJson<unknown>(
    `/api/events?type=sleep&from=${encodeURIComponent(from)}&limit=200`,
    signal,
  );
  return pickArray<TrackerEvent>(payload, 'events', 'items', 'rows');
}
