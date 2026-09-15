import type { TrackerState } from '../types';
import { splitMinutes } from '../lib/format';

interface Props {
  today: TrackerState['today'];
}

interface StatProps {
  label: string;
  color: string;
  children: React.ReactNode;
  bar?: number;
}

function Stat({ label, color, children, bar }: StatProps) {
  return (
    <div className="stat" style={{ ['--stat-color' as string]: color }}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{children}</span>
      {bar != null && (
        <span className="stat__bar">
          <i style={{ width: `${Math.min(100, Math.max(0, bar * 100)).toFixed(1)}%` }} />
        </span>
      )}
    </div>
  );
}

function Duration({ min }: { min: number }) {
  const { h, m, showHours } = splitMinutes(min);
  return (
    <>
      {showHours && (
        <>
          {h}
          <span className="stat__unit">ч</span>
        </>
      )}
      {m}
      <span className="stat__unit">м</span>
    </>
  );
}

export function SummaryPanel({ today }: Props) {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Сутки</h2>
        <span className="panel__rule" />
      </div>
      <div className="panel__body summary">
        <Stat label="Сон всего" color="var(--cyan-soft)" bar={today.sleepTotalMin / (24 * 60)}>
          <Duration min={today.sleepTotalMin} />
        </Stat>
        <Stat label="Засыпаний" color="var(--violet)">
          {today.sleepSessions}
        </Stat>
        <Stat label="Дольше всего" color="var(--green)">
          <Duration min={today.longestSleepMin} />
        </Stat>
      </div>
    </section>
  );
}
