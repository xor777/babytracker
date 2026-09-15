/**
 * Русское форматирование: склонения, длительности, время.
 * Всё чистые функции — покрыто юнит-тестами.
 */

import { zonedParts, pad2, localDateISO } from './time.ts';

export type PluralForms = readonly [one: string, few: string, many: string];

export const MINUTES: PluralForms = ['минута', 'минуты', 'минут'];
export const MINUTES_ACC: PluralForms = ['минуту', 'минуты', 'минут'];
export const HOURS: PluralForms = ['час', 'часа', 'часов'];
export const DAYS: PluralForms = ['день', 'дня', 'дней'];
export const TIMES: PluralForms = ['раз', 'раза', 'раз'];
export const SLEEPS: PluralForms = ['сон', 'сна', 'снов'];
export const PHRASES: PluralForms = ['фраза', 'фразы', 'фраз'];

/**
 * Выбор формы слова по числу.
 *   1, 21, 101 -> one
 *   2..4, 22..24 -> few
 *   0, 5..20, 11..14 -> many
 */
export function pluralRu(n: number, forms: PluralForms): string {
  const abs = Math.abs(Math.trunc(n));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  const mod10 = abs % 10;
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

/** «5 минут», «21 час», «3 дня». */
export function withUnit(n: number, forms: PluralForms): string {
  return `${n} ${pluralRu(n, forms)}`;
}

/**
 * Длительность словами: «1 час 35 минут», «45 минут», «2 часа», «меньше минуты».
 * Вход — минуты (может быть дробным, округляем).
 */
/**
 * Приводит вход к неотрицательному целому числу минут.
 * Math.max(0, NaN) возвращает NaN, поэтому без явной проверки не-конечное
 * значение проходило все ветки и превращалось в пустую строку — Алиса
 * произносила «Спал » с дырой вместо длительности. Бесконечность давала
 * «Infinity часов». Для речи безопаснее отступить к нулю.
 */
function safeMinutes(totalMinutes: number): number {
  if (!Number.isFinite(totalMinutes)) return 0;
  return Math.max(0, Math.round(totalMinutes));
}

export function formatDurationRu(totalMinutes: number): string {
  const total = safeMinutes(totalMinutes);
  if (total === 0) return 'меньше минуты';

  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(withUnit(hours, HOURS));
  if (minutes > 0) parts.push(withUnit(minutes, MINUTES));
  return parts.join(' ');
}

/**
 * Та же длительность в винительном падеже — для конструкций «спал ...», «спит ...».
 * По-русски «спал 1 минуту», а не «спал 1 минута»; часы в винительном совпадают
 * с именительным, поэтому меняются только минуты.
 */
export function formatDurationRuAcc(totalMinutes: number): string {
  const total = safeMinutes(totalMinutes);
  if (total === 0) return 'меньше минуты';

  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(withUnit(hours, HOURS));
  if (minutes > 0) parts.push(withUnit(minutes, MINUTES_ACC));
  return parts.join(' ');
}

/** Короткий цифровой вид длительности: «1:35», «0:45». */
export function formatDurationShort(totalMinutes: number): string {
  const total = safeMinutes(totalMinutes);
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

/** Локальное время «17:32». */
export function formatTimeLocal(iso: string | Date, tz: string): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  const p = zonedParts(date, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

const MONTHS_GEN = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** Локальная дата «15 сентября». */
export function formatDateLocal(iso: string | Date, tz: string): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const p = zonedParts(date, tz);
  return `${p.day} ${MONTHS_GEN[p.month - 1] ?? ''}`.trim();
}

/** Локальные дата и время «15 сентября, 17:32». */
export function formatDateTimeLocal(iso: string | Date, tz: string): string {
  return `${formatDateLocal(iso, tz)}, ${formatTimeLocal(iso, tz)}`;
}

/** Локальная дата в ISO (YYYY-MM-DD) — реэкспорт, чтобы слой представления знал один модуль. */
export { localDateISO };
