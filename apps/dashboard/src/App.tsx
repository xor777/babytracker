import { useMemo } from 'react';
import { useClock, useStageScale } from './hooks/useClock';
import { useTracker } from './hooks/useTracker';
import { TopBar } from './components/TopBar';
import { StatusHero } from './components/StatusHero';
import { SummaryPanel } from './components/SummaryPanel';
import { DayTimeline } from './components/DayTimeline';
import { HistoryChart } from './components/HistoryChart';
import { UtteranceFeed } from './components/UtteranceFeed';
import { StatusBar } from './components/StatusBar';
import type { DailySleep, TrackerState } from './types';

function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Сколько суток ребёнку — считаем локально, чтобы цифра не «застывала» до следующего state. */
function ageDays(birthDate: string, now: number, fallback: number): number {
  const born = Date.parse(`${birthDate}T00:00:00`);
  if (!Number.isFinite(born)) return fallback;
  return Math.max(0, Math.floor((now - born) / 86_400_000));
}

/**
 * Сегодняшний столбец в истории обновляем из /api/state, не дожидаясь
 * следующего запроса /api/sleep/daily.
 */
function mergeToday(days: DailySleep[], state: TrackerState | null): DailySleep[] {
  if (!state) return days;
  const { date, sleepTotalMin, sleepSessions } = state.today;
  const idx = days.findIndex((d) => d.date === date);
  if (idx === -1) return [...days, { date, totalMin: sleepTotalMin, sessions: sleepSessions }];
  const next = days.slice();
  next[idx] = { ...next[idx], totalMin: sleepTotalMin, sessions: sleepSessions };
  return next;
}

function Boot({ link }: { link: string }) {
  return (
    <div className="boot">
      <span className="boot__title">BABYTRACKER</span>
      <div className="boot__bar">
        <i />
      </div>
      <span className="boot__line">
        {link === 'offline' ? 'сервер не отвечает · повтор' : 'подключение к телеметрии'}
      </span>
    </div>
  );
}

export default function App() {
  useStageScale();
  const tick = useClock();
  const { state, events, days, utterances, link, health, lastSyncAt, clockOffset, booting } =
    useTracker();

  // Единое «сейчас» для всего экрана: локальные часы, выровненные по серверу.
  const now = tick + clockOffset;

  const history = useMemo(() => mergeToday(days, state), [days, state]);
  const todayDate = state?.today.date ?? localDate(now);
  const asleep = state?.sleep.status === 'asleep';

  return (
    <div className={`stage ${asleep ? 'is-asleep' : 'is-awake'}`}>
      <div className="stage__drift">
        <div className="backdrop" />

        {booting || !state ? (
          <Boot link={link} />
        ) : (
          <div className="layout">
            <TopBar now={now} childName={state.child.name} />

            <StatusHero state={state} events={events} now={now} />

            <div className="main">
              <div className="col">
                <DayTimeline events={events} now={now} />
                <HistoryChart days={history} todayDate={todayDate} />
              </div>

              <SummaryPanel today={state.today} />

              <UtteranceFeed utterances={utterances} pending={state.pending} />
            </div>

            <StatusBar
              link={link}
              health={health}
              pending={state.pending}
              lastSyncAt={lastSyncAt}
              now={now}
              childName={state.child.name}
              ageDays={ageDays(state.child.birthDate, now, state.child.ageDays)}
            />
          </div>
        )}

        {link === 'offline' && !booting && <div className="offline-frame" />}
        <div className="scanlines" />
        <div className="sweep" />
      </div>
    </div>
  );
}
