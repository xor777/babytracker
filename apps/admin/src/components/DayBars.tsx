import type { NormRange } from '../types';
import { formatDayShort, localDateKey, parseTs, plural } from '../lib/format';

export interface BarDay {
  date: string;
  /**
   * `null` — за эти сутки такого не записывали. Это НЕ ноль: столбца нет,
   * и на его месте стоит штриховка «данных нет».
   */
  primary: number | null;
  /**
   * Второй ряд — НЕ стопкой, а отметкой на своей высоте.
   *
   * Складывать мокрые с грязными нельзя: подгузник, который был и мокрым, и
   * грязным, честно посчитан в обоих рядах, и столбик их суммы показал бы
   * подгузников больше, чем сменили. Ряды независимы, шкала у них общая —
   * значит второй ряд это метка, а не этаж.
   */
  marker?: number | null;
}

interface Props {
  days: BarDay[];
  norm?: NormRange | null;
  tone: string;
  toneSecondary?: string;
  /** Как подписать значение в подсказке. */
  unit?: string;
  /** Пересчёт значения для подписи (минуты → часы). */
  format?: (v: number) => string;
  /** Как назвать второй ряд в подсказке. */
  markerLabel?: string;
  /** Пояснить штриховку под графиком. На странице это нужно один раз, а не у каждой карточки. */
  gapNote?: boolean;
}

/**
 * Столбцы по дням.
 *
 * Три состояния суток, и все три обязаны выглядеть по-разному:
 *
 * - **есть значение** — столбец;
 * - **записано, но ноль** — чёрточка на нуле. Ноль у записанных суток это
 *   факт, и пустое место вместо него читалось бы как пробел в дневнике;
 * - **не записано** — штриховка во всю высоту. Не ноль, не пусто: «мы не
 *   знаем». Ради этой разницы график и переделан.
 *
 * Свёрстано дивами: при 14–30 днях на 350 px столбец занимает 10–20 px, и важно,
 * чтобы он не съезжал на доли пикселя вместе с viewBox. Сегодняшний день помечен
 * отдельно — сутки ещё не закончились, и сравнивать его с прошедшими нечестно.
 */
export function DayBars({
  days: input,
  norm,
  tone,
  toneSecondary,
  unit,
  format,
  markerLabel,
  gapNote,
}: Props) {
  if (input.length === 0) return <p className="chart-empty">Данных за период пока нет.</p>;

  // Сводка приходит от свежих к старым, а время на графике всегда течёт вправо.
  const days = [...input].sort((a, b) => a.date.localeCompare(b.date));

  const todayKey = localDateKey(Date.now());
  const totals = days.map((d) => Math.max(d.primary ?? 0, d.marker ?? 0));
  const normTop = norm?.max ?? norm?.min ?? 0;
  const max = Math.max(1, ...totals, normTop) * 1.15;
  const gaps = days.filter((d) => d.primary == null).length;

  const pct = (v: number) => `${(v / max) * 100}%`;
  const label = (v: number) => (format ? format(v) : `${v}${unit ? ` ${unit}` : ''}`);

  /*
   * Ориентир с обеими границами (8–12 кормлений) — это полоса.
   * Ориентир «6 и больше» полосой рисовать нельзя: у него нет верха, и заливка
   * от 6 до потолка закрашивает весь график, превращая подсказку в помеху.
   * Для него — одна пунктирная черта порога.
   */
  const bandLo = norm?.min ?? null;
  const bandHi = norm?.max ?? null;
  const threshold = bandLo != null && bandHi == null ? bandLo : null;

  return (
    <div className="bars">
      <div className="bars__plot">
        {bandLo != null && bandHi != null ? (
          <div
            className="bars__band"
            style={{
              bottom: pct(bandLo),
              height: pct(Math.max(0, bandHi - bandLo)),
              color: tone,
            }}
            aria-hidden="true"
          />
        ) : null}
        {threshold != null ? (
          <div className="bars__line" style={{ bottom: pct(threshold), color: tone }} aria-hidden="true" />
        ) : null}

        {days.map((d) => {
          const isToday = d.date === todayKey;
          const when = formatDayShort(parseTs(`${d.date}T12:00:00`) ?? Date.now());
          const missing = d.primary == null;
          const total = (d.primary ?? 0) + (d.marker ?? 0);

          return (
            <div
              key={d.date}
              className={isToday ? 'bars__col bars__col--today' : 'bars__col'}
              title={
                missing
                  ? `${when}: записей нет`
                  : `${when}: ${label(d.primary ?? 0)}${
                      d.marker != null ? `, ${markerLabel ?? 'второй ряд'} ${label(d.marker)}` : ''
                    }${isToday ? ' (сутки ещё идут)' : ''}`
              }
            >
              {missing ? (
                <div className="bars__gap" aria-hidden="true" />
              ) : (
                <>
                  {d.primary && d.primary > 0 ? (
                    <div className="bars__fill" style={{ height: pct(d.primary), background: tone }} />
                  ) : null}
                  {/* Записали, а за сутки — ни одного: это настоящий ноль, и он
                      обязан быть виден. Пустое место на его месте читалось бы
                      как «не записывали», то есть как совсем другое утверждение. */}
                  {total === 0 ? (
                    <div className="bars__zero" style={{ background: tone }} aria-hidden="true" />
                  ) : null}
                  {d.marker != null && d.marker > 0 ? (
                    <div
                      className="bars__marker"
                      style={{ bottom: pct(d.marker), background: toneSecondary ?? tone }}
                      aria-hidden="true"
                    />
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="bars__axis">
        <span>{formatDayShort(parseTs(`${days[0].date}T12:00:00`) ?? Date.now())}</span>
        {norm?.min != null ? (
          <span className="bars__bandnote">
            {threshold != null
              ? `ориентир AAP ${norm.min}+`
              : `ориентир AAP ${norm.min}–${norm.max}`}
          </span>
        ) : null}
        <span>
          {days[days.length - 1].date === todayKey
            ? 'сегодня'
            : formatDayShort(parseTs(`${days[days.length - 1].date}T12:00:00`) ?? Date.now())}
        </span>
      </div>

      {gapNote && gaps > 0 ? (
        <p className="bars__gapnote">
          Штриховкой — {gaps} {plural(gaps, 'сутки', 'суток', 'суток')} без записей. Это пробел
          в дневнике, а не ноль. Чёрточка на нуле — записывали, но за сутки ни одного.
        </p>
      ) : null}
    </div>
  );
}
