import type { DayTimeline } from '../lib/timeline';
import { formatMinutes, formatTime } from '../lib/format';

interface Props {
  timeline: DayTimeline;
  /** Подписи часов: на узком экране показываем реже. */
  compact?: boolean;
}

const HOUR_TICKS = [0, 6, 12, 18, 24];

/**
 * Полоса суток: сон блоками, кормления и подгузники — засечками на оси времени.
 *
 * Свёрстана дивами, а не SVG, намеренно: позиции задаются процентами, а засечки
 * остаются шириной в пиксель на любой ширине экрана. У SVG с preserveAspectRatio
 * они бы растягивались вместе с холстом.
 *
 * Пустые сутки тоже выглядят осмысленно: ось часов на месте, и видно, что записей
 * пока нет, — для двухнедельного ребёнка это нормальное состояние, а не ошибка.
 */
export function DayStrip({ timeline, compact }: Props) {
  const { sleeps, feeds, diapers, nowPos } = timeline;
  const pct = (v: number) => `${Math.max(0, Math.min(100, v * 100))}%`;
  const empty = sleeps.length === 0 && feeds.length === 0 && diapers.length === 0;

  return (
    <div className="strip">
      <div className="strip__row strip__row--sleep">
        {sleeps.map((s, i) => (
          <div
            key={`${s.from}-${i}`}
            className={s.open ? 'strip__sleep strip__sleep--open' : 'strip__sleep'}
            style={{ left: pct(s.from), width: pct(Math.max(0.004, s.to - s.from)) }}
            title={`Сон ${formatMinutes(s.minutes)}`}
          />
        ))}
        {nowPos != null ? (
          <div className="strip__now" style={{ left: pct(nowPos) }} aria-hidden="true" />
        ) : null}
      </div>

      <div className="strip__row strip__row--marks" data-kind="feed">
        {feeds.map((m) => (
          <div
            key={m.at}
            className="strip__mark"
            style={{ left: pct(m.pos) }}
            title={`Кормление в ${formatTime(m.at)}`}
          />
        ))}
      </div>

      <div className="strip__row strip__row--marks" data-kind="diaper">
        {diapers.map((m) => (
          <div
            key={m.at}
            className="strip__mark"
            style={{ left: pct(m.pos) }}
            title={`Подгузник в ${formatTime(m.at)}`}
          />
        ))}
      </div>

      <div className="strip__axis" aria-hidden="true">
        {HOUR_TICKS.map((h) => (
          <span key={h} className="strip__tick" style={{ left: pct(h / 24) }}>
            {compact && h === 24 ? '' : `${String(h % 24).padStart(2, '0')}`}
          </span>
        ))}
      </div>

      <div className="strip__legend">
        {empty ? (
          <span className="strip__hint">За эти сутки пока ничего не записано</span>
        ) : (
          <>
            <span className="strip__key" data-kind="sleep">
              сон
            </span>
            <span className="strip__key" data-kind="feed">
              кормления {feeds.length ? `· ${feeds.length}` : ''}
            </span>
            <span className="strip__key" data-kind="diaper">
              подгузники {diapers.length ? `· ${diapers.length}` : ''}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
