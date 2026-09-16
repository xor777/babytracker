/** Форматирование дат и чисел. Всё, что видит человек, — в локальной таймзоне браузера. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dayShortFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const secFmt = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function parseTs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** «21:04» */
export function formatTime(value: string | number | null | undefined): string {
  const ms = typeof value === 'number' ? value : parseTs(value);
  if (ms == null) return '--:--';
  return timeFmt.format(new Date(ms));
}

/** «15 сентября» */
export function formatDay(ms: number): string {
  return dayFmt.format(new Date(ms));
}

/** «15 сен» */
export function formatDayShort(ms: number): string {
  return dayShortFmt.format(new Date(ms));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** «7 ч 10 мин» / «40 мин» */
export function formatMinutes(min: number | null | undefined): string {
  const total = Math.max(0, Math.round(min ?? 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} мин`;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

export function durationMin(from: string | null | undefined, to: string | null | undefined) {
  const a = parseTs(from);
  const b = parseTs(to);
  if (a == null || b == null) return null;
  return Math.max(0, Math.round((b - a) / MINUTE));
}

/** Локальная календарная дата в формате YYYY-MM-DD — ключ группировки ленты. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Полночь локального дня, к которому относится метка. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** «сегодня» / «вчера» / «15 сентября» — заголовок дня в ленте. */
export function dayTitle(ms: number, now = Date.now()): string {
  const diff = Math.round((startOfLocalDay(now) - startOfLocalDay(ms)) / DAY);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'вчера';
  if (diff === 2) return 'позавчера';
  return formatDay(ms);
}

/** Момент → значение для <input type="datetime-local"> в локальной зоне, с точностью до минуты. */
export function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** ISO UTC → значение для <input type="datetime-local"> в локальной зоне. */
export function isoToLocalInput(iso: string | null | undefined): string {
  const ms = parseTs(iso);
  if (ms == null) return '';
  return msToLocalInput(ms);
}

/** Обратно: значение инпута (локальное время) → ISO UTC для БД (§1). */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** 6820 → «6,82 кг». На входе всегда граммы: приводить единицы — забота вызывающего. */
export function formatWeight(grams: number | null | undefined): string {
  if (grams == null) return '—';
  return `${(grams / 1000).toFixed(2).replace('.', ',')} кг`;
}

/** То же, но мелкие величины (привес за неделю) читаются в граммах. */
export function formatGrams(grams: number | null | undefined): string {
  if (grams == null) return '—';
  if (Math.abs(grams) < 1000) return `${Math.round(grams)} г`;
  return formatWeight(grams);
}

/**
 * «13:05» / «13 сен, 13:05» — когда одного времени мало.
 * `withSeconds` показывает секунды: в редакторе важно видеть, что на самом деле в БД,
 * потому что инпут времени их не показывает.
 */
export function formatWhen(
  value: string | number | null | undefined,
  withSeconds = false,
): string {
  const ms = typeof value === 'number' ? value : parseTs(value);
  if (ms == null) return '--:--';
  const clock = withSeconds ? secFmt.format(new Date(ms)) : formatTime(ms);
  const sameDay = startOfLocalDay(ms) === startOfLocalDay(Date.now());
  return sameDay ? clock : `${formatDayShort(ms)}, ${clock}`;
}

/** «14,5 ч» — компактно для плиток, где «14 ч 32 мин» не помещается. */
export function formatHours(min: number | null | undefined): string {
  const total = Math.max(0, Math.round(min ?? 0));
  if (total < 60) return `${total} мин`;
  const h = total / 60;
  return `${h.toFixed(1).replace('.', ',')} ч`;
}

/** «1:23» + отдельные секунды — для тикающего таймера текущего состояния. */
export function splitStopwatch(ms: number): { hm: string; sec: string } {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return { hm: h > 0 ? `${h}:${pad2(m)}` : String(m), sec: pad2(s) };
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits).replace('.', ',');
}
