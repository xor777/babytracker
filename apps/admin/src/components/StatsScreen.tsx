import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useStats } from '../hooks/useStats';
import { growthSeries } from '../lib/group';
import {
  formatGrams,
  formatMinutes,
  formatNumber,
  formatWeight,
  localDateKey,
  plural,
} from '../lib/format';
import { NormMeter } from './NormMeter';
import { GrowthChart } from './GrowthChart';

const DAYS = 7;

export function StatsScreen() {
  const { stats, measures, status, error, reload } = useStats(DAYS);
  const [index, setIndex] = useState(0);

  // fetchStats уже отсортировал по убыванию, но «сегодня» определяем датой, а не позицией:
  // сервер отдаёт дни по возрастанию, и привязка к индексу приклеивала бы
  // «сутки ещё не кончились» к чужому дню.
  const days = stats?.days ?? [];
  const todayKey = localDateKey(Date.now());
  const day = days[Math.min(index, Math.max(0, days.length - 1))] ?? null;
  const partial = day?.date === todayKey;

  const weight = useMemo(() => growthSeries(measures, 'weight'), [measures]);
  const height = useMemo(() => growthSeries(measures, 'height'), [measures]);

  /** Средний сон по завершённым суткам — контекст рядом с цифрой дня. */
  const pastSleepAvg = useMemo(() => {
    const closed = days.filter((d) => d.date !== todayKey);
    if (!closed.length) return null;
    return Math.round(closed.reduce((s, d) => s + d.sleep.totalMin, 0) / closed.length);
  }, [days, todayKey]);

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

  const dayLabel = (date: string): string => {
    if (date === todayKey) return 'Сегодня';
    const [, m, d] = date.split('-');
    return `${Number(d)}.${m}`;
  };

  // «both» — это и мокрый, и грязный: сервер считает их отдельной колонкой,
  // а к норме подгузник должен идти в оба зачёта.
  const wet = day.diapers.wet + day.diapers.both;
  const dirty = day.diapers.dirty + day.diapers.both;

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
              {dayLabel(d.date)}
            </button>
          ))}
        </div>
        {partial ? (
          <p className="filters__meta">Сутки ещё не закончились — цифры за неполный день.</p>
        ) : null}
      </div>

      <div className="stats-grid">
        <section className="card" style={{ '--tone': 'var(--t-feed)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Кормления</h2>
          </div>
          <div className="metric">
            <span className="metric__value">{day.feeds.total}</span>
            <span className="metric__unit">
              {plural(day.feeds.total, 'раз', 'раза', 'раз')} за сутки
            </span>
          </div>
          <NormMeter
            value={day.feeds.total}
            norm={day.norms?.feeds}
            partial={partial}
            tone="var(--t-feed)"
          />
          <div className="split" style={{ marginTop: 10 }}>
            <div className="substat">
              <div className="substat__label">грудь / бутылочка</div>
              <div className="substat__value">
                {day.feeds.breast} / {day.feeds.bottle}
              </div>
              {day.feeds.solid > 0 ? (
                <div className="substat__hint">прикорм {day.feeds.solid}</div>
              ) : null}
            </div>
            <div className="substat">
              <div className="substat__label">объём</div>
              <div className="substat__value">
                {day.feeds.volumeMl == null ? '—' : formatNumber(day.feeds.volumeMl)}
              </div>
              <div className="substat__hint">
                {day.feeds.volumeMl == null ? 'не называли' : 'мл всего'}
              </div>
            </div>
          </div>
        </section>

        <section className="card" style={{ '--tone': 'var(--t-diaper)' } as CSSProperties}>
          <div className="card__head">
            <h2 className="card__title">Подгузники</h2>
            <span className="card__aside">всего {day.diapers.total}</span>
          </div>

          <div className="metric">
            <span className="metric__value">{wet}</span>
            <span className="metric__unit">мокрых</span>
          </div>
          <NormMeter
            value={wet}
            norm={day.norms?.wetDiapers}
            partial={partial}
            tone="var(--t-diaper)"
          />

          <div className="metric" style={{ marginTop: 16 }}>
            <span className="metric__value">{dirty}</span>
            <span className="metric__unit">грязных</span>
          </div>
          <NormMeter
            value={dirty}
            norm={day.norms?.dirtyDiapers}
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
          </div>
          {/* Ориентира по сну сервер не отдаёт — и придумывать свой мы не станем:
              это была бы ровно та медицинская отсебятина, которой здесь не место. */}
          <div className="split" style={{ marginTop: 10 }}>
            <div className="substat">
              <div className="substat__label">самый длинный отрезок</div>
              <div className="substat__value">{formatMinutes(day.sleep.longestMin)}</div>
            </div>
            <div className="substat">
              <div className="substat__label">
                {partial ? 'в среднем за прошлые дни' : 'в среднем за неделю'}
              </div>
              <div className="substat__value">
                {pastSleepAvg == null ? '—' : formatMinutes(pastSleepAvg)}
              </div>
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
          {day.measures.headCm != null ? (
            <p className="legend">
              <span>
                окружность головы <b>{formatNumber(day.measures.headCm, 1)} см</b>
              </span>
            </p>
          ) : null}
        </section>
      </div>

      <p className="footnote">
        Ориентиры — общие цифры из рекомендаций для младенцев, а не оценка конкретного дня:
        сутки бывают разные, и один непохожий день сам по себе ничего не значит. Всё, что
        касается здоровья, обсуждайте с педиатром.
      </p>
    </>
  );
}
