import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useStats } from '../hooks/useStats';
import { growthSeries } from '../lib/group';
import { formatGrams, formatMinutes, formatNumber, formatWeight, plural } from '../lib/format';
import { NormMeter } from './NormMeter';
import { GrowthChart } from './GrowthChart';

const DAYS = 7;

function dayChipLabel(date: string, index: number): string {
  if (index === 0) return 'Сегодня';
  if (index === 1) return 'Вчера';
  const [, m, d] = date.split('-');
  return `${Number(d)}.${m}`;
}

export function StatsScreen() {
  const { stats, measures, status, error, reload } = useStats(DAYS);
  const [index, setIndex] = useState(0);

  const days = stats?.days ?? [];
  const day = days[Math.min(index, Math.max(0, days.length - 1))] ?? null;
  const partial = index === 0;

  const weight = useMemo(() => growthSeries(measures, 'weight'), [measures]);
  const height = useMemo(() => growthSeries(measures, 'height'), [measures]);

  // Сколько сна набралось за неделю — маленький контекст рядом с цифрой дня.
  const weekSleepAvg = useMemo(() => {
    const closed = days.slice(1);
    if (!closed.length) return null;
    return Math.round(closed.reduce((s, d) => s + d.sleep.totalMin, 0) / closed.length);
  }, [days]);

  if (status === 'error') {
    return (
      <div className="banner" role="status">
        <span>{error}</span>
        <button type="button" className="banner__btn" onClick={reload}>
          Ещё раз
        </button>
      </div>
    );
  }

  if (!day) {
    return <p className="placeholder">{status === 'loading' ? 'Считаю…' : 'Данных пока нет.'}</p>;
  }

  const wet = day.diaper.wet;
  const dirty = day.diaper.dirty;

  return (
    <>
      <div className="filters">
        <div className="chiprow" role="group" aria-label="День">
          {days.map((d, i) => (
            <button
              key={d.date}
              type="button"
              className="chip"
              aria-pressed={i === index}
              onClick={() => setIndex(i)}
            >
              {dayChipLabel(d.date, i)}
            </button>
          ))}
        </div>
        {partial ? (
          <p className="filters__meta">
            Сутки ещё не закончились — цифры за неполный день.
          </p>
        ) : null}
      </div>

      <div className="stats-grid">
        <section className="card" style={{ '--tone': 'var(--t-feed)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Кормления</h2>
          </div>
          <div className="metric">
            <span className="metric__value">{day.feed.count}</span>
            <span className="metric__unit">
              {plural(day.feed.count, 'раз', 'раза', 'раз')} за сутки
            </span>
          </div>
          <NormMeter
            value={day.feed.count}
            norm={day.norms?.feed}
            partial={partial}
            tone="var(--t-feed)"
          />
          {(day.feed.bottleMl ?? 0) > 0 || (day.feed.breastMin ?? 0) > 0 ? (
            <div className="split" style={{ marginTop: 10 }}>
              <div className="substat">
                <div className="substat__label">из бутылочки</div>
                <div className="substat__value">{formatNumber(day.feed.bottleMl)}</div>
                <div className="substat__hint">мл всего</div>
              </div>
              <div className="substat">
                <div className="substat__label">грудь</div>
                <div className="substat__value">{formatNumber(day.feed.breastMin)}</div>
                <div className="substat__hint">минут всего</div>
              </div>
            </div>
          ) : null}
        </section>

        <section className="card" style={{ '--tone': 'var(--t-diaper)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Подгузники</h2>
          </div>

          <div className="metric">
            <span className="metric__value">{wet}</span>
            <span className="metric__unit">мокрых</span>
          </div>
          <NormMeter
            value={wet}
            norm={day.norms?.diaperWet}
            partial={partial}
            tone="var(--t-diaper)"
          />

          <div className="metric" style={{ marginTop: 16 }}>
            <span className="metric__value">{dirty}</span>
            <span className="metric__unit">грязных</span>
          </div>
          <NormMeter
            value={dirty}
            norm={day.norms?.diaperDirty}
            partial={partial}
            tone="var(--t-diaper)"
          />
        </section>

        <section className="card" style={{ '--tone': 'var(--t-sleep)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Сон</h2>
            <span className="card__aside">
              {day.sleep.sessions} {plural(day.sleep.sessions, 'отрезок', 'отрезка', 'отрезков')}
            </span>
          </div>
          <div className="metric">
            <span className="metric__value">{formatMinutes(day.sleep.totalMin)}</span>
            {weekSleepAvg != null ? (
              <span className="metric__aside">
                за прошлые дни
                <br />в среднем {formatMinutes(weekSleepAvg)}
              </span>
            ) : null}
          </div>
          <NormMeter
            value={day.sleep.totalMin}
            norm={day.norms?.sleepMin}
            partial={partial}
            tone="var(--t-sleep)"
            fmt={(n) => formatMinutes(n)}
          />
          <div className="split" style={{ marginTop: 10 }}>
            <div className="substat">
              <div className="substat__label">ночью</div>
              <div className="substat__value">{formatMinutes(day.sleep.nightMin ?? 0)}</div>
            </div>
            <div className="substat">
              <div className="substat__label">днём</div>
              <div className="substat__value">{formatMinutes(day.sleep.napMin ?? 0)}</div>
            </div>
          </div>
        </section>

        <section
          className="card card--wide"
          style={{ '--tone': 'var(--t-measure)' } as CSSProperties}
        >
          <div className="card__head">
            <h2 className="card__title">Вес</h2>
            <span className="card__aside">
              {weight.length} {plural(weight.length, 'замер', 'замера', 'замеров')}
            </span>
          </div>
          <GrowthChart
            points={weight}
            tone="var(--t-measure)"
            format={(v) => formatWeight(v)}
            formatDelta={(v) => formatGrams(v)}
          />

          <div className="card__head" style={{ marginTop: 18 }}>
            <h2 className="card__title">Рост</h2>
          </div>
          <GrowthChart
            points={height}
            tone="var(--t-measure)"
            format={(v) => `${formatNumber(v, 1)} см`}
          />
        </section>
      </div>

      <p className="footnote">
        Ориентиры — общие цифры из рекомендаций для младенцев, а не оценка конкретного
        дня: сутки бывают разные, и один непохожий день сам по себе ничего не значит.
        Всё, что касается здоровья, обсуждайте с педиатром.
      </p>
    </>
  );
}
