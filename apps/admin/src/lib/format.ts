/** Форматирование дат и чисел. Всё, что видит человек, — в локальной таймзоне браузера. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dayShortFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const weekdayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });

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

export function formatWeekday(ms: number): string {
  return weekdayFmt.format(new Date(ms));
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

/** ISO UTC → значение для <input type="datetime-local"> в локальной зоне. */
export function isoToLocalInput(iso: string | null | undefined): string {
  const ms = parseTs(iso);
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Обратно: значение инпута (локальное время) → ISO UTC для БД (§1). */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** YYYY-MM-DD (значение <input type="date">) → границы суток в ISO UTC. */
export function dateKeyToRange(key: string): { from: string; to: string } | null {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return null;
  const from = new Date(y, m - 1, d, 0, 0, 0, 0);
  const to = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
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

/** «сегодня 13:05» / «13 сен 13:05» — когда одного времени мало. */
export function formatWhen(value: string | number | null | undefined): string {
  const ms = typeof value === 'number' ? value : parseTs(value);
  if (ms == null) return '--:--';
  const sameDay = startOfLocalDay(ms) === startOfLocalDay(Date.now());
  return sameDay ? formatTime(ms) : `${formatDayShort(ms)}, ${formatTime(ms)}`;
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits).replace('.', ',');
}
