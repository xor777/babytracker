const HOUR = 3_600_000;
const MINUTE = 60_000;

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const clockFmt = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

export function parseTs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** «21:04» */
export function formatTime(value: number | string | null | undefined): string {
  const ms = typeof value === 'number' ? value : parseTs(value);
  if (ms == null) return '--:--';
  return timeFmt.format(new Date(ms));
}

/** «21:04:37» */
export function formatClock(ms: number): string {
  return clockFmt.format(new Date(ms));
}

/** «вторник, 15 сентября» */
export function formatDate(ms: number): string {
  return dateFmt.format(new Date(ms));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** «02:47:13» — тикающий таймер. Часы не обрезаем, если их больше 99 (не наш случай). */
export function formatStopwatch(ms: number): { hm: string; sec: string } {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return { hm: `${pad2(h)}:${pad2(m)}`, sec: pad2(s) };
}

/** Разбитая на части длительность для крупной вёрстки: 7 ч 10 м */
export interface SplitDuration {
  h: string;
  m: string;
  showHours: boolean;
}

export function splitMinutes(min: number | null | undefined): SplitDuration {
  const total = Math.max(0, Math.round(min ?? 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return { h: String(h), m: h > 0 ? pad2(m) : String(m), showHours: h > 0 };
}

/** «7 ч 10 м» одной строкой */
export function formatMinutes(min: number | null | undefined): string {
  const { h, m, showHours } = splitMinutes(min);
  return showHours ? `${h} ч ${m} м` : `${m} м`;
}

export function formatDurationMs(ms: number): string {
  return formatMinutes(Math.round(ms / MINUTE));
}

/** Склонение: 198 суток / 201 сутки */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export { HOUR, MINUTE };
