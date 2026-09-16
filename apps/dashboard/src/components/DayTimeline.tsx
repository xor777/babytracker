import { useMemo } from 'react';
import type { TrackerEvent } from '../types';
import { formatMinutes, HOUR, parseTs } from '../lib/format';
import { toSegments } from '../lib/sleep';
import { zonedHour } from '../lib/tz';
import { clampCenter, FEED_TOP, marksInWindow, RIBBON, TRACK_BOTTOM } from '../lib/ribbon';

interface Props {
  events: TrackerEvent[];
  now: number;
}

/*
 * Полка меток.
 *
 * Смотрят с трёх метров, и цветом одним различать нельзя: близкие оттенки
 * на таком расстоянии сливаются, а у части людей не различаются и вблизи.
 * Поэтому кормления и подгузники разведены признаками, которые видны формой:
 * еда — прямоугольные столбики ВВЕРХ от полки, подгузники — круглые метки
 * ВНИЗ от неё. Направление и силуэт читаются даже боковым зрением и в серых
 * тонах; цвет (зелёный/фиолетовый — те же, что у счётчиков в «Сутках»)
 * остаётся приятным дополнением, а не несущей конструкцией.
 *
 * Кружок подгузника крупнее, чем кажется нужным: фиолетовый заметно темнее
 * зелёного (в серых тонах 141 против 212), и метки поменьше на уменьшенном
 * снимке попросту пропадали. Разницу в светлоте оставляем — она и есть
 * различие без цвета, — а видимость добираем площадью.
 *
 * Это по-прежнему одна полка, а не третья дорожка: третья дорожка когда-то
 * превращала ленту в шум, и это решение в силе. Сон выше и вдвое крупнее —
 * он остаётся главным.
 *
 * Сами числа и правила — в lib/ribbon.ts, они под тестом.
 */
const { W, H, TRACK_Y, TRACK_H, SHELF_Y, FEED_W, FEED_H, DIAPER_R, DIAPER_CY } = RIBBON;
/** Тёмная обводка меток: соседние метки не сливаются в одно пятно. */
const MARK_EDGE = '#04121a';
const SPAN = 24 * HOUR;

function shortDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}ч${String(m).padStart(2, '0')}` : `${m}м`;
}

/** Моменты живых событий одного типа, попавшие в окно ленты. */
function marksOf(events: TrackerEvent[], type: string, from: number, to: number): number[] {
  const times = events
    .filter((ev) => ev.type === type && !ev.deleted_at)
    .map((ev) => parseTs(ev.started_at))
    .filter((ms): ms is number => ms != null);
  return marksInWindow(times, from, to);
}

export function DayTimeline({ events, now }: Props) {
  // Пересчитываем раз в полминуты, а не каждый тик секундомера.
  const anchor = Math.floor(now / 30_000) * 30_000;
  const from = anchor - SPAN;

  const segments = useMemo(() => toSegments(events, from, anchor), [events, from, anchor]);
  const feedMarks = useMemo(() => marksOf(events, 'feed', from, anchor), [events, from, anchor]);
  const diaperMarks = useMemo(() => marksOf(events, 'diaper', from, anchor), [events, from, anchor]);

  const totalMs = segments.reduce((acc, s) => acc + (s.end - s.start), 0);
  const x = (t: number) => ((t - from) / SPAN) * W;

  const ticks: { t: number; hour: number; major: boolean }[] = [];
  const firstHour = Math.ceil(from / HOUR) * HOUR;
  for (let t = firstHour; t <= anchor; t += HOUR) {
    const hour = zonedHour(t);
    ticks.push({ t, hour, major: hour % 3 === 0 });
  }

  const nightBands: { x1: number; x2: number }[] = [];
  for (let t = Math.floor(from / HOUR) * HOUR; t < anchor; t += HOUR) {
    const hour = zonedHour(t);
    if (hour >= 22 || hour < 7) {
      nightBands.push({ x1: Math.max(0, x(t)), x2: Math.min(W, x(t + HOUR)) });
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Последние 24 часа</h2>
        <span className="panel__rule" />
        {/*
          Легенда. У сна цвет подписи совпадает с цветом дорожки — этого хватает,
          дорожка одна и ни с чем не спорит. У меток легендой служит сам значок:
          «подгузники 10» словами не помещались (964 px при 892 доступных — линейка
          схлопывалась в ноль), а главное — различать их всё равно надо формой,
          а не словом. Значок в шапке ровно тот же, что на ленте.
        */}
        <span className="panel__meta panel__meta--sleep">сон {formatMinutes(totalMs / 60000)}</span>
        <span className="panel__meta panel__meta--feed" title="кормления">
          <i className="legend legend--feed" />
          {feedMarks.length}
        </span>
        <span className="panel__meta panel__meta--diaper" title="подгузники">
          <i className="legend legend--diaper" />
          {diaperMarks.length}
        </span>
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

          <rect
            x="0"
            y={TRACK_Y}
            width={W}
            height={TRACK_H}
            fill="rgba(63,233,255,0.045)"
            stroke="rgba(63,233,255,0.22)"
            strokeWidth="1"
          />

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

          {/* сон */}
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
            // У правого края подпись налезала бы на отметку «сейчас», а у левого
            // прижатая к нулю подпись слипалась со следующей — такую пропускаем.
            .filter((t) => {
              const cx = x(t.t);
              return cx >= 26 && cx < W - 40;
            })
            .map((tick) => {
              const cx = x(tick.t);
              const edge = cx < 40;
              return (
                <text
                  key={`l${tick.t}`}
                  x={edge ? 0 : cx}
                  y={H - 8}
                  textAnchor={edge ? 'start' : 'middle'}
                  className="axis-label"
                  fill={tick.hour === 0 ? 'var(--violet)' : 'var(--text-faint)'}
                >
                  {String(tick.hour).padStart(2, '0')}:00
                </text>
              );
            })}

          <g className="now-marker">
            <line x1={W - 1} x2={W - 1} y1={TRACK_Y - 8} y2={SHELF_Y} stroke="var(--accent)" strokeWidth="3" />
            <polygon
              points={`${W - 11},${TRACK_Y - 14} ${W + 9},${TRACK_Y - 14} ${W - 1},${TRACK_Y - 3}`}
              fill="var(--accent)"
            />
          </g>

          {/*
            Метки рисуются последними — поверх отметки «сейчас»: самая свежая
            запись всегда стоит у правого края и раньше терялась под ней.
          */}
          {/* полка: от неё еда растёт вверх, подгузники висят вниз */}
          <line x1="0" x2={W} y1={SHELF_Y} y2={SHELF_Y} stroke="rgba(63,233,255,0.3)" strokeWidth="1" />

          {/* кормления — столбики вверх от полки */}
          {feedMarks.map((ms) => {
            const cx = clampCenter(x(ms), FEED_W / 2);
            return (
              <g key={`f${ms}`} className="seg-appear" style={{ transformOrigin: `0 ${SHELF_Y}px` }}>
                <rect
                  x={cx - FEED_W / 2}
                  y={FEED_TOP}
                  width={FEED_W}
                  height={FEED_H}
                  rx="3"
                  fill="var(--green)"
                  stroke={MARK_EDGE}
                  strokeWidth="2"
                />
                {/* светлая кромка сверху — как у блоков сна: метка читается объёмной */}
                <rect x={cx - FEED_W / 2 + 2} y={FEED_TOP + 2} width={FEED_W - 4} height="4" rx="1.5" fill="#d9ffee" />
              </g>
            );
          })}

          {/* подгузники — круглые метки вниз от полки */}
          {diaperMarks.map((ms) => (
            <circle
              key={`d${ms}`}
              className="seg-appear"
              style={{ transformOrigin: `0 ${SHELF_Y}px` }}
              cx={clampCenter(x(ms), DIAPER_R + 1)}
              cy={DIAPER_CY}
              r={DIAPER_R}
              fill="var(--violet)"
              stroke={MARK_EDGE}
              strokeWidth="2"
            />
          ))}
        </svg>
      </div>
    </section>
  );
}
