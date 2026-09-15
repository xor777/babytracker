import type { TrackerEvent, TrackerState, Utterance } from '../types';

/**
 * Снимок последнего состояния в sessionStorage.
 *
 * Нужен ради самообновления: после перезагрузки экран мгновенно рисует то же,
 * что было, и обновляет данные в фоне — вместо чёрного экрана загрузки на
 * секунду-другую. Заодно это ускоряет любой холодный старт.
 *
 * sessionStorage, а не localStorage: пережить перезагрузку страницы нужно,
 * а показывать позавчерашние данные после перезапуска приставки — нет.
 */
const KEY = 'andreytracker.snapshot';
/** Поднимать руками, если изменится форма хранимых данных. */
const SCHEMA = 1;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface Snapshot {
  state: TrackerState | null;
  events: TrackerEvent[];
  measures: TrackerEvent[];
  utterances: Utterance[];
}

interface StoredSnapshot extends Snapshot {
  schema: number;
  at: number;
}

export function loadSnapshot(): Snapshot | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSnapshot;
    if (parsed?.schema !== SCHEMA) return null;
    if (!parsed.state || Date.now() - parsed.at > MAX_AGE_MS) return null;
    return {
      state: parsed.state,
      events: Array.isArray(parsed.events) ? parsed.events : [],
      measures: Array.isArray(parsed.measures) ? parsed.measures : [],
      utterances: Array.isArray(parsed.utterances) ? parsed.utterances : [],
    };
  } catch {
    return null;
  }
}

export function saveSnapshot(data: Snapshot): void {
  if (!data.state) return;
  try {
    const stored: StoredSnapshot = {
      schema: SCHEMA,
      at: Date.now(),
      state: data.state,
      events: data.events.slice(0, 300),
      measures: data.measures.slice(0, 100),
      utterances: data.utterances.slice(0, 20),
    };
    window.sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // приватный режим или переполнение — обойдёмся экраном загрузки
  }
}
