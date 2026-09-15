import type { TrackerState } from '../types';
import type { DaySummary } from '../lib/day';
import { plural, splitMinutes } from '../lib/format';
import { formatTime } from '../lib/format';

interface Props {
  today: TrackerState['today'];
  day: DaySummary;
}

function Stat({
  label,
  color,
  value,
  sub,
}: {
  label: string;
  color: string;
  value: React.ReactNode;
  sub: string;
}) {
  return (
    <div className="stat" style={{ ['--stat-color' as string]: color }}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      <span className="stat__sub">{sub}</span>
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

function hhmm(min: number): string {
  const h = Math.floor(min / 60);
  return `${h}:${String(Math.round(min % 60)).padStart(2, '0')}`;
}

export function SummaryPanel({ today, day }: Props) {
  const { feeds, diapers } = day;

  // «макс 0:00» — не факт о сне, а его отсутствие: отрезок есть, а длины у него
  // нет (сон ещё идёт или записан «начало = конец»). Тогда молчим про максимум.
  const sleepCount = `${today.sleepSessions} ${plural(today.sleepSessions, 'сон', 'сна', 'снов')}`;
  const sleepSub =
    today.sleepSessions > 0
      ? today.longestSleepMin > 0
        ? `${sleepCount} · макс ${hhmm(today.longestSleepMin)}`
        : sleepCount
      : 'пока не спал';

  // «—» вместо «0»: мы не знаем, что кормлений не было — мы знаем, что их
  // не записывали. Ноль на стене в детской читался бы как тревога.
  const feedSub = !feeds.everRecorded
    ? 'пока не записывали'
    : feeds.count === 0
      ? 'сегодня записей нет'
      : [
          feeds.withMl > 0 ? `${Math.round(feeds.totalMl)} мл` : null,
          feeds.last ? `в ${formatTime(feeds.last.started_at)}` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  const diaperSub = !diapers.everRecorded
    ? 'пока не записывали'
    : diapers.count === 0
      ? 'сегодня записей нет'
      : `${diapers.wet} мокрых, ${diapers.dirty} грязных`;

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Сутки</h2>
        <span className="panel__rule" />
      </div>
      <div className="panel__body summary">
        <Stat
          label="Сон"
          color="var(--cyan-soft)"
          value={<Duration min={today.sleepTotalMin} />}
          sub={sleepSub}
        />
        <Stat
          label="Кормлений"
          color="var(--green)"
          value={feeds.everRecorded ? feeds.count : '—'}
          sub={feedSub}
        />
        <Stat
          label="Подгузников"
          color="var(--violet)"
          value={diapers.everRecorded ? diapers.count : '—'}
          sub={diaperSub}
        />
      </div>
    </section>
  );
}
