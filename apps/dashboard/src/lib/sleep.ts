import type { TrackerEvent } from '../types';
import { parseTs } from './format';

export interface SleepSegment {
  id: number;
  /** ms, уже обрезано окном */
  start: number;
  end: number;
  ongoing: boolean;
  subtype: string | null;
}

/**
 * Превращает события сна в отрезки, пересекающиеся с окном [from, to].
 * Открытый сон (ended_at = null) тянется до `to`.
 */
export function toSegments(
  events: TrackerEvent[],
  from: number,
  to: number,
): SleepSegment[] {
  const out: SleepSegment[] = [];
  for (const ev of events) {
    if (ev.type !== 'sleep' || ev.deleted_at) continue;
    const started = parseTs(ev.started_at);
    if (started == null) continue;
    const endedRaw = parseTs(ev.ended_at);
    const ended = endedRaw ?? to;
    const start = Math.max(started, from);
    const end = Math.min(ended, to);
    if (end <= start) continue;
    out.push({
      id: ev.id,
      start,
      end,
      ongoing: endedRaw == null,
      subtype: ev.subtype ?? null,
    });
  }
  return mergeOverlaps(out.sort((a, b) => a.start - b.start));
}

/**
 * Склеивает пересекающиеся отрезки сна.
 *
 * По контракту §1 одновременно открыт только один сон, но закрытые события
 * пересекаться могут — например, если модель разобрала одну и ту же ночь дважды.
 * Без склейки лента рисует наложенные блоки с наложенными подписями, а сумма
 * «сон за 24 часа» считает пересечение дважды и завышает итог.
 */
function mergeOverlaps(sorted: SleepSegment[]): SleepSegment[] {
  const out: SleepSegment[] = [];
  for (const seg of sorted) {
    const last = out[out.length - 1];
    if (last && seg.start <= last.end) {
      last.end = Math.max(last.end, seg.end);
      last.ongoing = last.ongoing || seg.ongoing;
      continue;
    }
    out.push({ ...seg });
  }
  return out;
}

/** Слияние массива событий по id — SSE может прислать и создание, и обновление. */
export function upsertEvent(list: TrackerEvent[], ev: TrackerEvent): TrackerEvent[] {
  const idx = list.findIndex((item) => item.id === ev.id);
  if (idx === -1) return [ev, ...list];
  const next = list.slice();
  next[idx] = { ...next[idx], ...ev };
  return next;
}
