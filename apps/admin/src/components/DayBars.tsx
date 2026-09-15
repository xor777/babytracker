import type { NormRange } from '../types';
import { formatDayShort, localDateKey, parseTs } from '../lib/format';

export interface BarDay {
  date: string;
  primary: number;
  /** Второй ряд поверх первого (грязные подгузники поверх мокрых). */
  secondary?: number;
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
}

/**
 * Столбцы по дням с полосой ориентира на фоне.
 *
 * Свёрстано дивами: при 14–30 днях на 350 px столбец занимает 10–20 px, и важно,
 * чтобы он не съезжал на доли пикселя вместе с viewBox. Сегодняшний день помечен
 * отдельно — сутки ещё не закончились, и сравнивать его с прошедшими нечестно.
 */
export function DayBars({ days: input, norm, tone, toneSecondary, unit, format }: Props) {
  if (input.length === 0) return <p className="chart-empty">Данных за период пока нет.</p>;

  // Сводка приходит от свежих к старым, а время на графике всегда течёт вправо.
  const days = [...input].sort((a, b) => a.date.localeCompare(b.date));

  const todayKey = localDateKey(Date.now());
  const totals = days.map((d) => d.primary + (d.secondary ?? 0));
  const normTop = norm?.max ?? norm?.min ?? 0;
  const max = Math.max(1, ...totals, normTop) * 1.15;

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
          const total = d.primary + (d.secondary ?? 0);
          return (
            <div
              key={d.date}
              className={isToday ? 'bars__col bars__col--today' : 'bars__col'}
              title={`${formatDayShort(parseTs(`${d.date}T12:00:00`) ?? Date.now())}: ${label(total)}${
                isToday ? ' (сутки ещё идут)' : ''
              }`}
            >
              {d.secondary ? (
                <div
                  className="bars__fill"
                  style={{ height: pct(d.secondary), background: toneSecondary ?? tone, opacity: 0.55 }}
                />
              ) : null}
              {/* Ноль рисуем нулём: полоска в два пикселя на пустом дне читается
                  как «что-то было», а не было ничего. */}
              {d.primary > 0 ? (
                <div className="bars__fill" style={{ height: pct(d.primary), background: tone }} />
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="bars__axis">
        <span>{formatDayShort(parseTs(`${days[0].date}T12:00:00`) ?? Date.now())}</span>
        {norm?.min != null ? (
          <span className="bars__bandnote">
            {threshold != null
              ? `черта — ориентир ${norm.min}+`
              : `полоса — ориентир ${norm.min}–${norm.max}`}
          </span>
        ) : null}
        <span>
          {days[days.length - 1].date === todayKey
            ? 'сегодня'
            : formatDayShort(parseTs(`${days[days.length - 1].date}T12:00:00`) ?? Date.now())}
        </span>
      </div>
    </div>
  );
}
