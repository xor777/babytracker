import { formatDay, plural } from '../lib/format';
import type { Coverage } from '../lib/summary';

interface Props {
  coverage: Coverage;
  /** Лента событий упёрлась в лимит: часть окна мы просто не видели. */
  truncated?: boolean;
  /** Лента событий не загрузилась вовсе. */
  unknownAll?: boolean;
}

/**
 * Полнота дневника — первое, что должно попасться на глаза.
 *
 * Всё остальное на странице зависит от этой карточки. «В среднем 6 подгузников
 * в сутки» означает разное, если за спиной четырнадцать суток записей и если за
 * спиной двое. Врач не обязан догадываться, какой из двух случаев перед ним, и
 * уж тем более не должен выяснять это, не найдя подвоха.
 *
 * Оценки здесь нет: ни «мало записей», ни «хорошо ведёте». Есть счёт суток и
 * полоса, на которой видно, где именно пробелы — в начале, вразброс или вчера.
 * Что из этого значимо, решает врач.
 */
export function CoverageStrip({ coverage: c, truncated, unknownAll }: Props) {
  if (c.total === 0) return null;

  const { recorded, blank, unknown, total } = c;

  return (
    <section className="card card--wide">
      <div className="card__head">
        <h2 className="card__title">Полнота дневника</h2>
        <span className="card__aside">
          {recorded} из {total} {plural(total, 'суток', 'суток', 'суток')}
        </span>
      </div>

      <div
        className="cover__strip"
        role="img"
        aria-label={`Записи есть за ${recorded} суток из ${total}${
          unknown > 0 ? `, ещё ${unknown} неизвестны` : ''
        }`}
      >
        {c.cells.map((cell) => (
          <span
            key={cell.date}
            className="cover__cell"
            data-state={cell.recorded === null ? 'unknown' : cell.recorded ? 'on' : 'off'}
            data-today={cell.today ? 'yes' : undefined}
            title={
              cell.recorded === null
                ? `${cell.date}: неизвестно`
                : `${cell.date}: ${cell.recorded ? 'записи есть' : 'записей нет'}`
            }
          />
        ))}
      </div>

      <p className="cover__text">
        {unknownAll ? (
          <>
            Лента записей сейчас недоступна, поэтому проверить полноту дневника не по чему.
            Числа ниже посчитаны по тому, что прислал сервер.
          </>
        ) : blank === 0 && unknown === 0 ? (
          <>
            Записи есть за каждые сутки периода: все {total}{' '}
            {plural(total, 'сутки', 'суток', 'суток')} из {total}.
          </>
        ) : (
          <>
            За {blank} {plural(blank, 'сутки', 'суток', 'суток')} периода в дневнике нет ни
            одной записи
            {c.firstRecordedDate ? <> — первая запись {formatDayShort(c.firstRecordedDate)}</> : null}.
            Это пробел в записях, а не сведения о ребёнке: средние ниже посчитаны только по
            суткам с записями, и рядом с каждым написано, по скольким.
          </>
        )}
        {truncated ? (
          <>
            {' '}
            Часть периода за пределами выгрузки — такие сутки на полосе отмечены как
            неизвестные.
          </>
        ) : null}
      </p>

      <div className="cover__legend">
        <span className="cover__key" data-state="on" /> записи есть
        <span className="cover__key" data-state="off" /> записей нет
        {unknown > 0 ? (
          <>
            <span className="cover__key" data-state="unknown" /> неизвестно
          </>
        ) : null}
      </div>
    </section>
  );
}

/** «15 сентября» из ключа YYYY-MM-DD, без ухода в UTC. */
function formatDayShort(date: string): string {
  const ms = Date.parse(`${date}T12:00:00`);
  return Number.isFinite(ms) ? formatDay(ms) : date;
}
