import { useMemo } from 'react';
import type { TrackerEvent, TrackerState } from '../types';
import { formatMinutes, formatStopwatch, formatTime, parseTs } from '../lib/format';

interface Props {
  state: TrackerState;
  events: TrackerEvent[];
  /** Время сервера (локальные часы + сдвиг), мс. */
  now: number;
}

/** Бесшовная синусоида: период 200 юнитов, полотно 400 → сдвиг на 50% незаметен. */
function wavePath(asleep: boolean): string {
  const width = 400;
  const mid = 54;
  const step = 2;
  let d = '';
  for (let x = 0; x <= width; x += step) {
    const p = (x / 200) * Math.PI * 2;
    const y = asleep
      ? mid - 26 * Math.sin(p * 2) - 5 * Math.sin(p * 4)
      : mid - 15 * Math.sin(p * 4) - 9 * Math.sin(p * 9) - 5 * Math.sin(p * 13);
    d += `${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(1)}`;
  }
  return d;
}

function subtypeLabel(subtype: string | null | undefined): string | null {
  if (subtype === 'night') return 'ночной сон';
  if (subtype === 'nap') return 'дневной сон';
  return null;
}

export function StatusHero({ state, events, now }: Props) {
  const asleep = state.sleep.status === 'asleep';
  const sinceMs = parseTs(state.sleep.since);

  // Таймер тикает локально: сервер для этого не нужен.
  const elapsed = sinceMs != null ? Math.max(0, now - sinceMs) : state.sleep.currentDurationMin * 60_000;
  const { hm, sec } = formatStopwatch(elapsed);

  const openEvent = useMemo(
    () => events.find((ev) => ev.type === 'sleep' && !ev.ended_at && !ev.deleted_at),
    [events],
  );

  const path = useMemo(() => wavePath(asleep), [asleep]);

  const kind = asleep ? subtypeLabel(openEvent?.subtype) : null;
  const last = state.sleep.lastSleep;

  return (
    <section className={`panel panel--accent hero ${asleep ? 'is-asleep' : 'is-awake'}`}>
      <div className="hero__left">
        <div className="orb" style={{ ['--orb-speed' as string]: asleep ? '5.5s' : '2.6s' }}>
          <span className="orb__ring" />
          <span className="orb__pulse" />
          <span className="orb__core" />
        </div>
        <div className="hero__status">
          <span className="hero__label">Андрей сейчас</span>
          <span className="hero__word">{asleep ? 'СПИТ' : 'БОДРСТВУЕТ'}</span>
          <span className="hero__since">
            {asleep ? 'уснул в ' : 'проснулся в '}
            <b>{formatTime(state.sleep.since)}</b>
            {kind ? ` · ${kind}` : ''}
            {!asleep && last ? ` · прошлый сон ${formatMinutes(last.durationMin)}` : ''}
          </span>
        </div>
      </div>

      <div className="hero__wave" style={{ ['--wave-speed' as string]: asleep ? '16s' : '8s' }}>
        <svg viewBox="0 0 400 108" preserveAspectRatio="none" aria-hidden="true">
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        </svg>
      </div>

      <div className="hero__timer">
        <span className="hero__timer-label">уже</span>
        <span className="hero__timer-value">
          {hm}
          <span className="hero__timer-sec">:{sec}</span>
        </span>
      </div>
    </section>
  );
}
