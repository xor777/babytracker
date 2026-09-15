/** Событие → строчки, которые видит человек в ленте. */
import type { TrackerEvent } from '../types';
import { breastSide, subtypeLabel, typeDef, unitLabel } from './taxonomy';
import { HOUR, durationMin, formatMinutes, formatNumber, formatWeight, parseTs } from './format';

/**
 * Дольше этого «идёт» — уже не идёт, а незакрытая запись: купание без ended_at
 * иначе висело бы с бейджем «идёт» вечно.
 */
const STILL_GOING = 12 * HOUR;

export interface EventLines {
  /** «Кормление» */
  title: string;
  /** «бутылочка» */
  sub: string | null;
  /** «120 мл», «1 ч 10 мин», «левая» — каждая частица отдельно, чтобы верстать. */
  parts: string[];
  /** Заметка, если она не ушла в parts. */
  note: string | null;
  /** Событие ещё идёт (§1: ended_at IS NULL). */
  open: boolean;
  tone: string;
  icon: string;
}

function valueText(e: TrackerEvent): string | null {
  if (e.value_num == null) return null;
  if (e.type === 'measure') {
    if (e.subtype === 'weight') return formatWeight(e.value_unit === 'kg' ? e.value_num * 1000 : e.value_num);
    if (e.subtype === 'temp') return `${formatNumber(e.value_num, 1)} °C`;
    return `${formatNumber(e.value_num, 1)} ${unitLabel(e.value_unit ?? 'cm')}`;
  }
  return `${formatNumber(e.value_num, Number.isInteger(e.value_num) ? 0 : 1)} ${unitLabel(e.value_unit)}`.trim();
}

export function describeEvent(e: TrackerEvent): EventLines {
  const def = typeDef(e.type);
  const parts: string[] = [];
  let note = e.note?.trim() || null;

  const ranged = durationMin(e.started_at, e.ended_at);
  const startedMs = parseTs(e.started_at);
  const open =
    def.openable &&
    !e.ended_at &&
    startedMs != null &&
    Date.now() - startedMs < STILL_GOING;

  const value = valueText(e);
  if (value) parts.push(value);

  // Длительность показываем, когда она не дублирует value (грудь уже в минутах).
  if (ranged != null && !(e.value_unit === 'min' && Math.abs(ranged - (e.value_num ?? 0)) <= 1)) {
    parts.push(formatMinutes(ranged));
  }

  if (e.type === 'feed' && e.subtype === 'breast') {
    const side = breastSide(e.note);
    if (side) {
      parts.push(side);
      note = null; // сторона уже показана, дублировать не надо
    }
  }

  return {
    title: def.label,
    sub: subtypeLabel(e.type, e.subtype),
    parts,
    note,
    open,
    tone: `var(--t-${def.tone})`,
    icon: def.icon,
  };
}
