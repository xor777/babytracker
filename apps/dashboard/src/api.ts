import type { Health, TrackerEvent, TrackerState, Utterance } from './types';

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

/** Страница сопряжения (§11). Короткая и на том же origin. */
export const PAIR_PATH = '/pair';

/**
 * Сессии нет — уходим на экран сопряжения.
 *
 * Именно этого от дашборда и ждут: телевизор висит на стене, и если сессию
 * отозвали или она не заводилась, он обязан показать код сопряжения, а не
 * пустой экран и не бесконечную «загрузку». Разбираться, почему дневник
 * пропал, будет некому — на телевизоре нет ни консоли, ни клавиатуры.
 *
 * `replace`, а не `assign`: возвращаться кнопкой «назад» на страницу,
 * которая всё равно отдаст 401, незачем.
 *
 * Переход одноразовый: дашборд шлёт несколько запросов сразу, и каждый из
 * них получит 401 — навигацию надо начать один раз.
 */
let leaving = false;

export function goToPairing(): void {
  if (leaving) return;
  leaving = true;
  const next = encodeURIComponent(window.location.pathname || '/');
  window.location.replace(`${PAIR_PATH}?next=${next}`);
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(path), {
    signal,
    headers: { accept: 'application/json' },
    cache: 'no-store',
    // Кука сессии (§11). Явно `same-origin`, а не `include`: другого origin
    // здесь не бывает, а `include` обещал бы отправку туда, куда сервер её
    // всё равно не пустит — CORS у нас без credentials.
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    goToPairing();
    throw new Error(`${path} → нет сессии`);
  }
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

/** Все взвешивания за всю историю: ряд веса начинается с веса при рождении. */
export async function fetchMeasures(signal?: AbortSignal): Promise<TrackerEvent[]> {
  const payload = await getJson<unknown>('/api/events?type=measure&limit=200', signal);
  return pickArray<TrackerEvent>(payload, 'events', 'items', 'rows');
}

export async function fetchUtterances(limit = 20, signal?: AbortSignal): Promise<Utterance[]> {
  const payload = await getJson<unknown>(`/api/utterances?limit=${limit}`, signal);
  return pickArray<Utterance>(payload, 'utterances', 'items', 'rows');
}

/**
 * Все события за последние 30 часов — не только сон: лента суток, счётчики
 * кормлений и подгузников считаются на клиенте, в /api/state их нет.
 * Запас в 6 часов сверх суток нужен, чтобы поймать начало ночного сна.
 */
export async function fetchRecentEvents(signal?: AbortSignal): Promise<TrackerEvent[]> {
  const from = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
  const payload = await getJson<unknown>(
    `/api/events?from=${encodeURIComponent(from)}&limit=400`,
    signal,
  );
  return pickArray<TrackerEvent>(payload, 'events', 'items', 'rows');
}

/** §3.8 — состояние сервера и воркера. Не критично: при ошибке просто ничего не показываем. */
export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  return getJson<Health>('/healthz', signal);
}
