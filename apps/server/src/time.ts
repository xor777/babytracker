/**
 * Работа со временем. В БД — только ISO 8601 UTC; таймзона применяется здесь,
 * на границе представления.
 *
 * Никакого Date-арифметического «а тут у нас локальное время» — все преобразования
 * civil <-> instant идут через Intl, поэтому переход на летнее время и смена
 * TZ-базы процесса ничего не ломают.
 */

export interface CivilParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Календарные компоненты момента `date` в таймзоне `tz`. */
export function zonedParts(date: Date, tz: string): CivilParts {
  const parts = partsFormatter(tz).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number.parseInt(found.value, 10) : 0;
  };
  const hour = pick('hour');
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    // некоторые ICU отдают 24 вместо 0 для полуночи
    hour: hour === 24 ? 0 : hour,
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** Смещение таймзоны (мс) в момент `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = zonedParts(new Date(utcMs), tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // округляем до секунды: в civil-частях миллисекунд нет
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Календарное время в таймзоне -> момент (UTC, мс).
 * Два прохода — чтобы корректно сесть на границе перевода часов.
 */
export function civilToUtcMs(civil: CivilParts, tz: string): number {
  const naive = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  );
  let guess = naive - tzOffsetMs(naive, tz);
  guess = naive - tzOffsetMs(guess, tz);
  return guess;
}

/** Локальная дата в формате YYYY-MM-DD. */
export function localDateISO(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Начало локальных суток `YYYY-MM-DD` как момент UTC (мс). */
export function localDayStartMs(dateISO: string, tz: string): number {
  const [y, m, d] = dateISO.split('-').map((s) => Number.parseInt(s, 10));
  return civilToUtcMs(
    { year: y ?? 1970, month: m ?? 1, day: d ?? 1, hour: 0, minute: 0, second: 0 },
    tz,
  );
}

/** Сдвиг локальной даты на `delta` суток (по календарю, без 86400000). */
export function shiftLocalDate(dateISO: string, delta: number): string {
  const [y, m, d] = dateISO.split('-').map((s) => Number.parseInt(s, 10));
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + delta * 86_400_000;
  const dt = new Date(t);
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Разница в целых сутках между двумя датами YYYY-MM-DD. */
export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Текущий момент в каноничном виде для БД. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Нормализация произвольной даты в ISO UTC; null если не парсится. */
export function toIsoUtc(value: string | number | Date): string | null {
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : d.toISOString();
}

/** Длительность в минутах между двумя ISO-метками (округление вниз). */
export function minutesBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 60_000));
}
