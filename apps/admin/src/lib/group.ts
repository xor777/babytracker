/**
 * Сборка ленты: события → дни → грозди по фразе.
 *
 * §10.3: одна фраза порождает сколько угодно событий. В ленте они обязаны стоять вместе
 * и в том порядке, в котором прозвучали («покушал и уснул» — сначала еда), иначе не видно,
 * как разбор превратил фразу в записи, и ошибку не поймать.
 */
import type { ChangeSet, GrowthPoint, TrackerEvent, Utterance } from '../types';
import { localDateKey, parseTs, startOfLocalDay } from './format';

export interface EventGroup {
  key: string;
  /** null — событие создано руками или через API, исходной фразы нет. */
  utterance: Utterance | null;
  events: TrackerEvent[];
  /** Время самого позднего события грозди — по нему гроздь стоит в ленте. */
  anchor: number;
  /** Наборы изменений этой фразы (§9.2) — по ним видно, что она сделала. */
  changeSets: ChangeSet[];
  /**
   * События, которые фраза ИЗМЕНИЛА, но не создавала: «проснулся» закрывает
   * чужой сон. Без них такая фраза выглядит не сделавшей ничего, хотя она
   * поменяла дневник.
   */
  touched: TrackerEvent[];
}

/** Набор, который сам является откатом другого. Предлагать «отменить» его не надо. */
export function isRevertSet(cs: ChangeSet): boolean {
  return (cs.summary ?? '').startsWith('Откат набора изменений');
}

/** Наборы, которые ещё можно отменить. */
export function undoableSets(sets: ChangeSet[]): ChangeSet[] {
  return sets.filter((cs) => !cs.reverted_at && !isRevertSet(cs));
}

export interface DaySection {
  key: string;
  dayMs: number;
  groups: EventGroup[];
  /** Считаем раздельно: иначе заголовок пишет «0 записей» над пятью карточками. */
  events: number;
  phrases: number;
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

/**
 * @param orphans фразы, не породившие ни одного события. Их обязательно видно в ленте:
 *   упавший разбор иначе исчезает бесследно, а это ровно тот случай, который ловят руками.
 */
export function buildSections(
  events: TrackerEvent[],
  orphans: Utterance[] = [],
  setsByUtterance: Map<number, ChangeSet[]> = new Map(),
  eventsById: Map<number, TrackerEvent> = new Map(),
): DaySection[] {
  const days = new Map<string, Map<string, EventGroup>>();

  const ensureDay = (key: string) => {
    let groups = days.get(key);
    if (!groups) {
      groups = new Map();
      days.set(key, groups);
    }
    return groups;
  };

  for (const event of events) {
    const ms = parseTs(event.started_at);
    if (ms == null) continue;
    const dayKey = localDateKey(ms);
    const groups = ensureDay(dayKey);
    // Событие без фразы живёт в собственной грозди — сливать их в одну кучу нельзя.
    const groupKey = event.utterance_id != null ? `u${event.utterance_id}` : `e${event.id}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.events.push(event);
      existing.anchor = Math.max(existing.anchor, ms);
      if (!existing.utterance && event.utterance) existing.utterance = event.utterance;
    } else {
      groups.set(groupKey, {
        key: `${dayKey}:${groupKey}`,
        utterance: event.utterance ?? null,
        events: [event],
        anchor: ms,
        changeSets: [],
        touched: [],
      });
    }
  }

  for (const u of orphans) {
    const ms = parseTs(u.received_at);
    if (ms == null) continue;
    const dayKey = localDateKey(ms);
    const groups = ensureDay(dayKey);
    const groupKey = `u${u.id}`;
    if (groups.has(groupKey)) continue;
    groups.set(groupKey, {
      key: `${dayKey}:${groupKey}`,
      utterance: u,
      events: [],
      anchor: ms,
      changeSets: [],
      touched: [],
    });
  }

  // Привязываем наборы изменений и «изменённые, но не созданные» события.
  for (const groups of days.values()) {
    for (const group of groups.values()) {
      const uid = group.utterance?.id;
      if (uid == null) continue;
      group.changeSets = setsByUtterance.get(uid) ?? [];
      const own = new Set(group.events.map((e) => e.id));
      const seen = new Set<number>();
      for (const cs of group.changeSets) {
        if (isRevertSet(cs)) continue;
        for (const id of cs.events ?? []) {
          if (own.has(id) || seen.has(id)) continue;
          const found = eventsById.get(id);
          if (found) {
            seen.add(id);
            group.touched.push(found);
          }
        }
      }
    }
  }

  const sections: DaySection[] = [];
  for (const [dayKey, groups] of days) {
    const list = [...groups.values()];
    for (const group of list) {
      // Внутри фразы — хронологический порядок: так видно, что за чем пошло.
      group.events.sort((a, b) => (parseTs(a.started_at) ?? 0) - (parseTs(b.started_at) ?? 0));
    }
    list.sort((a, b) => b.anchor - a.anchor);
    sections.push({
      key: dayKey,
      dayMs: list.length ? startOfLocalDay(list[0].anchor) : 0,
      groups: list,
      events: list.reduce((sum, g) => sum + g.events.length, 0),
      phrases: list.filter((g) => g.events.length === 0).length,
    });
  }
  sections.sort((a, b) => b.dayMs - a.dayMs);
  return sections;
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
