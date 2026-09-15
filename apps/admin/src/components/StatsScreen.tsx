import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { periodsForAge, useChildAge, useStats } from '../hooks/useStats';
import { feedGaps } from '../lib/timeline';
import { formatMinutes, formatNumber, localDateKey, plural } from '../lib/format';
import { NormMeter } from './NormMeter';
import { WeightChart } from './WeightChart';
import { DayBars } from './DayBars';
import type { BarDay } from './DayBars';

export function StatsScreen() {
  const [periodId, setPeriodId] = useState('week');
  const ageDays = useChildAge();

  const periods = periodsForAge(ageDays);
  const period = periods.find((p) => p.id === periodId) ?? periods[periods.length - 1];
  const isDay = period.days === 1;

  const s = useStats(period.days, isDay);

  const todayKey = localDateKey(Date.now());
  const today = s.stats.find((d) => d.date === todayKey) ?? s.stats[0] ?? null;
  const gaps = useMemo(() => feedGaps(s.todayTimeline.feeds), [s.todayTimeline.feeds]);

  const feedBars: BarDay[] = s.stats.map((d) => ({ date: d.date, primary: d.feeds.total }));
  const diaperBars: BarDay[] = s.stats.map((d) => ({
    date: d.date,
    primary: d.diapers.wet + d.diapers.both,
    secondary: d.diapers.dirty,
  }));
  const sleepBars: BarDay[] = s.stats.map((d) => ({ date: d.date, primary: d.sleep.totalMin }));

  /** Среднее по завершённым суткам: сегодняшний неполный день среднее бы занизил. */
  const closed = s.stats.filter((d) => d.date !== todayKey);
  const avg = (pick: (d: (typeof s.stats)[number]) => number) => {
    if (!closed.length) return null;
    const total = closed.reduce((sum, d) => sum + pick(d), 0);
    // «в среднем 0 в сутки» — не факт, а насмешка: если данных нет, молчим.
    return total > 0 ? Math.round(total / closed.length) : null;
  };

  /** Есть ли вообще что рисовать: пустой график хуже честного объяснения. */
  const has = (pick: (d: (typeof s.stats)[number]) => number) => s.stats.some((d) => pick(d) > 0);

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

  const norms = today?.norms ?? s.stats[s.stats.length - 1]?.norms;

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
        {/* --- вес: главная динамика первых недель --- */}
        <section className="card card--wide" style={{ '--tone': 'var(--t-measure)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Вес</h2>
            <span className="card__aside">за всё время</span>
          </div>
          <WeightChart points={s.weight} />
        </section>

        {/* --- кормления --- */}
        <section className="card" style={{ '--tone': 'var(--t-feed)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Кормления</h2>
            {!isDay && avg((d) => d.feeds.total) != null ? (
              <span className="card__aside">в среднем {avg((d) => d.feeds.total)} в сутки</span>
            ) : null}
          </div>

          {isDay ? (
            today && today.feeds.total > 0 ? (
              <>
                <div className="metric">
                  <span className="metric__value">{today.feeds.total}</span>
                  <span className="metric__unit">
                    {plural(today.feeds.total, 'раз', 'раза', 'раз')} за сутки
                  </span>
                </div>
                <NormMeter
                  value={today.feeds.total}
                  norm={norms?.feeds}
                  partial
                  tone="var(--t-feed)"
                />
                <div className="split" style={{ marginTop: 10 }}>
                  <div className="substat">
                    <div className="substat__label">промежуток</div>
                    <div className="substat__value">
                      {gaps ? formatMinutes(gaps.avgMin) : '—'}
                    </div>
                    <div className="substat__hint">
                      {gaps ? `самый длинный ${formatMinutes(gaps.maxMin)}` : 'нужно два кормления'}
                    </div>
                  </div>
                  <div className="substat">
                    <div className="substat__label">грудь / бутылочка</div>
                    <div className="substat__value">
                      {today.feeds.breast} / {today.feeds.bottle}
                    </div>
                    {today.feeds.volumeMl != null ? (
                      <div className="substat__hint">{formatNumber(today.feeds.volumeMl)} мл</div>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <p className="chart-empty">
                За сегодня кормлений пока не записано. Скажите Алисе «покормила» —
                запись появится здесь.
              </p>
            )
          ) : has((d) => d.feeds.total) ? (
            <DayBars days={feedBars} norm={norms?.feeds} tone="var(--t-feed)" unit="раз" />
          ) : (
            <p className="chart-empty">
              За этот период кормлений не записано. Скажите Алисе «покормила» — и здесь
              появится ритм по дням рядом с ориентиром 8–12 в сутки.
            </p>
          )}
        </section>

        {/* --- подгузники --- */}
        <section className="card" style={{ '--tone': 'var(--t-diaper)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Подгузники</h2>
            {!isDay && avg((d) => d.diapers.total) != null ? (
              <span className="card__aside">в среднем {avg((d) => d.diapers.total)} в сутки</span>
            ) : null}
          </div>

          {isDay ? (
            today && today.diapers.total > 0 ? (
              <>
                <div className="metric">
                  <span className="metric__value">{today.diapers.wet + today.diapers.both}</span>
                  <span className="metric__unit">мокрых</span>
                </div>
                <NormMeter
                  value={today.diapers.wet + today.diapers.both}
                  norm={norms?.wetDiapers}
                  partial
                  tone="var(--t-diaper)"
                />
                <div className="metric" style={{ marginTop: 16 }}>
                  <span className="metric__value">
                    {today.diapers.dirty + today.diapers.both}
                  </span>
                  <span className="metric__unit">грязных</span>
                </div>
                <NormMeter
                  value={today.diapers.dirty + today.diapers.both}
                  norm={norms?.dirtyDiapers}
                  partial
                  tone="var(--t-diaper)"
                />
              </>
            ) : (
              <p className="chart-empty">
                За сегодня подгузников пока не записано. Скажите Алисе «поменяли
                подгузник» — запись появится здесь.
              </p>
            )
          ) : has((d) => d.diapers.total) ? (
            <>
              <DayBars
                days={diaperBars}
                norm={norms?.wetDiapers}
                tone="var(--t-diaper)"
                toneSecondary="var(--amber)"
                unit="шт"
              />
              <p className="card__note">Светлая часть столбца — грязные подгузники.</p>
            </>
          ) : (
            <p className="chart-empty">
              За этот период подгузников не записано. Скажите Алисе «поменяли подгузник» —
              и счёт пойдёт рядом с ориентиром 6+ мокрых в сутки.
            </p>
          )}
        </section>

        {/* --- сон --- */}
        <section className="card" style={{ '--tone': 'var(--t-sleep)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Сон</h2>
            {!isDay && avg((d) => d.sleep.totalMin) != null ? (
              <span className="card__aside">
                в среднем {formatMinutes(avg((d) => d.sleep.totalMin) ?? 0)}
              </span>
            ) : null}
          </div>

          {isDay ? (
            today && today.sleep.sessions > 0 ? (
              <>
                <div className="metric">
                  <span className="metric__value">{formatMinutes(today.sleep.totalMin)}</span>
                  <span className="metric__unit">за сутки</span>
                </div>
                <div className="split" style={{ marginTop: 10 }}>
                  <div className="substat">
                    <div className="substat__label">отрезков</div>
                    <div className="substat__value">{today.sleep.sessions}</div>
                  </div>
                  <div className="substat">
                    <div className="substat__label">самый длинный</div>
                    <div className="substat__value">{formatMinutes(today.sleep.longestMin)}</div>
                  </div>
                </div>
              </>
            ) : (
              <p className="chart-empty">
                За сегодня сна пока не записано. Скажите Алисе «Андрей заснул» —
                и здесь пойдёт таймер.
              </p>
            )
          ) : has((d) => d.sleep.totalMin) ? (
            <DayBars days={sleepBars} tone="var(--t-sleep)" format={(v) => formatMinutes(v)} />
          ) : (
            <p className="chart-empty">
              За этот период сна не записано. Скажите Алисе «Андрей заснул» и
              «проснулся» — здесь появятся часы по дням.
            </p>
          )}
          {/* Ориентира по сну сервер не отдаёт — выдумывать свой мы не станем. */}
        </section>

        {/* --- рост и окружность головы: только когда есть что показать --- */}
        {s.height.length > 0 || s.head.length > 0 ? (
          <section className="card" style={{ '--tone': 'var(--t-measure)' } as CSSProperties}>
            <div className="card__head">
              <h2 className="card__title">Рост и голова</h2>
            </div>
            <div className="split">
              {s.height.length > 0 ? (
                <div className="substat">
                  <div className="substat__label">рост</div>
                  <div className="substat__value">
                    {formatNumber(s.height[s.height.length - 1].value, 1)} см
                  </div>
                  {s.height.length > 1 ? (
                    <div className="substat__hint">
                      +{formatNumber(
                        s.height[s.height.length - 1].value - s.height[0].value,
                        1,
                      )}{' '}
                      см от рождения
                    </div>
                  ) : (
                    <div className="substat__hint">при рождении</div>
                  )}
                </div>
              ) : null}
              {s.head.length > 0 ? (
                <div className="substat">
                  <div className="substat__label">окружность головы</div>
                  <div className="substat__value">
                    {formatNumber(s.head[s.head.length - 1].value, 1)} см
                  </div>
                  {s.head.length > 1 ? (
                    <div className="substat__hint">
                      +{formatNumber(s.head[s.head.length - 1].value - s.head[0].value, 1)} см
                    </div>
                  ) : (
                    <div className="substat__hint">при рождении</div>
                  )}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>

      <p className="footnote">
        Ориентиры — общие цифры из рекомендаций для младенцев, а не оценка конкретного дня:
        сутки бывают разные, и один непохожий день сам по себе ничего не значит. Кривых роста
        ВОЗ у нас нет, перцентили мы не считаем. Всё, что касается здоровья, обсуждайте
        с педиатром.
      </p>
    </>
  );
}
