import { formatSignedGrams, plural } from '../lib/format';
import type { WeekStats } from '../lib/summary';

interface Props {
  weeks: WeekStats[];
}

/**
 * Прибавка веса по неделям — **в граммах в сутки**, а не всей разницей.
 *
 * Это не придирка к единицам, а условие, без которого столбики нельзя ставить
 * рядом. Взвешивают не по расписанию: у одной недели разница набрана за шесть
 * суток, у другой — за двенадцать (см. weekStats в lib/summary.ts, точка
 * отсчёта — последнее взвешивание ДО недели). Нарисуй мы сырые граммы,
 * двенадцатисуточный столбик оказался бы вдвое выше шестисуточного при
 * одинаковом темпе роста, и глаз прочитал бы это как «рос вдвое быстрее».
 * Деление на срок приводит все недели к одной мерке.
 *
 * Ноль здесь — настоящая граница, а не край шкалы: по одну сторону набрал,
 * по другую потерял, и первые недели жизни проходят именно по нижней. Поэтому
 * столбики растут от нулевой линии в обе стороны, и потеря рисуется вниз.
 *
 * Остальным величинам такого спарклайна не полагается: у кормлений, подгузников
 * и сна ноль недостижим и ничего не разделяет, столбики от нуля вышли бы
 * плоским забором, а обрезать шкалу снизу — значит показать рост на четверть
 * как рост втрое.
 */
export function WeekGain({ weeks }: Props) {
  const perDay = weeks.map((w) =>
    w.weightDeltaG != null && w.weightSpanDays ? w.weightDeltaG / w.weightSpanDays : null,
  );

  const known = perDay.filter((v): v is number => v != null);
  if (known.length === 0) return null;

  const up = Math.max(0, ...known);
  const down = Math.max(0, ...known.map((v) => -v));
  const span = up + down || 1;
  // Доля высоты над нулём. При одних приростах ноль ложится на дно, при одних
  // потерях — на верх, и отдельных случаев для этого не нужно.
  const zero = (up / span) * 100;

  // Последняя неделя, где прибавку вообще удалось посчитать: показывать
  // крупно нечего, если она пришлась на пробел в записях.
  let lastIndex = -1;
  perDay.forEach((v, i) => {
    if (v != null) lastIndex = i;
  });
  const last = weeks[lastIndex];

  return (
    <div className="gain">
      <div className="gain__head">
        <span className="gain__name">прибавка веса</span>
        <span className="gain__value">
          {formatSignedGrams(perDay[lastIndex])}
          <span className="gain__unit">в сутки</span>
        </span>
      </div>
      {last?.weightSpanDays ? (
        <p className="gain__note">
          в последнюю неделю с записями — по двум взвешиваниям за{' '}
          {last.weightSpanDays} {plural(last.weightSpanDays, 'сутки', 'суток', 'суток')}
        </p>
      ) : null}

      <div className="gain__plot">
        {perDay.map((v, i) => (
          <div className="gain__col" key={weeks[i].week.index}>
            {v == null ? (
              <i className="gain__gap" />
            ) : (
              <i
                className="gain__bar"
                style={{
                  // Минимум в два пикселя: столбик, который не видно, читается
                  // как «взвешиваний не было», а это другое утверждение.
                  height: `${Math.max(2, (Math.abs(v) / span) * 100)}%`,
                  top: v >= 0 ? `calc(${zero}% - ${Math.max(2, (Math.abs(v) / span) * 100)}%)` : `${zero}%`,
                }}
              />
            )}
          </div>
        ))}
        <div className="gain__zero" style={{ top: `${zero}%` }} aria-hidden="true" />
      </div>

      <div className="gain__axis">
        <span>{weeks[0]?.week.label}</span>
        <span>{weeks[weeks.length - 1]?.week.label}</span>
      </div>
      {perDay.some((v) => v == null) ? (
        <p className="gain__note">
          Штриховкой — недели, где взвешиваний не было или было одно. Это пробел
          в записях, а не отсутствие прибавки.
        </p>
      ) : null}
    </div>
  );
}
