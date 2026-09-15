import { useMemo } from 'react';
import { useClock } from './hooks/useClock';
import { isDebug, useStage, type StageInfo } from './hooks/useStage';
import { useTracker } from './hooks/useTracker';
import { TopBar } from './components/TopBar';
import { HeroPanel } from './components/HeroPanel';
import { SummaryPanel } from './components/SummaryPanel';
import { DayTimeline } from './components/DayTimeline';
import { WeightPanel } from './components/WeightPanel';
import { UtteranceFeed } from './components/UtteranceFeed';
import { StatusBar } from './components/StatusBar';
import { findOngoing, localDate, summarizeDay } from './lib/day';

/** Сколько суток ребёнку — считаем локально, чтобы цифра не «застывала» до следующего state. */
function ageDays(birthDate: string, now: number, fallback: number): number {
  const born = Date.parse(`${birthDate}T00:00:00`);
  if (!Number.isFinite(born)) return fallback;
  return Math.max(0, Math.floor((now - born) / 86_400_000));
}

/** Виден только по ?debug=1 — чтобы можно было снять метрики прямо с телевизора. */
function DebugPanel({ stage, link }: { stage: StageInfo; link: string }) {
  return (
    <div className="debug">
      {[
        `видимая область  ${stage.w}×${stage.h}`,
        `масштаб          ${stage.scale.toFixed(4)} (запас ${stage.safe})`,
        `clientWidth      ${stage.client}`,
        `innerWidth       ${stage.inner}`,
        `visualViewport   ${stage.visual}`,
        `dpr              ${stage.dpr}`,
        `связь            ${link}`,
      ].join('\n')}
    </div>
  );
}

function Boot({ link }: { link: string }) {
  return (
    <div className="boot">
      <span className="boot__title">ANDREYTRACKER</span>
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
  const stage = useStage();
  const debug = isDebug();
  const tick = useClock();
  const { state, events, measures, utterances, link, health, lastSyncAt, clockOffset, booting } =
    useTracker();

  // Единое «сейчас» для всего экрана: локальные часы, выровненные по серверу.
  const now = tick + clockOffset;

  const todayDate = state?.today.date ?? localDate(now);
  // Кормлений и подгузников в /api/state нет — считаем из событий сами.
  const day = useMemo(() => summarizeDay(events, todayDate), [events, todayDate]);
  // Идущее занятие пересчитывается каждую секунду: порог «забытой фразы»
  // зависит от текущего времени.
  const ongoing = useMemo(() => findOngoing(events, now), [events, now]);
  // Фразу связываем и со старыми замерами: «12 сентября он весил 4 528»
  // породило событие за пределами 30-часового окна.
  const linkable = useMemo(() => [...events, ...measures], [events, measures]);
  const asleep = state?.sleep.status === 'asleep';
  const busy = !asleep && ongoing !== null && !ongoing.stale;
  const stateClass = asleep ? 'is-asleep' : busy ? 'is-feeding' : 'is-awake';

  return (
    <>
      {debug && <DebugPanel stage={stage} link={link} />}
      <div className={`stage ${stateClass}`}>
        <div className="stage__drift">
          <div className="backdrop" />

          {booting || !state ? (
            <Boot link={link} />
          ) : (
            <div className="layout">
              <TopBar now={now} />

              <HeroPanel
                state={state}
                events={events}
                feeds={day.feeds}
                ongoing={ongoing}
                now={now}
              />

              <div className="main">
                <div className="col">
                  <DayTimeline events={events} now={now} />
                  <WeightPanel measures={measures} now={now} />
                </div>

                <SummaryPanel today={state.today} day={day} />

                <UtteranceFeed
                  utterances={utterances}
                  events={linkable}
                  pending={state.pending}
                />
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
    </>
  );
}
