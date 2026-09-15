import { useMemo } from 'react';
import type { DailySleep } from '../types';
import { formatMinutes } from '../lib/format';

interface Props {
  days: DailySleep[];
  /** Локальная дата «сегодня» (YYYY-MM-DD) — подсвечиваем последний столбец. */
  todayDate: string;
}

const W = 892;
const H = 176; // = высота .panel__body у панели 260 px
const BASE_Y = 138;
const TOP_Y = 26;
const LABEL_Y = 166;
const SLOT_COUNT = 14;
/** Слева оставлено место под подписи шкалы (4ч / 8ч / 12ч). */
const PLOT_X = 42;

function hhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function HistoryChart({ days, todayDate }: Props) {
  const data = useMemo(() => days.slice(-SLOT_COUNT), [days]);

  const filled = data.filter((d) => d.totalMin > 0);
  const maxMin = Math.max(600, ...data.map((d) => d.totalMin || 0));
  // Округляем шкалу вверх до целых часов, чтобы столбцы не упирались в потолок.
  const scaleMax = Math.ceil(maxMin / 60) * 60;
  const avg = filled.length
    ? filled.reduce((acc, d) => acc + d.totalMin, 0) / filled.length
    : 0;

  const slot = (W - PLOT_X) / SLOT_COUNT;
  const barW = 42;
  const h = (min: number) => ((min || 0) / scaleMax) * (BASE_Y - TOP_Y);

  const gridLines = [4, 8, 12, 16].filter((hours) => hours * 60 < scaleMax);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">14 дней</h2>
        <span className="panel__rule" />
        <span className="panel__meta">среднее {formatMinutes(avg)}</span>
      </div>
      <div className="panel__body">
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="bar-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7ef0ff" />
              <stop offset="100%" stopColor="#12657a" />
            </linearGradient>
            <linearGradient id="bar-grad-today" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e7c6ff" />
              <stop offset="100%" stopColor="#6b3fb8" />
            </linearGradient>
          </defs>

          {gridLines.map((hours) => (
            <g key={hours}>
              <line
                x1={PLOT_X - 8}
                x2={W}
                y1={BASE_Y - h(hours * 60)}
                y2={BASE_Y - h(hours * 60)}
                stroke="rgba(63,233,255,0.1)"
                strokeWidth="1"
              />
              <text x="0" y={BASE_Y - h(hours * 60) + 8} className="axis-label" fill="var(--text-faint)">
                {hours}ч
              </text>
            </g>
          ))}

          {avg > 0 && (
            <line
              x1={PLOT_X - 8}
              x2={W}
              y1={BASE_Y - h(avg)}
              y2={BASE_Y - h(avg)}
              stroke="rgba(162,115,255,0.5)"
              strokeWidth="2"
              strokeDasharray="10 8"
            />
          )}

          <line x1={PLOT_X - 8} x2={W} y1={BASE_Y} y2={BASE_Y} stroke="rgba(63,233,255,0.3)" strokeWidth="1" />

          {data.map((day, i) => {
            const isToday = day.date === todayDate;
            const cx = PLOT_X + i * slot + slot / 2;
            const barH = Math.max(day.totalMin > 0 ? 4 : 2, h(day.totalMin));
            const y = BASE_Y - barH;
            const dayNum = day.date.slice(8, 10);
            return (
              <g key={day.date}>
                <rect
                  className="seg-appear"
                  style={{ transformOrigin: `0 ${BASE_Y}px`, animationDelay: `${i * 35}ms` }}
                  x={cx - barW / 2}
                  y={y}
                  width={barW}
                  height={barH}
                  fill={isToday ? 'url(#bar-grad-today)' : 'url(#bar-grad)'}
                  opacity={day.totalMin > 0 ? 0.92 : 0.25}
                />
                {day.totalMin > 0 && (
                  <rect x={cx - barW / 2} y={y} width={barW} height="3" fill="#d8faff" opacity="0.85" />
                )}
                {/* Подписи у каждого столбца сливались бы — оставляем только сегодняшнюю. */}
                {isToday && day.totalMin > 0 && (
                  <text x={cx} y={y - 8} textAnchor="middle" className="bar-value bar-value--today">
                    {hhmm(day.totalMin)}
                  </text>
                )}
                <text
                  x={cx}
                  y={LABEL_Y}
                  textAnchor="middle"
                  className={`bar-day${isToday ? ' bar-day--today' : ''}`}
                >
                  {dayNum}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
