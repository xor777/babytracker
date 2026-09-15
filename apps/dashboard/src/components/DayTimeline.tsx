import { useMemo } from 'react';
import type { TrackerEvent } from '../types';
import { formatMinutes, HOUR } from '../lib/format';
import { toSegments } from '../lib/sleep';

interface Props {
  events: TrackerEvent[];
  now: number;
}

const W = 892;
const H = 156; // = высота .panel__body у панели 240 px
const TRACK_Y = 26;
const TRACK_H = 72;
const TRACK_BOTTOM = TRACK_Y + TRACK_H;
const SPAN = 24 * HOUR;

function shortDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}ч${String(m).padStart(2, '0')}` : `${m}м`;
}

export function DayTimeline({ events, now }: Props) {
  // Пересчитываем раз в полминуты, а не каждый тик секундомера.
  const anchor = Math.floor(now / 30_000) * 30_000;
  const from = anchor - SPAN;

  const segments = useMemo(() => toSegments(events, from, anchor), [events, from, anchor]);

  const totalMs = segments.reduce((acc, s) => acc + (s.end - s.start), 0);
  const x = (t: number) => ((t - from) / SPAN) * W;

  // Часовые отметки + подсветка ночных часов
  const ticks: { t: number; hour: number; major: boolean }[] = [];
  const firstHour = Math.ceil(from / HOUR) * HOUR;
  for (let t = firstHour; t <= anchor; t += HOUR) {
    const hour = new Date(t).getHours();
    ticks.push({ t, hour, major: hour % 3 === 0 });
  }

  const nightBands: { x1: number; x2: number }[] = [];
  for (let t = Math.floor(from / HOUR) * HOUR; t < anchor; t += HOUR) {
    const hour = new Date(t).getHours();
    if (hour >= 22 || hour < 7) {
      nightBands.push({ x1: Math.max(0, x(t)), x2: Math.min(W, x(t + HOUR)) });
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Последние 24 часа</h2>
        <span className="panel__rule" />
        <span className="panel__meta">сон {formatMinutes(totalMs / 60000)}</span>
      </div>
      <div className="panel__body">
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="seg-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#b9f8ff" />
              <stop offset="55%" stopColor="#5fd9f2" />
              <stop offset="100%" stopColor="#2196b3" />
            </linearGradient>
          </defs>

          {/* ночь */}
          {nightBands.map((b, i) => (
            <rect
              key={`n${i}`}
              x={b.x1}
              y={TRACK_Y}
              width={Math.max(0, b.x2 - b.x1)}
              height={TRACK_H}
              fill="rgba(90,130,255,0.07)"
            />
          ))}

          {/* корпус ленты */}
          <rect
            x="0"
            y={TRACK_Y}
            width={W}
            height={TRACK_H}
            fill="rgba(63,233,255,0.045)"
            stroke="rgba(63,233,255,0.22)"
            strokeWidth="1"
          />

          {/* часовые риски */}
          {ticks.map((tick) => (
            <line
              key={tick.t}
              x1={x(tick.t)}
              x2={x(tick.t)}
              y1={TRACK_Y}
              y2={tick.major ? TRACK_BOTTOM : TRACK_Y + 10}
              stroke={tick.major ? 'rgba(63,233,255,0.22)' : 'rgba(63,233,255,0.16)'}
              strokeWidth="1"
            />
          ))}

          {/* интервалы сна */}
          {segments.map((seg) => {
            const x1 = x(seg.start);
            const width = Math.max(3, x(seg.end) - x1);
            return (
              <g key={seg.id} className="seg-appear" style={{ transformOrigin: `0 ${TRACK_Y + TRACK_H / 2}px` }}>
                <rect
                  x={x1}
                  y={TRACK_Y + 3}
                  width={width}
                  height={TRACK_H - 6}
                  fill="url(#seg-grad)"
                  opacity={seg.ongoing ? 1 : 0.94}
                />
                <rect x={x1} y={TRACK_Y + 3} width={width} height="3" fill="#c9f8ff" opacity="0.9" />
                {width > 96 && (
                  <text
                    x={x1 + width / 2}
                    y={TRACK_Y + TRACK_H / 2 + 10}
                    textAnchor="middle"
                    className="seg-label"
                    fill="#032027"
                  >
                    {shortDuration(seg.end - seg.start)}
                  </text>
                )}
              </g>
            );
          })}

          {/* подписи часов */}
          {ticks
            .filter((t) => t.major)
            // у правого края подпись налезала бы на отметку «сейчас»
            .filter((t) => x(t.t) < W - 40)
            .map((tick) => {
              const cx = x(tick.t);
              const edge = cx < 34;
              return (
                <text
                  key={`l${tick.t}`}
                  x={edge ? 0 : cx}
                  y={H - 20}
                  textAnchor={edge ? 'start' : 'middle'}
                  className="axis-label"
                  fill={tick.hour === 0 ? 'var(--violet)' : 'var(--text-faint)'}
                >
                  {String(tick.hour).padStart(2, '0')}:00
                </text>
              );
            })}

          {/* отметка «сейчас» */}
          <g className="now-marker">
            <line x1={W - 1} x2={W - 1} y1={TRACK_Y - 10} y2={TRACK_BOTTOM + 8} stroke="var(--accent)" strokeWidth="3" />
            <polygon
              points={`${W - 11},${TRACK_Y - 20} ${W + 9},${TRACK_Y - 20} ${W - 1},${TRACK_Y - 8}`}
              fill="var(--accent)"
            />
          </g>
        </svg>
      </div>
    </section>
  );
}
