import type { NormRange } from '../types';
import type { DiaperMarks } from '../lib/summary';
import { formatDayShort, localDateKey, parseTs, plural } from '../lib/format';

export interface DiaperDay {
  date: string;
  /**
   * Кучки за сутки, уже непересекающиеся (`diaperMarks`).
   *
   * `null` — **подгузников за эти сутки не записано**, и рисуется штриховка.
   * Раньше здесь было два признака, `marks` и отдельный `blank` («за сутки нет
   * ни одной записи вообще»), и сутки, в которые записали только взвешивание,
   * получали чёрточку нуля: экран утверждал «сменили ноль подгузников» там, где
   * их просто не записывали. Признак один, потому что и вопрос один.
   */
  marks: DiaperMarks | null;
}

interface Props {
  days: DiaperDay[];
  /** Ориентир «6+ мокрых» — подписанный референс, а не оценка. */
  norm?: NormRange | null;
  /** Пояснить штриховку под графиком. */
  gapNote?: boolean;
}

/** Через каждые пять — зазор. «Пять и ещё два» читается без счёта, «семь» — нет. */
const GROUP = 5;

/**
 * Подгузники по дням: **точка на каждый подгузник**.
 *
 * Было — столбец мокрых и чёрточка грязных поверх него. Заказчик на это и
 * пожаловался: «неудобно в воображении делить столбец на сектора и просто
 * взглядом не посчитать, приходится наводить». Столбец показывает длину, а
 * врачу нужно число, и он вынужден мерить высоту на глаз.
 *
 * Здесь считать нечего: сколько подгузников сменили, столько и знаков.
 *
 * ## Почему не стопка
 *
 * Подгузник бывает и мокрым, и грязным сразу. Сервер честно кладёт такой в оба
 * ряда (`wet` и `dirty`), поэтому `wet + dirty` больше, чем подгузников сменили,
 * и обычная стопка нарисовала бы подгузников больше, чем было. `diaperMarks`
 * раскладывает ряды на непересекающиеся кучки, и здесь у каждого подгузника
 * ровно один знак — в том числе у двойного, у него свой.
 *
 * ## Как это читается
 *
 * Знаки лежат снизу вверх: сперва только мокрые, потом двойные, потом только
 * грязные. Порядок не косметический — он делает оба ответа непрерывными
 * отрезками:
 *
 * - **мокрые** = всё зелёное снизу, включая двойные (нижняя половина двойного
 *   зелёная, и отрезок не разрывается);
 * - **грязные** = всё оранжевое сверху, включая те же двойные.
 *
 * Двойной знак лежит на стыке и входит в оба отрезка — ровно то, что он значит.
 * Ориентир «6+» — черта в зазоре под шестым знаком: дотянулся столбик знаков до
 * неё или нет, видно без счёта и без наведения.
 */
export function DiaperDots({ days: input, norm, gapNote }: Props) {
  if (input.length === 0) return <p className="chart-empty">Данных за период пока нет.</p>;

  // Сводка приходит от свежих к старым, а время на графике всегда течёт вправо.
  const days = [...input].sort((a, b) => a.date.localeCompare(b.date));
  const todayKey = localDateKey(Date.now());
  const gaps = days.filter((d) => d.marks == null).length;
  const zeros = days.filter((d) => d.marks != null && d.marks.total === 0).length;

  const maxTotal = Math.max(0, ...days.map((d) => d.marks?.total ?? 0));
  const normMin = norm?.min ?? 0;
  // Рядов столько, чтобы влез и самый плодовитый день, и ориентир с запасом сверху.
  const rows = Math.max(4, maxTotal, normMin + 1);

  /*
   * Размер знака — от числа суток на экране, а не от ширины: столбцы тянутся
   * флексом, и на месяце их вдвое больше, чем на неделе. Дальше шаг ужимается
   * ещё раз, если у кого-то за сутки десяток подгузников: у новорождённого
   * так бывает, и график не имеет права из-за этого уехать за карточку.
   */
  const dense = days.length > 22 ? 2 : days.length > 16 ? 1 : 0;
  const basePitch = [12, 9.5, 8][dense];
  const baseGroupGap = [4, 3, 2.5][dense];
  const MAX_H = 158;
  const groups = Math.floor((rows - 1) / GROUP);
  const pitch = Math.min(basePitch, (MAX_H - groups * baseGroupGap) / rows);
  const groupGap = baseGroupGap * (pitch / basePitch);
  const dot = Math.max(3.5, pitch * 0.74);

  /** Нижний край знака номер `i` (снизу вверх, с нуля), считая зазоры пятёрок. */
  const base = (i: number) => i * pitch + Math.floor(i / GROUP) * groupGap;
  const height = base(rows - 1) + dot + pitch * 0.4;

  /*
   * Черта ориентира — не «на высоте шесть», а в зазоре ПОД шестым знаком.
   * Тогда «6 и больше» = «знаки перешагнули черту», без пересчёта делений.
   */
  const lineY =
    normMin >= 2
      ? (base(normMin - 2) + dot + base(normMin - 1)) / 2
      : Math.max(0, -(pitch - dot) / 2);

  return (
    <div className="dots">
      <div className="dots__plot" style={{ height }}>
        {normMin > 0 ? (
          <div className="dots__line" style={{ bottom: lineY }} aria-hidden="true" />
        ) : null}

        {days.map((d) => {
          const isToday = d.date === todayKey;
          const when = formatDayShort(parseTs(`${d.date}T12:00:00`) ?? Date.now());

          return (
            <div
              key={d.date}
              className={isToday ? 'dots__col dots__col--today' : 'dots__col'}
              title={`${when}: ${dayTitle(d)}${isToday ? ' (сутки ещё идут)' : ''}`}
            >
              {d.marks == null ? (
                <div className="dots__hatch" aria-hidden="true" />
              ) : d.marks.total === 0 ? (
                // Записывали, а за сутки ни одного. Настоящий ноль, и он обязан
                // быть виден: пустое место на его месте читалось бы как пробел.
                <div className="dots__zero" aria-hidden="true" />
              ) : (
                glyphs(d.marks).map((kind, i) => {
                  // Квадрат при равной стороне выглядит крупнее круга — площадь
                  // больше в 4/π раз. Ужимаем, иначе грязные лезут вперёд мокрых
                  // не по делу, а по геометрии.
                  const size = kind === 'dirty' ? dot * 0.88 : dot;
                  return (
                    <span
                      key={i}
                      className={`dots__dot dots__dot--${kind}`}
                      style={{ bottom: base(i) + (dot - size) / 2, width: size, height: size }}
                      aria-hidden="true"
                    />
                  );
                })
              )}
            </div>
          );
        })}
      </div>

      <div className="dots__axis">
        <span>{formatDayShort(parseTs(`${days[0].date}T12:00:00`) ?? Date.now())}</span>
        {normMin > 0 ? <span className="dots__note">ориентир AAP {normMin}+ мокрых</span> : null}
        <span>
          {days[days.length - 1].date === todayKey
            ? 'сегодня'
            : formatDayShort(parseTs(`${days[days.length - 1].date}T12:00:00`) ?? Date.now())}
        </span>
      </div>

      <ul className="dots__legend">
        <li>
          <i className="dots__dot dots__dot--wet" aria-hidden="true" />
          мокрый
        </li>
        <li>
          <i className="dots__dot dots__dot--both" aria-hidden="true" />и мокрый, и грязный
        </li>
        <li>
          <i className="dots__dot dots__dot--dirty" aria-hidden="true" />
          грязный
        </li>
      </ul>

      {gapNote && gaps > 0 ? (
        <p className="dots__gapnote">
          Штриховкой — {gaps} {plural(gaps, 'сутки', 'суток', 'суток')} без записей о
          подгузниках. Это пробел в дневнике, а не ноль.
          {zeros > 0 ? ' Чёрточка на нуле — записывали, но за сутки ни одного.' : ''}
        </p>
      ) : null}
    </div>
  );
}

type Glyph = 'wet' | 'both' | 'dirty' | 'unknown';

/**
 * Знаки одних суток снизу вверх.
 *
 * Порядок — часть чтения, а не оформление: двойные стоят между мокрыми и
 * грязными, поэтому и зелёный отрезок снизу, и оранжевый сверху не разрываются.
 * Неразобранные — наверх: они ничего не утверждают и не должны рвать ни один
 * из двух отрезков.
 */
function glyphs(m: DiaperMarks): Glyph[] {
  return [
    ...Array<Glyph>(m.wetOnly).fill('wet'),
    ...Array<Glyph>(m.both).fill('both'),
    ...Array<Glyph>(m.dirtyOnly).fill('dirty'),
    ...Array<Glyph>(m.unknown).fill('unknown'),
  ];
}

/** Подсказка при наведении. Считать по ней не нужно — она для точных чисел. */
function dayTitle(d: DiaperDay): string {
  const m = d.marks;
  if (m == null) return 'записей о подгузниках нет';
  if (m.total === 0) return 'записывали, но за сутки ни одного';
  const parts = [
    `${m.wetOnly + m.both} ${plural(m.wetOnly + m.both, 'мокрый', 'мокрых', 'мокрых')}`,
    `${m.dirtyOnly + m.both} ${plural(m.dirtyOnly + m.both, 'грязный', 'грязных', 'грязных')}`,
  ];
  if (m.both > 0) parts.push(`${m.both} и то и другое сразу`);
  if (m.unknown > 0) parts.push(`${m.unknown} без подтипа`);
  return `${m.total} ${plural(m.total, 'подгузник', 'подгузника', 'подгузников')} — ${parts.join(', ')}`;
}
