/**
 * Часовой пояс отображения.
 *
 * Сервер живёт в своей зоне (по контракту §8 — `TZ=Europe/Moscow`) и присылает
 * все метки в UTC, а телевизор запросто может быть настроен неверно: дешёвые
 * приставки нередко стоят в UTC из коробки. Тогда разъедется не только счётчик
 * суток, но и все показанные времена — «уснул в 16:12» вместо 19:12.
 *
 * Поэтому зона задаётся явно и чинится без пересборки: `?tz=Europe/Moscow`
 * в адресе или `VITE_TZ` на сборке. По умолчанию — зона устройства.
 */
// import.meta.env существует только под vite. Тесты гоняет сам node, и без
// осторожного доступа любой модуль, потянувший этот файл, падал бы там на
// чтении свойства у undefined.
const ENV_TZ = ((import.meta.env?.VITE_TZ as string | undefined) ?? '').trim();

function deviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function resolveTz(): { tz: string; explicit: boolean } {
  const fromQuery = new URLSearchParams(window.location.search).get('tz');
  const raw = (fromQuery ?? ENV_TZ).trim();
  if (!raw) return { tz: deviceTz(), explicit: false };
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: raw }).format(0);
    return { tz: raw, explicit: true };
  } catch {
    return { tz: deviceTz(), explicit: false };
  }
}

const resolved = resolveTz();

export const DISPLAY_TZ = resolved.tz;
/** true — зону задали явно (?tz= или VITE_TZ), а не взяли у устройства. */
export const TZ_IS_EXPLICIT = resolved.explicit;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Смещение зоны в мс для конкретного момента (учитывает переводы часов). */
function offsetAt(ms: number): number {
  const parts = partsFmt.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Кеш смещения: меняется только при переводе часов, считать каждый тик незачем. */
let cacheHour = NaN;
let cacheOffset = 0;

export function tzOffset(ms: number): number {
  const hour = Math.floor(ms / 3_600_000);
  if (hour !== cacheHour) {
    cacheHour = hour;
    cacheOffset = offsetAt(ms);
  }
  return cacheOffset;
}

/**
 * Дата, у которой UTC-поля равны локальным полям в зоне отображения.
 * Читать только через getUTC* — getHours() здесь соврёт.
 */
export function zoned(ms: number): Date {
  return new Date(ms + tzOffset(ms));
}

/** Локальная дата в зоне отображения, YYYY-MM-DD. */
export function zonedDateString(ms: number): string {
  const d = zoned(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function zonedHour(ms: number): number {
  return zoned(ms).getUTCHours();
}
