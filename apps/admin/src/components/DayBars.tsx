import type { NormRange } from '../types';
import { formatDayShort, localDateKey, parseTs, plural } from '../lib/format';

export interface BarDay {
  date: string;
  /**
   * `null` — за эти сутки такого не записывали. Это НЕ ноль: столбца нет,
   * и на его месте стоит штриховка «данных нет».
   */
  primary: number | null;
}

interface Props {
  days: BarDay[];
  norm?: NormRange | null;
  tone: string;
  /** Как подписать значение в подсказке. */
  unit?: string;
  /** Пересчёт значения для подписи (минуты → часы). */
  format?: (v: number) => string;
  /**
   * О чём этот график, в предложном падеже: «о кормлении», «о сне».
   *
   * Обязателен: штриховка означает «нет записей ЭТОГО рода», а не «нет записей
   * вовсе», — и подпись, умолчавшая про род, отправляет врача сверять пробелы
   * с карточкой полноты, где суток без записей совсем другое число.
   */
  kind: string;
  /** Пояснить штриховку под графиком. */
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
export function DayBars({ days: input, norm, tone, unit, format, kind, gapNote }: Props) {
  if (input.length === 0) return <p className="chart-empty">Данных за период пока нет.</p>;

  // Сводка приходит от свежих к старым, а время на графике всегда течёт вправо.
  const days = [...input].sort((a, b) => a.date.localeCompare(b.date));

  const todayKey = localDateKey(Date.now());
  const totals = days.map((d) => d.primary ?? 0);
  const normTop = norm?.max ?? norm?.min ?? 0;
  const max = Math.max(1, ...totals, normTop) * 1.15;
  const gaps = days.filter((d) => d.primary == null).length;
  // Чёрточку на нуле поясняем, только когда она на экране есть. Легенда,
  // описывающая знак, которого не нарисовано, заставляет его искать.
  const zeros = days.filter((d) => d.primary === 0).length;

  const pct = (v: number) => `${(v / max) * 100}%`;
  const label = (v: number) => (format ? format(v) : `${v}${unit ? ` ${unit}` : ''}`);

  /*
   * Ориентир с обеими границами (8–12 кормлений) — это полоса.
   * Ориентир вида «столько и больше» полосой рисовать нельзя: у него нет верха,
   * и заливка до потолка закрашивает весь график, превращая подсказку в помеху.
   * Для него — одна пунктирная черта порога. (Подгузники с их «6+» живут теперь
   * в DiaperDots: там знаки штучные, и черта ложится под шестой знак.)
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
          const total = d.primary ?? 0;

          return (
            <div
              key={d.date}
              className={isToday ? 'bars__col bars__col--today' : 'bars__col'}
              title={
                missing
                  ? `${when}: записей ${kind} нет`
                  : `${when}: ${label(d.primary ?? 0)}${isToday ? ' (сутки ещё идут)' : ''}`
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
          Штриховкой — {gaps} {plural(gaps, 'сутки', 'суток', 'суток')} без записей {kind}. Это
          пробел в дневнике, а не ноль.
          {zeros > 0 ? ' Чёрточка на нуле — записывали, но за сутки ни одного.' : ''}
        </p>
      ) : null}
    </div>
  );
}
