/**
 * Подсобка ленты: привязка фразы к событию, наборы изменений и ростовой ряд.
 *
 * Саму ленту собирает `lib/journal.ts` — здесь только то, чем она пользуется.
 */
import type { ChangeSet, GrowthPoint, TrackerEvent, Utterance } from '../types';
import { parseTs } from './format';

/** Набор, который сам является откатом другого. Предлагать «отменить» его не надо. */
export function isRevertSet(cs: ChangeSet): boolean {
  return (cs.summary ?? '').startsWith('Откат набора изменений');
}

/** Наборы, которые ещё можно отменить. */
export function undoableSets(sets: ChangeSet[]): ChangeSet[] {
  return sets.filter((cs) => !cs.reverted_at && !isRevertSet(cs));
}

/**
 * Приклеивает к событию фразу.
 *
 * Основной источник — плоское `utterance_text` в самом событии: оно приходит вместе
 * с лентой и не зависит ни от какого второго запроса. Список `/api/utterances` лишь
 * обогащает её статусом разбора и временем — если он не доехал, цитата всё равно есть.
 */
export function attachUtterances(
  events: TrackerEvent[],
  utterances: Utterance[],
): TrackerEvent[] {
  const byId = new Map(utterances.map((u) => [u.id, u]));
  return events.map((e) => {
    if (e.utterance?.raw_text) return e;
    if (e.utterance_id == null) return e;

    const found = byId.get(e.utterance_id);
    if (found?.raw_text) return { ...e, utterance: found };
    if (e.utterance_text) {
      return { ...e, utterance: { id: e.utterance_id, raw_text: e.utterance_text } };
    }
    return e;
  });
}

/** Ряд для ростовой кривой: measure нужного подтипа, по возрастанию времени. */
export function growthSeries(events: TrackerEvent[], subtype: string): GrowthPoint[] {
  const points: GrowthPoint[] = [];
  for (const e of events) {
    if (e.type !== 'measure' || e.subtype !== subtype) continue;
    if (e.deleted_at) continue;
    const at = parseTs(e.started_at);
    if (at == null || e.value_num == null) continue;
    // Вес могли записать и в килограммах, и в граммах — приводим к граммам.
    const value =
      subtype === 'weight' && e.value_unit === 'kg' ? e.value_num * 1000 : e.value_num;
    points.push({ at, value });
  }
  points.sort((a, b) => a.at - b.at);
  return points;
}
