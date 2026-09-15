import { useMemo } from 'react';
import type { TrackerEvent } from '../types';
import { formatDelta, formatGrams, weightSeries, type WeightPoint } from '../lib/day';
import { plural } from '../lib/format';

interface Props {
  measures: TrackerEvent[];
  now: number;
}

const W = 552;
const H = 176; // = высота .panel__body у панели 260 px
const PAD_L = 10;
const PAD_R = 104; // место под подпись последнего значения
const TOP = 30;
const BOTTOM = 34;

const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });

function daysBetween(a: number, b: number): number {
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function Chart({ points }: { points: WeightPoint[] }) {
  const first = points[0];
  const last = points[points.length - 1];

  const minG = Math.min(...points.map((p) => p.grams));
  const maxG = Math.max(...points.map((p) => p.grams));
  const padG = Math.max(60, (maxG - minG) * 0.35);
  const lo = minG - padG;
  const hi = maxG + padG;

  const spanMs = Math.max(1, last.at - first.at);
  const x = (at: number) => PAD_L + ((at - first.at) / spanMs) * (W - PAD_L - PAD_R);
  const y = (g: number) => TOP + (1 - (g - lo) / (hi - lo)) * (H - TOP - BOTTOM);

  const single = points.length === 1;
  const line = points.map((p) => `${x(p.at).toFixed(1)},${y(p.grams).toFixed(1)}`).join(' ');

  // Крайние даты подписываем всегда, промежуточные — только если не налезают
  // на соседей: 12.09 и 15.09 на двухнедельной шкале сливались в «12.0915.09».
  // Зазор считается от центра к центру, а крайние подписи прижаты к своим
  // концам — поэтому запас больше половины ширины подписи с каждой стороны.
  const MIN_GAP = 115;
  const labelled = new Set<number>();
  let lastX = -Infinity;
  points.forEach((p, i) => {
    const isEdge = i === 0 || i === points.length - 1;
    const px = x(p.at);
    const lastPx = x(points[points.length - 1].at);
    if (isEdge || (px - lastX >= MIN_GAP && lastPx - px >= MIN_GAP)) {
      labelled.add(p.at);
      lastX = px;
    }
  });

  return (
    <svg className="chart weight__chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {/* базовая линия — вес при рождении; от неё считается прирост */}
      <line
        x1={PAD_L}
        x2={W - PAD_R + 40}
        y1={y(first.grams)}
        y2={y(first.grams)}
        stroke="rgba(162,115,255,0.55)"
        strokeWidth="2"
        strokeDasharray="10 8"
      />
      <text x={PAD_L} y={y(first.grams) - 12} className="axis-label" fill="var(--violet)">
        при рождении {formatGrams(first.grams)}
      </text>

      {!single && (
        <polyline points={line} fill="none" stroke="var(--cyan)" strokeWidth="3" opacity="0.9" />
      )}

      {points.map((p, i) => {
        const isLast = i === points.length - 1;
        return (
          <g key={p.at}>
            <circle
              cx={x(p.at)}
              cy={y(p.grams)}
              r={isLast ? 9 : 6}
              fill={isLast ? 'var(--cyan-soft)' : 'var(--cyan-deep)'}
              stroke={isLast ? 'var(--cyan)' : 'none'}
              strokeWidth="3"
            />
            {isLast && (
              <text x={x(p.at) + 18} y={y(p.grams) + 9} className="bar-value" fill="var(--cyan-soft)">
                {formatGrams(p.grams)}
              </text>
            )}
            {labelled.has(p.at) && (
              <text
                x={x(p.at)}
                y={H - 8}
                textAnchor={i === 0 ? 'start' : isLast ? 'end' : 'middle'}
                className="axis-label"
                fill="var(--text-faint)"
              >
                {dayFmt.format(new Date(p.at))}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function WeightPanel({ measures, now }: Props) {
  const points = useMemo(() => weightSeries(measures), [measures]);
  const last = points[points.length - 1];
  const first = points[0];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  const ago = last ? daysBetween(last.at, now) : 0;

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Вес</h2>
        <span className="panel__rule" />
        {last && (
          <span className="panel__meta">
            {points.length} {plural(points.length, 'взвешивание', 'взвешивания', 'взвешиваний')} ·
            последнее {ago === 0 ? 'сегодня' : `${ago} ${plural(ago, 'день', 'дня', 'дней')} назад`}
          </span>
        )}
      </div>

      {!last ? (
        <div className="panel__body weight weight--empty">
          <span className="empty__title">вес не записан</span>
          <span className="empty__hint">
            скажите Алисе: <b>«Андрей весит 4 600 граммов»</b>
          </span>
        </div>
      ) : (
        <div className="panel__body weight">
          <div className="weight__now">
            <span className="weight__value">
              {formatGrams(last.grams)}
              <span className="stat__unit">г</span>
            </span>
            <span className="weight__delta">
              {/* Убыль первых дней — обычное дело, поэтому никакого красного:
                  показываем факт, а не тревогу. */}
              <b>{formatDelta(last.grams - first.grams)}</b> от рождения
            </span>
            {prev && (
              <span className="weight__delta weight__delta--dim">
                <b>{formatDelta(last.grams - prev.grams)}</b> за{' '}
                {daysBetween(prev.at, last.at)}{' '}
                {plural(daysBetween(prev.at, last.at), 'день', 'дня', 'дней')}
              </span>
            )}
          </div>
          <Chart points={points} />
        </div>
      )}
    </section>
  );
}
