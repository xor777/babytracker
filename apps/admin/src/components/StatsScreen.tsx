import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { periodsForAge, useChild, useStats } from '../hooks/useStats';
import {
  averagePerDay,
  feedGapFacts,
  observationFacts,
  observationPhrase,
  sleepFacts,
  weekStats,
} from '../lib/summary';
import type { Avg, DayCell, ObservationFacts } from '../lib/summary';
import { stateSubtypes, subtypeAccusative } from '../lib/taxonomy';
import {
  formatDay,
  formatDayShort,
  formatHours,
  formatMinutes,
  formatNumber,
  formatPerDay,
  formatSignedGrams,
  formatTime,
  formatWeight,
  plural,
} from '../lib/format';
import { CoverageStrip } from './CoverageStrip';
import { WeightChart } from './WeightChart';
import { DayBars } from './DayBars';
import type { BarDay } from './DayBars';

/**
 * «Сводка» — страница, с которой врач на осмотре получает ответы.
 *
 * Порядок карточек не произвольный: он повторяет порядок вопросов на осмотре
 * новорождённого — сначала вес, потом достаточность питания (кормления и
 * подгузники), потом сон. Всё остальное ниже.
 *
 * Две вещи, от которых страница не отступает:
 *
 * 1. **Факты, а не выводы.** Ни «норма», ни «мало», ни цветовой оценки. Где
 *    есть общеизвестный ориентир, он подписан источником и лежит отдельно от
 *    самого числа — как референс в бланке анализа. Оценивает врач.
 * 2. **«Не было» и «не записали» — разные вещи.** Каждое среднее едет вместе
 *    со своим знаменателем, а карточка полноты стоит раньше всех чисел.
 */
export function StatsScreen() {
  const child = useChild();
  const periods = periodsForAge(child.ageDays);
  const [periodId, setPeriodId] = useState<string | null>(null);

  // По умолчанию — самый широкий период. Врач смотрит тренд, а не вчерашний день.
  const period = periods.find((p) => p.id === periodId) ?? periods[periods.length - 1];

  const s = useStats(period.days, child.birthMs);

  const cells = s.cells;
  const avg = useMemo(
    () => ({
      feeds: averagePerDay(cells, (c) => c.feeds?.total ?? null),
      breast: averagePerDay(cells, (c) => c.feeds?.breast ?? null),
      bottle: averagePerDay(cells, (c) => c.feeds?.bottle ?? null),
      volume: averagePerDay(cells, (c) => c.feeds?.volumeMl ?? null),
      night: averagePerDay(cells, (c) => c.nightFeeds),
      wet: averagePerDay(cells, (c) => c.diapers?.wet ?? null),
      dirty: averagePerDay(cells, (c) => c.diapers?.dirty ?? null),
      sleep: averagePerDay(cells, (c) => c.sleep?.totalMin ?? null),
      sleepSessions: averagePerDay(cells, (c) => c.sleep?.sessions ?? null),
    }),
    [cells],
  );

  const sleep = useMemo(
    () => sleepFacts(s.events, s.windowStart),
    [s.events, s.windowStart],
  );
  const gap = useMemo(() => feedGapFacts(s.events, cells), [s.events, cells]);

  // Наблюдения-состояния (§10.2): желтизна кожи и белков глаз. Врачу нужна
  // не частота, а протяжённость — с какого дня и прошло ли.
  const observations = useMemo(
    () =>
      observationFacts(
        s.events,
        stateSubtypes().map((x) => x.subtype),
        { birthMs: child.birthMs, windowStartMs: s.windowStart },
      ),
    [s.events, child.birthMs, s.windowStart],
  );
  const byWeek = useMemo(() => weekStats(s.weeks, s.weight), [s.weeks, s.weight]);
  const w = s.weightFacts;

  // Ориентиры сервер считает на возраст (§10.1) — берём самые свежие.
  const norms = cells[cells.length - 1]?.norms;

  const bars = (pick: (c: DayCell) => number | null, second?: (c: DayCell) => number | null) =>
    cells.map<BarDay>((c) => {
      // Сутки без записей (и сутки, про которые мы не знаем) — не ноль, а пробел.
      const blank = c.recorded === false || c.recorded === null;
      return {
        date: c.date,
        primary: blank ? null : pick(c),
        marker: second && !blank ? second(c) : undefined,
      };
    });

  if (s.status === 'error') {
    return (
      <div className="banner" role="status">
        <span>{s.error}</span>
        <button type="button" className="banner__btn" onClick={s.reload}>
          Ещё раз
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="filters">
        <div className="chiprow" role="group" aria-label="Период">
          {periods.map((p) => (
            <button
              key={p.id}
              type="button"
              className="chip"
              aria-pressed={p.id === period.id}
              onClick={() => setPeriodId(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="stats-grid">
        {/* --- полнота дневника: раньше всех чисел, потому что от неё зависят все --- */}
        <CoverageStrip
          coverage={s.coverage}
          truncated={s.eventsTruncated}
          unknownAll={!s.eventsKnown}
        />

        {/* --- вес: главный вопрос первых недель --- */}
        <section className="card card--wide" style={{ '--tone': 'var(--t-measure)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Вес</h2>
            <span className="card__aside">за всё время</span>
          </div>

          {w ? (
            <>
              <div className="metric">
                <span className="metric__value">{formatWeight(w.last.value)}</span>
                <span className="metric__unit">
                  {formatDay(w.last.at)}
                  <br />
                  <span className="metric__quiet">
                    при рождении {formatWeight(w.birth.value)} ·{' '}
                    {formatSignedGrams(w.fromBirthG)} от неё
                  </span>
                </span>
              </div>

              <div className="split split--4">
                <Fact
                  label="наименьшее взвешивание"
                  value={w.nadir ? formatWeight(w.nadir.point.value) : '—'}
                  hint={
                    w.nadir
                      ? `на ${formatNumber(w.nadir.lossPct, 1)}% ниже веса при рождении (${formatSignedGrams(-w.nadir.lossG)}) · ${formatDay(w.nadir.point.at)}${age(w.nadir.point.ageDays)}`
                      : w.count > 1
                        ? 'ниже веса при рождении ни одно из записанных не опускалось'
                        : 'взвешивание пока одно'
                  }
                />
                <Fact
                  label="вес при рождении перекрыт"
                  value={w.regained ? formatDay(w.regained.at) : '—'}
                  hint={
                    w.regained
                      ? `возраст ${w.regained.ageDays} ${plural(w.regained.ageDays ?? 0, 'день', 'дня', 'дней')}`
                      : w.nadir
                        ? 'такого взвешивания пока не записано'
                        : 'вес ниже исходного не падал'
                  }
                />
                <Fact
                  label="прибавка от наименьшего"
                  value={w.sinceNadir ? `${formatSignedGrams(w.sinceNadir.perDay)}` : '—'}
                  hint={
                    w.sinceNadir
                      ? `в сутки, за ${w.sinceNadir.days} ${plural(w.sinceNadir.days, 'сутки', 'суток', 'суток')}`
                      : 'считать не от чего'
                  }
                />
                <Fact
                  label="между последними взвешиваниями"
                  value={w.recent ? `${formatSignedGrams(w.recent.perDay)}` : '—'}
                  hint={
                    w.recent
                      ? `в сутки, за ${w.recent.days} ${plural(w.recent.days, 'сутки', 'суток', 'суток')}`
                      : w.count > 1
                        ? 'оба взвешивания в одни сутки'
                        : 'нужно второе взвешивание'
                  }
                />
              </div>
            </>
          ) : null}

          <WeightChart points={s.weight} />
        </section>

        {/* --- кормления --- */}
        <section className="card" style={{ '--tone': 'var(--t-feed)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Кормления</h2>
          </div>

          <Lead
            value={avg.feeds}
            unit="кормлений в сутки"
            empty="Кормлений за период не записано."
          />

          {avg.feeds ? (
            <>
              <DayBars
                days={bars((c) => c.feeds?.total ?? 0)}
                norm={norms?.feeds}
                tone="var(--t-feed)"
                unit="раз"
                gapNote
              />
              <div className="split split--4">
                <Fact
                  label="грудь"
                  value={formatPerDay(avg.breast?.value ?? null)}
                  hint="в сутки"
                />
                <Fact
                  label="бутылочка"
                  value={formatPerDay(avg.bottle?.value ?? null)}
                  hint="в сутки"
                />
                <Fact
                  label="ночью"
                  value={formatPerDay(avg.night?.value ?? null)}
                  hint={avg.night ? 'в сутки, 00:00–06:00' : 'считать не по чему'}
                />
                <Fact
                  label="самый длинный промежуток"
                  value={gap ? formatMinutes(gap.maxMin) : '—'}
                  hint={
                    gap
                      ? `${formatDay(gap.fromAt)}, ${formatTime(gap.fromAt)} → ${formatTime(gap.toAt)}`
                      : 'нужны два кормления в записанных сутках подряд'
                  }
                />
              </div>
              {avg.volume ? (
                <p className="card__note">
                  Объём называли не всегда. Там, где называли, — в среднем{' '}
                  {formatPerDay(avg.volume.value)} мл за сутки, {denom(avg.volume)}.
                </p>
              ) : (
                <p className="card__note">
                  Объём ни разу не называли — для груди его и не измеряют.
                </p>
              )}
            </>
          ) : null}
        </section>

        {/* --- подгузники: мокрые и грязные это два разных признака --- */}
        <section className="card" style={{ '--tone': 'var(--t-diaper)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Подгузники</h2>
          </div>

          {avg.wet || avg.dirty ? (
            <>
              <div className="split">
                <Fact
                  big
                  label="мокрых"
                  value={formatPerDay(avg.wet?.value ?? null)}
                  hint={denom(avg.wet)}
                />
                <Fact
                  big
                  label="грязных"
                  value={formatPerDay(avg.dirty?.value ?? null)}
                  hint={denom(avg.dirty)}
                />
              </div>
              <DayBars
                days={bars(
                  (c) => c.diapers?.wet ?? 0,
                  (c) => c.diapers?.dirty ?? 0,
                )}
                norm={norms?.wetDiapers}
                tone="var(--t-diaper)"
                toneSecondary="var(--t-measure)"
                unit="шт"
                markerLabel="грязных"
              />
              <p className="card__note">
                Столбец — мокрые, чёрточка поверх него — грязные. Ряды не складываются:
                подгузник, который был и мокрым, и грязным, посчитан в обоих. Это один
                подгузник, но два разных признака, и врач смотрит на них по отдельности.
              </p>
            </>
          ) : (
            <p className="chart-empty">Подгузников за период не записано.</p>
          )}
        </section>

        {/* --- сон --- */}
        <section className="card" style={{ '--tone': 'var(--t-sleep)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Сон</h2>
          </div>

          {avg.sleep ? (
            <>
              <div className="metric">
                <span className="metric__value">{formatMinutes(avg.sleep.value)}</span>
                <span className="metric__unit">
                  в сутки
                  <br />
                  <span className="metric__quiet">{denom(avg.sleep)}</span>
                </span>
              </div>
              <DayBars
                days={bars((c) => c.sleep?.totalMin ?? 0)}
                tone="var(--t-sleep)"
                format={(v) => formatMinutes(v)}
              />
              <div className="split">
                <Fact
                  label="самый длинный отрезок"
                  value={sleep.longest ? formatMinutes(sleep.longest.minutes) : '—'}
                  hint={
                    sleep.longest
                      ? `${formatDay(sleep.longest.startedAt)}, ${formatTime(sleep.longest.startedAt)} → ${formatTime(sleep.longest.endedAt)}`
                      : 'завершённых отрезков за период не записано'
                  }
                />
                <Fact
                  label="отрезков"
                  value={formatPerDay(avg.sleepSessions?.value ?? null)}
                  hint="в сутки"
                />
              </div>
              {sleep.openMin != null ? (
                <p className="card__note">
                  Один сон ещё идёт — {formatMinutes(sleep.openMin)} на сейчас. В «самый
                  длинный отрезок» он не входит: он не закончился.
                </p>
              ) : null}
            </>
          ) : (
            <p className="chart-empty">Сна за период не записано.</p>
          )}
        </section>

        {/* --- наблюдения: то, что родители УВИДЕЛИ, и когда ---
            Карточки нет, пока нечего показать. Пустая карточка «наблюдений не
            записано» читалась бы как «ничего не было», а это разные вещи:
            дневник молчит и о том, чего не случилось, и о том, что не
            записали. Утверждать второе мы не заработали.

            Тона у карточки нет намеренно: `--t-symptom` розово-красный, и он
            превратил бы наблюдение в предупреждение — страница начала бы
            оценивать раньше врача. Нейтрально, как «По неделям жизни». */}
        {observations.length > 0 ? (
          <section className="card card--wide">
            <div className="card__head">
              <h2 className="card__title">Наблюдения</h2>
              <span className="card__aside">со слов родителей</span>
            </div>

            <ul className="obs">
              {observations.map((o) => (
                <li className="obs__row" key={o.subtype}>
                  <p className="obs__line">
                    {observationPhrase(o, subtypeAccusative('symptom', o.subtype))}
                  </p>
                  <p className="obs__hint">
                    {[
                      o.spans.length > 0 ? spanDates(o) : null,
                      `${o.records} ${plural(o.records, 'запись', 'записи', 'записей')}`,
                      o.marks.length > 0
                        ? `из них ${o.marks.length} ${plural(o.marks.length, 'отметка', 'отметки', 'отметок')} поверх`
                        : null,
                      o.atWindowEdge ? 'период начинается с этих суток — что было раньше, в него не попало' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              ))}
            </ul>

            <p className="card__note">
              Это записано со слов родителей: что увидели и когда. Ни причины, ни
              оценки здесь нет и быть не может — их определяет врач. «Продолжается»
              означает только то, что о завершении пока не говорили.
            </p>
          </section>
        ) : null}

        {/* --- тренд: врач смотрит не день, а неделю --- */}
        {byWeek.length > 0 ? (
          <section className="card card--wide">
            <div className="card__head">
              <h2 className="card__title">По неделям жизни</h2>
            </div>
            <div className="weeks">
              {byWeek.map((r) => (
                <div className="weeks__row" key={r.week.index}>
                  <div className="weeks__head">
                    <span className="weeks__name">
                      {r.week.label}
                      {/* Крайние недели окно захватывает не целиком, и «5 из 5»
                          без дат читалось бы как полная неделя. Даты снимают
                          вопрос, не занимая отдельной строки. */}
                      <span className="weeks__span"> · {rangeOf(r.week.cells)}</span>
                    </span>
                    <span className="weeks__days">
                      {r.week.recorded} из {r.week.total}{' '}
                      {plural(r.week.total, 'суток', 'суток', 'суток')}
                    </span>
                  </div>
                  {r.week.recorded === 0 ? (
                    <p className="weeks__empty">За эту неделю в дневнике ничего нет.</p>
                  ) : r.week.cells.every((c) => c.today) ? (
                    // Неделя состоит из одних сегодняшних суток: средних за сутки
                    // тут быть не может, и строка прочерков без объяснения читалась
                    // бы как «данных нет».
                    <p className="weeks__empty">
                      Неделя только началась — сутки ещё идут, средних за них пока нет.
                    </p>
                  ) : (
                    <div className="weeks__grid">
                      <Cell label="вес" value={formatSignedGrams(r.weightDeltaG)} />
                      <Cell label="кормлений" value={formatPerDay(r.feeds?.value ?? null)} />
                      <Cell label="мокрых" value={formatPerDay(r.wet?.value ?? null)} />
                      <Cell label="грязных" value={formatPerDay(r.dirty?.value ?? null)} />
                      <Cell
                        label="сна"
                        value={r.sleepMin ? formatHours(r.sleepMin.value) : '—'}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="card__note">
              Всё, кроме веса, — в среднем за сутки, и только по тем суткам недели, где
              записи есть. Вес — разница между последним взвешиванием недели и последним
              до неё.
            </p>
          </section>
        ) : null}

        {/* --- рост и окружность головы: только когда есть что показать --- */}
        {s.height.length > 0 || s.head.length > 0 ? (
          <section className="card" style={{ '--tone': 'var(--t-measure)' } as CSSProperties}>
            <div className="card__head">
              <h2 className="card__title">Рост и голова</h2>
            </div>
            <div className="split">
              {s.height.length > 0 ? (
                <Fact
                  label="рост"
                  value={`${formatNumber(s.height[s.height.length - 1].value, 1)} см`}
                  hint={
                    s.height.length > 1
                      ? `+${formatNumber(
                          s.height[s.height.length - 1].value - s.height[0].value,
                          1,
                        )} см от первого измерения`
                      : 'измерение пока одно'
                  }
                />
              ) : null}
              {s.head.length > 0 ? (
                <Fact
                  label="окружность головы"
                  value={`${formatNumber(s.head[s.head.length - 1].value, 1)} см`}
                  hint={
                    s.head.length > 1
                      ? `+${formatNumber(s.head[s.head.length - 1].value - s.head[0].value, 1)} см от первого измерения`
                      : 'измерение пока одно'
                  }
                />
              ) : null}
            </div>
          </section>
        ) : null}
      </div>

      <p className="footnote">
        Страница показывает записанное, и только его. Оценок здесь нет намеренно: что
        означают эти числа у конкретного ребёнка, решает врач. Прочерк «—» значит «не
        записано», и это не ноль. Ориентиры на графиках — общие цифры из рекомендаций AAP
        (8–12 кормлений и 6+ мокрых подгузников в сутки), они привязаны к возрасту, а не к
        этому ребёнку. Кривых роста ВОЗ у нас нет, перцентили мы не считаем.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */

/** «18–22 авг» — какие именно сутки недели попали в период. */
function rangeOf(cells: DayCell[]): string {
  if (cells.length === 0) return '';
  const from = formatDayShort(cells[0].startMs);
  const to = formatDayShort(cells[cells.length - 1].startMs);
  return from === to ? from : `${from} — ${to}`;
}

/** Даты отрезков подписью: дни жизни отвечают врачу, даты — сверке с записями. */
function spanDates(o: ObservationFacts): string {
  return o.spans
    .map((s) => {
      const from = formatDayShort(s.fromMs);
      if (s.toMs == null) return `${from} — по сейчас`;
      const to = formatDayShort(s.toMs);
      return from === to ? from : `${from} — ${to}`;
    })
    .join(', ');
}

function age(ageDays: number | null): string {
  if (ageDays == null) return '';
  return `, возраст ${ageDays} ${plural(ageDays, 'день', 'дня', 'дней')}`;
}

/**
 * «по записям за 6 суток» — знаменатель, без которого среднее ничего не значит.
 *
 * Именно «за N суток», а не «по N суткам»: дательный падеж с числительным
 * («по 1 суткам») по-русски не читается, а сутки ещё и не имеют единственного
 * числа. Родительный после «за» работает при любом N.
 */
function denom(a: Avg | null): string {
  if (!a) return 'считать не по чему';
  return `по записям за ${a.days} ${plural(a.days, 'сутки', 'суток', 'суток')}`;
}

interface FactProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  big?: boolean;
}

function Fact({ label, value, hint, big }: FactProps) {
  return (
    <div className="substat">
      <div className="substat__label">{label}</div>
      <div className={big ? 'substat__value substat__value--big' : 'substat__value'}>{value}</div>
      {hint ? <div className="substat__hint">{hint}</div> : null}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="weeks__cell">
      <div className="weeks__value">{value}</div>
      <div className="weeks__label">{label}</div>
    </div>
  );
}

/** Крупное число карточки вместе со знаменателем, из которого оно получено. */
function Lead({ value, unit, empty }: { value: Avg | null; unit: string; empty: string }) {
  if (!value) return <p className="chart-empty">{empty}</p>;
  return (
    <div className="metric">
      <span className="metric__value">{formatPerDay(value.value)}</span>
      <span className="metric__unit">
        {unit}
        <br />
        <span className="metric__quiet">{denom(value)}</span>
      </span>
    </div>
  );
}
