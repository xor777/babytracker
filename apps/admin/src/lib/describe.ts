/** Событие → строчки, которые видит человек в ленте. */
import type { TrackerEvent } from '../types';
import { breastSide, subtypeLabel, typeDef, unitLabel } from './taxonomy';
import { HOUR, durationMin, formatMinutes, formatNumber, formatWeight, parseTs } from './format';

/**
 * Дольше этого «идёт» — уже не идёт, а незакрытая запись: купание без ended_at
 * иначе висело бы с бейджем «идёт» вечно.
 */
const STILL_GOING = 12 * HOUR;

/**
 * Модель помечает собственные допущения префиксом [?] в заметке
 * («[?] время не называлось, взята граница»). Для ленты это сигнал:
 * строку стоит развернуть и проверить.
 */
export const ASSUMPTION_MARK = '[?]';

export function isAssumption(note: string | null | undefined): boolean {
  return (note ?? '').trimStart().startsWith(ASSUMPTION_MARK);
}

export function stripAssumption(note: string | null | undefined): string {
  const raw = (note ?? '').trim();
  return raw.startsWith(ASSUMPTION_MARK) ? raw.slice(ASSUMPTION_MARK.length).trim() : raw;
}

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

/**
 * Одна строка дневника: «Кормление, грудь, 15 мин».
 *
 * Свёрнутая лента читается глазами сверху вниз, поэтому здесь важна краткость,
 * а не полнота: подробности человек получает, развернув строку.
 */
export function summaryLine(e: TrackerEvent): string {
  const lines = describeEvent(e);

  // Измерения читаются естественнее без слова «Измерение»: «Вес 4,62 кг».
  if (e.type === 'measure') {
    const what =
      { weight: 'Вес', height: 'Рост', head: 'Окружность головы', temp: 'Температура' }[
        e.subtype ?? ''
      ] ?? 'Измерение';
    return [what, ...lines.parts].join(' ');
  }

  if (e.type === 'note') {
    const text = stripAssumption(e.note);
    return text ? `Заметка: ${text}` : 'Заметка';
  }

  if (e.type === 'meds') {
    return [e.subtype || 'Лекарство', ...lines.parts].join(', ');
  }

  const bits = [lines.title];
  if (lines.sub) bits.push(lines.sub);
  for (const p of lines.parts) bits.push(p);
  if (lines.open) bits.push('идёт');
  return bits.join(', ');
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

  // Префикс [?] — служебная пометка модели, человеку её показывать не надо.
  if (isAssumption(note)) note = stripAssumption(note) || null;

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
