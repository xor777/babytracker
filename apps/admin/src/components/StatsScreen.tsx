import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { periodsForAge, useChild, useStats } from '../hooks/useStats';
import {
  averagePerDay,
  dayBars,
  diaperMarks,
  feedGapFacts,
  observationFacts,
  observationPhrase,
  sleepFacts,
  temperatureFacts,
  weekStats,
} from '../lib/summary';
import type { Avg, DayCell, FeedGap, ObservationFacts } from '../lib/summary';
import { stateSubtypes, subtypeAccusative } from '../lib/taxonomy';
import {
  formatDay,
  formatDayShort,
  formatHours,
  formatMinutes,
  formatNumber,
  formatPerDay,
  formatSignedGrams,
  formatSpan,
  formatTime,
  formatWeight,
  plural,
} from '../lib/format';
import { CoverageStrip } from './CoverageStrip';
import { WeightChart } from './WeightChart';
import { DayBars } from './DayBars';
import { DiaperDots } from './DiaperDots';
import type { DiaperDay } from './DiaperDots';

/*
 * Что берём из суток — по одной записи на каждое число экрана.
 *
 * `null` тут значит «за эти сутки такого не записано», и он делает сразу две
 * вещи: выбрасывает сутки из знаменателя среднего и ставит на графике штриховку
 * вместо столбца. Поэтому график и среднее обязаны спрашивать ОДНУ И ТУ ЖЕ
 * функцию, а не две похожие: разошлись они однажды — и сутки, в которые
 * записали одно взвешивание, оказались на графике кормлений нулём, а в
 * знаменателе среднего — нет.
 */
const pick = {
  feeds: (c: DayCell) => c.feeds?.total ?? null,
  breast: (c: DayCell) => c.feeds?.breast ?? null,
  bottle: (c: DayCell) => c.feeds?.bottle ?? null,
  volume: (c: DayCell) => c.feeds?.volumeMl ?? null,
  night: (c: DayCell) => c.nightFeeds,
  wet: (c: DayCell) => c.diapers?.wet ?? null,
  dirty: (c: DayCell) => c.diapers?.dirty ?? null,
  sleep: (c: DayCell) => c.sleep?.totalMin ?? null,
  sleepSessions: (c: DayCell) => c.sleep?.sessions ?? null,
};

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
      feeds: averagePerDay(cells, pick.feeds),
      breast: averagePerDay(cells, pick.breast),
      bottle: averagePerDay(cells, pick.bottle),
      volume: averagePerDay(cells, pick.volume),
      night: averagePerDay(cells, pick.night),
      wet: averagePerDay(cells, pick.wet),
      dirty: averagePerDay(cells, pick.dirty),
      sleep: averagePerDay(cells, pick.sleep),
      sleepSessions: averagePerDay(cells, pick.sleepSessions),
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
  // Температура (§10.2): градусы лежат в двух местах сразу — measure/temp
  // и symptom/fever, — и читать надо оба, иначе записанный жар до врача
  // не доезжает. Считаем по сырым событиям: суточный максимум с сервера
  // не помнит ни времени, ни того, сколько раз мерили.
  const temp = useMemo(
    () => temperatureFacts(s.events, { birthMs: child.birthMs, windowStartMs: s.windowStart }),
    [s.events, child.birthMs, s.windowStart],
  );
  const byWeek = useMemo(() => weekStats(s.weeks, s.weight), [s.weeks, s.weight]);
  const w = s.weightFacts;

  // Ориентиры сервер считает на возраст (§10.1) — берём самые свежие.
  const norms = cells[cells.length - 1]?.norms;

  // Подгузники рисуются штуками, а не длиной: два пересекающихся ряда с сервера
  // раскладываются на непересекающиеся кучки, чтобы знаков вышло ровно столько,
  // сколько подгузников сменили (см. diaperMarks). Сутки без записей о
  // подгузниках дают null — штриховку, а не ноль.
  const diaperDays = cells.map<DiaperDay>((c) => ({
    date: c.date,
    marks: diaperMarks(c.diapers),
  }));

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
            empty="За завершённые сутки периода кормлений не записано."
          />

          {avg.feeds ? (
            <>
              <DayBars
                days={dayBars(cells, pick.feeds)}
                norm={norms?.feeds}
                tone="var(--t-feed)"
                unit="раз"
                kind="о кормлении"
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
                  // Знаменатель тут свой: ночные считаются по сырым событиям, и
                  // обрезанная лента может оставить их меньше, чем суток с
                  // кормлениями. Два средних с разными знаменателями бок о бок
                  // читаются как доля — поэтому знаменатель написан.
                  hint={
                    avg.night ? `в сутки, 00:00–06:00 · ${denom(avg.night)}` : 'считать не по чему'
                  }
                />
                <Fact
                  label="самый длинный промежуток"
                  value={gap.longest ? formatMinutes(gap.longest.minutes) : '—'}
                  hint={
                    gap.longest
                      ? formatSpan(gap.longest.fromAt, gap.longest.toAt)
                      : 'нужны два кормления подряд в сутках с записанными кормлениями'
                  }
                />
              </div>
              {/* Перерыв длиннее суток — не наблюдение, а пробел в записях, и в
                  «самый длинный промежуток» он не идёт. Но и молчать о нём
                  нельзя: он в дневнике есть, и врач должен знать, что здесь
                  просто не записывали. Ни оценки, ни вывода — только границы. */}
              {gap.breaks.length > 0 ? (
                <p className="card__note">
                  {gap.breaks.length === 1
                    ? 'В дневнике есть перерыв в записях о кормлении длиннее суток: '
                    : `В дневнике есть ${gap.breaks.length} ${plural(gap.breaks.length, 'перерыв', 'перерыва', 'перерывов')} в записях о кормлении длиннее суток, самый долгий — `}
                  {longestBreak(gap.breaks)}. В «самый длинный промежуток» такие перерывы не
                  входят: это пробел в записях, а не наблюдение.
                </p>
              ) : null}
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
              <DiaperDots days={diaperDays} norm={norms?.wetDiapers} gapNote />
              <p className="card__note">
                Знак — подгузник: сколько сменили, столько и знаков. Мокрые — снизу,
                грязные — сверху, а тот, что был и мокрым, и грязным, стоит между ними
                одним двуцветным знаком и входит в оба счёта. Поэтому «мокрых» и
                «грязных» по отдельности больше, чем подгузников: это один подгузник и
                два разных признака, и врач смотрит на них порознь.
              </p>
            </>
          ) : (
            <p className="chart-empty">За завершённые сутки периода подгузников не записано.</p>
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
                days={dayBars(cells, pick.sleep)}
                tone="var(--t-sleep)"
                format={(v) => formatMinutes(v)}
                kind="о сне"
                gapNote
              />
              <div className="split">
                <Fact
                  label="самый длинный отрезок"
                  value={sleep.longest ? formatMinutes(sleep.longest.minutes) : '—'}
                  hint={
                    sleep.longest
                      ? formatSpan(sleep.longest.startedAt, sleep.longest.endedAt)
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
            <p className="chart-empty">За завершённые сутки периода сна не записано.</p>
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

        {/* --- температура: факт и только факт ---
            Карточки нет, пока градусов не записывали: пустая читалась бы как
            «температуры не было», а дневник знает только «не записали».

            Ни слова оценки и ни одного цвета — как и на всей странице. 37.2
            у новорождённого значит разное в зависимости от того, чем мерили,
            во что одет и когда ел; решает это врач, а наше дело — показать,
            что записали и когда. Тон карточке не задан намеренно: `--t-symptom`
            розово-красный, и он превратил бы число в тревогу. */}
        {temp.days.length > 0 ? (
          <section className="card card--wide">
            <div className="card__head">
              <h2 className="card__title">Температура</h2>
              <span className="card__aside">со слов родителей</span>
            </div>

            {temp.peak ? (
              <p className="obs__line">
                Самое высокое записанное значение за период — {formatNumber(temp.peak.c, 1)} °C
                {temp.peak.day == null ? '' : `, ${temp.peak.day}-й день жизни`},{' '}
                {formatDayShort(temp.peak.atMs)} в {formatTime(temp.peak.atMs)}.
              </p>
            ) : null}

            <ul className="obs" style={{ marginTop: 11 }}>
              {temp.days.map((d) => (
                <li className="obs__row" key={d.startMs}>
                  <p className="obs__line">
                    {formatDayShort(d.startMs)}
                    {d.day == null ? '' : `, ${d.day}-й день`} — {formatNumber(d.maxC, 1)} °C
                  </p>
                  <p className="obs__hint">
                    {[
                      `${d.records} ${plural(d.records, 'запись', 'записи', 'записей')} за сутки`,
                      d.records > 1 ? 'показано самое высокое' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              ))}
            </ul>

            <p className="card__note">
              Всего записей с градусами за период: {temp.records}. Считаются оба способа
              записи — и замер, и жар, названный симптомом.
              {temp.atWindowEdge
                ? ' Период начинается с этих суток: что было раньше, в него не попало.'
                : ''}{' '}
              Чем и как измеряли, дневник не знает: значения показаны как записаны.
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
                      {/* Прибавка почти никогда не укладывается ровно в неделю:
                          взвешивают раз в несколько дней, и точка отсчёта —
                          последнее взвешивание ДО недели. «−36 г» в строке
                          «2-я неделя» без срока читается как «за эту неделю»,
                          а на деле это разница за тринадцать суток. Срок и есть
                          знаменатель этого числа, и он обязан стоять рядом. */}
                      <Cell
                        label={
                          r.weightSpanDays
                            ? `вес, за ${r.weightSpanDays} ${plural(r.weightSpanDays, 'сутки', 'суток', 'суток')}`
                            : 'вес'
                        }
                        value={formatSignedGrams(r.weightDeltaG)}
                      />
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
              записи этого рода есть. Вес — разница между последним взвешиванием недели и
              последним до неё; за сколько суток она набралась, написано рядом.
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

/** «14 сентября, 13:00 → 15 сентября, 19:06 (30 ч 6 мин)» — самый долгий из перерывов. */
function longestBreak(breaks: FeedGap[]): string {
  const b = breaks.reduce((a, x) => (x.minutes > a.minutes ? x : a));
  return `${formatSpan(b.fromAt, b.toAt)} (${formatMinutes(b.minutes)})`;
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
