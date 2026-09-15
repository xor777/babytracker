/**
 * Раскладка журнала: плоская лента строк, новое сверху.
 *
 * Главная единица — СОБЫТИЕ в разобранном виде, а не фраза Алисы. Журнал
 * открывают, чтобы увидеть, что было, а не чтобы проверять качество разбора;
 * группировка вокруг фразы делала ленту громоздкой — на экран помещалось три
 * записи вместо полутора десятков.
 *
 * Фраза никуда не делась: она уходит в разворот строки, а связь «эти записи
 * из одной фразы» показывается там же. Но чтобы ошибки разбора не потерялись,
 * подозрительные строки помечаются прямо в свёрнутом виде — см. `needsCheck`.
 */
import type { ChangeSet, TrackerEvent, Utterance } from '../types';
import { localDateKey, parseTs, startOfLocalDay } from './format';
import { isAssumption } from './describe';
import { classifyPhrase } from './utterance';
import type { PhraseVerdict } from './utterance';

/** Ниже этого разбор стоит перепроверить глазами. */
const SHAKY = 0.6;

export interface EventRowData {
  kind: 'event';
  key: string;
  at: number;
  event: TrackerEvent;
  utterance: Utterance | null;
  /** Другие события той же фразы — показываем в развороте. */
  siblings: TrackerEvent[];
  changeSets: ChangeSet[];
  needsCheck: boolean;
  /** Из-за чего строка помечена. */
  reason: string | null;
}

export interface PhraseRowData {
  kind: 'phrase';
  key: string;
  at: number;
  utterance: Utterance;
  verdict: PhraseVerdict;
  /** Записи, которые фраза изменила, не создавая. */
  touched: TrackerEvent[];
  changeSets: ChangeSet[];
  needsCheck: boolean;
}

export type JournalRow = EventRowData | PhraseRowData;

export interface DaySection {
  key: string;
  dayMs: number;
  rows: JournalRow[];
  events: number;
  phrases: number;
}

function checkEvent(e: TrackerEvent): string | null {
  if (e.confidence != null && e.confidence < SHAKY) {
    return `разбор не уверен — ${Math.round(e.confidence * 100)}%`;
  }
  if (isAssumption(e.note)) return 'модель отметила допущение';
  return null;
}

export interface BuildInput {
  events: TrackerEvent[];
  /** Фразы без созданных событий — их отбирает useHistory. */
  orphans: Utterance[];
  setsByUtterance: Map<number, ChangeSet[]>;
  eventsById: Map<number, TrackerEvent>;
  utterancesById: Map<number, Utterance>;
}

export function buildJournal(input: BuildInput): DaySection[] {
  const { events, orphans, setsByUtterance, eventsById, utterancesById } = input;

  // Кто ещё родился из той же фразы — для строки «из той же фразы».
  const byUtterance = new Map<number, TrackerEvent[]>();
  for (const e of events) {
    if (e.utterance_id == null) continue;
    const list = byUtterance.get(e.utterance_id);
    if (list) list.push(e);
    else byUtterance.set(e.utterance_id, [e]);
  }

  const rows: JournalRow[] = [];

  for (const event of events) {
    const at = parseTs(event.started_at);
    if (at == null) continue;
    const uid = event.utterance_id ?? null;
    const siblings = uid != null ? (byUtterance.get(uid) ?? []).filter((x) => x.id !== event.id) : [];
    const reason = checkEvent(event);
    rows.push({
      kind: 'event',
      key: `e${event.id}`,
      at,
      event,
      utterance: event.utterance ?? (uid != null ? (utterancesById.get(uid) ?? null) : null),
      siblings,
      changeSets: uid != null ? (setsByUtterance.get(uid) ?? []) : [],
      needsCheck: reason !== null,
      reason,
    });
  }

  for (const u of orphans) {
    const at = parseTs(u.received_at);
    if (at == null) continue;
    const sets = setsByUtterance.get(u.id) ?? [];
    const touched: TrackerEvent[] = [];
    const seen = new Set<number>();
    for (const cs of sets) {
      for (const id of cs.events ?? []) {
        if (seen.has(id)) continue;
        const found = eventsById.get(id);
        if (found) {
          seen.add(id);
          touched.push(found);
        }
      }
    }
    const verdict = classifyPhrase(u);
    rows.push({
      kind: 'phrase',
      key: `u${u.id}`,
      at,
      utterance: u,
      verdict,
      touched,
      changeSets: sets,
      needsCheck: touched.length === 0 && verdict.show && verdict.tone === 'gap',
    });
  }

  // Сортировка одна и без исключений: самое новое сверху.
  rows.sort((a, b) => b.at - a.at);

  const days = new Map<string, JournalRow[]>();
  for (const row of rows) {
    const key = localDateKey(row.at);
    const list = days.get(key);
    if (list) list.push(row);
    else days.set(key, [row]);
  }

  const sections: DaySection[] = [];
  for (const [key, list] of days) {
    sections.push({
      key,
      dayMs: startOfLocalDay(list[0].at),
      rows: list,
      events: list.filter((r) => r.kind === 'event').length,
      phrases: list.filter((r) => r.kind === 'phrase').length,
    });
  }
  sections.sort((a, b) => b.dayMs - a.dayMs);
  return sections;
}
