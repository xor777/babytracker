import type { GrowthPoint } from '../types';
import { formatDayShort } from '../lib/format';

interface Props {
  points: GrowthPoint[];
  tone: string;
  /** Значение → подпись. Вес хочется в килограммах, рост в сантиметрах. */
  format: (v: number) => string;
  /** Привес за неделю — не «0,21 кг», а «210 г». По умолчанию как и значение. */
  formatDelta?: (v: number) => string;
}

const W = 300;
const H = 92;
const PAD_X = 6;
const PAD_Y = 12;

/**
 * Ростовая кривая. Библиотека тут была бы тяжелее самой картинки:
 * это ломаная по десятку точек.
 */
export function GrowthChart({ points, tone, format, formatDelta = format }: Props) {
  if (points.length === 0) {
    return <p className="field__hint">Измерений пока нет.</p>;
  }

  const first = points[0];
  const last = points[points.length - 1];

  if (points.length === 1) {
    return (
      <p className="legend">
        <span>
          {formatDayShort(first.at)} — <b>{format(first.value)}</b>
        </span>
        <span>для кривой нужно хотя бы два измерения</span>
      </p>
    );
  }

  const minT = first.at;
  const maxT = last.at;
  const values = points.map((p) => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const spanV = maxV - minV || 1;
  const spanT = maxT - minT || 1;

  const x = (t: number) => PAD_X + ((t - minT) / spanT) * (W - PAD_X * 2);
  const y = (v: number) => H - PAD_Y - ((v - minV) / spanV) * (H - PAD_Y * 2);

  const line = points.map((p) => `${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${PAD_X},${H} ${line} ${(W - PAD_X).toFixed(1)},${H}`;
  const delta = last.value - first.value;

  return (
    <>
      <svg
        className="growth"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Динамика: от ${format(first.value)} до ${format(last.value)}`}
      >
        <polygon points={area} fill={tone} opacity="0.08" />
        <polyline
          points={line}
          fill="none"
          stroke={tone}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((p) => (
          <circle
            key={p.at}
            cx={x(p.at)}
            cy={y(p.value)}
            r="2.5"
            fill="var(--bg-card)"
            stroke={tone}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <p className="legend">
        <span>
          {formatDayShort(first.at)} <b>{format(first.value)}</b>
        </span>
        <span>
          {formatDayShort(last.at)} <b>{format(last.value)}</b>
        </span>
        <span>
          за период <b>{delta >= 0 ? '+' : '−'}{formatDelta(Math.abs(delta))}</b>
        </span>
      </p>
    </>
  );
}
