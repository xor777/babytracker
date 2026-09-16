import { useMemo } from 'react';
import type { TrackerEvent, TrackerState } from '../types';
import { formatMinutes, formatStopwatch, formatTime, parseTs } from '../lib/format';
import { feedHeadline, type FeedSummary, type OngoingActivity } from '../lib/day';

interface Props {
  state: TrackerState;
  events: TrackerEvent[];
  feeds: FeedSummary;
  /** Идущее занятие (кормление, купание…) или просроченное открытое событие. */
  ongoing: OngoingActivity | null;
  /** Время сервера (локальные часы + сдвиг), мс. */
  now: number;
}

/** Бесшовная синусоида: период 200 юнитов, полотно 400 → сдвиг на 50% незаметен. */
function wavePath(calm: boolean): string {
  const width = 400;
  const mid = 54;
  const step = 2;
  let d = '';
  for (let x = 0; x <= width; x += step) {
    const p = (x / 200) * Math.PI * 2;
    const y = calm
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

/**
 * Секундомер — признак живого. Тикающие секунды и акцентный цвет есть только
 * у того, что происходит прямо сейчас.
 */
function Timer({ ms }: { ms: number }) {
  const { hm, sec } = formatStopwatch(ms);
  return (
    <span className="hero__timer">
      {hm}
      <span className="hero__timer-sec">:{sec}</span>
    </span>
  );
}

/**
 * Прошедшее событие. Растущий счётчик «01:12:44» выглядел точно так же, как
 * идущий, и читался как «кормление ещё идёт» — слово «назад» с трёх метров
 * не видно. Поэтому у прошедшего крупно стоит **время события**, оно не
 * меняется, а «сколько прошло» — мелко, словами и без секунд.
 */
function Past({ at, now, tail }: { at: number; now: number; tail?: string }) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return (
    <>
      <span className="hero__when">
        <span className="hero__when-prefix">в</span>
        {formatTime(at)}
      </span>
      <span className="hero__ago">
        {minutes < 1 ? 'только что' : `${formatMinutes(minutes)} назад`}
        {tail ? ` · ${tail}` : ''}
      </span>
    </>
  );
}

/**
 * Главная строка показывает самое конкретное из верного.
 * Сон — состояние, кормление — занятие внутри бодрствования: «БОДРСТВУЕТ»
 * во время кормления формально верно, но бесполезно.
 */
function StateHalf({
  state,
  events,
  feeds,
  ongoing,
  now,
}: {
  state: TrackerState;
  events: TrackerEvent[];
  feeds: FeedSummary;
  ongoing: OngoingActivity | null;
  now: number;
}) {
  const asleep = state.sleep.status === 'asleep';
  const sinceMs = parseTs(state.sleep.since);
  const awakeFor =
    sinceMs != null ? Math.max(0, now - sinceMs) : state.sleep.currentDurationMin * 60_000;

  const openEvent = useMemo(
    () => events.find((ev) => ev.type === 'sleep' && !ev.ended_at && !ev.deleted_at),
    [events],
  );
  const last = state.sleep.lastSleep;
  const busy = !asleep && ongoing !== null && !ongoing.stale;

  if (busy && ongoing) {
    const isFeed = ongoing.event.type === 'feed';
    return (
      <div className="hero__half is-feeding">
        <div className="orb" style={{ ['--orb-speed' as string]: '3.4s' }}>
          <span className="orb__ring" />
          <span className="orb__pulse" />
          <span className="orb__core" />
        </div>
        <div className="hero__stack">
          <span className="hero__label">Андрей сейчас</span>
          <span className="hero__word">{ongoing.word}</span>
          <Timer ms={Math.max(0, now - ongoing.startedAt)} />
          <span className="hero__sub">
            начали в <b>{formatTime(ongoing.startedAt)}</b>
            {isFeed && feeds.count > 0 ? ` · ${feeds.count}-е за сутки` : ''}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`hero__half ${asleep ? 'is-asleep' : 'is-awake'}`}>
      <div className="orb" style={{ ['--orb-speed' as string]: asleep ? '5.5s' : '2.6s' }}>
        <span className="orb__ring" />
        <span className="orb__pulse" />
        <span className="orb__core" />
      </div>
      <div className="hero__stack">
        {/* «СОН · СПИТ» — заголовок, повторяющий значение. Фраза про человека
            читается целиком и работает во всех трёх состояниях. */}
        <span className="hero__label">Андрей сейчас</span>
        <span className="hero__word">{asleep ? 'СПИТ' : 'БОДРСТВУЕТ'}</span>
        <Timer ms={awakeFor} />
        <span className="hero__sub">
          {asleep ? 'уснул в ' : 'проснулся в '}
          <b>{formatTime(state.sleep.since)}</b>
          {asleep && subtypeLabel(openEvent?.subtype) ? ` · ${subtypeLabel(openEvent?.subtype)}` : ''}
          {/* Ноль минут — не длительность, а её отсутствие: «прошлый сон 0 м»
              ничего не сообщает. Ср. «только что» у Past() выше. */}
          {!asleep && last && last.durationMin > 0
            ? ` · прошлый сон ${formatMinutes(last.durationMin)}`
            : ''}
        </span>
      </div>
    </div>
  );
}

function FeedHalf({
  feeds,
  ongoing,
  now,
}: {
  feeds: FeedSummary;
  ongoing: OngoingActivity | null;
  now: number;
}) {
  const openFeed = ongoing && ongoing.event.type === 'feed' ? ongoing : null;

  // Кормление висит открытым дольше порога: «кушает 6 часов» было бы неправдой.
  // Не закрываем его сами и не показываем бегущий таймер — только факт начала.
  if (openFeed?.stale) {
    return (
      <div className="hero__half hero__half--feed">
        <span className="hero__rule" />
        <div className="hero__stack">
          <span className="hero__word hero__word--muted">КОРМЛЕНИЕ НЕ ЗАКРЫТО</span>
          <span className="hero__open">
            начато в <b>{formatTime(openFeed.startedAt)}</b>, окончание неизвестно
          </span>
          <span className="hero__sub hero__sub--faint">
            скажите Алисе: <b>«Андрей поел»</b>
          </span>
        </div>
      </div>
    );
  }

  // Кормление идёт прямо сейчас — его показывает главная строка слева.
  // Здесь полезнее предыдущее: видно, какой получается ритм.
  if (openFeed) {
    const prev = feeds.prev;
    const prevAt = parseTs(prev?.started_at);
    return (
      <div className="hero__half hero__half--feed">
        <span className="hero__rule" />
        <div className="hero__stack">
          <span className="hero__label">
            {prev && prevAt != null ? feedHeadline(prev, 'до этого ел', 'до этого').label : ''}
          </span>
          {prev && prevAt != null ? (
            <>
              <span className="hero__word">{feedHeadline(prev, 'до этого ел', 'до этого').word}</span>
              <Past
                at={prevAt}
                now={now}
                tail={feeds.count > 0 ? `сейчас идёт ${feeds.count}-е` : undefined}
              />
            </>
          ) : (
            <>
              <span className="hero__word hero__word--muted">ПЕРВОЕ КОРМЛЕНИЕ ЗА СУТКИ</span>
              <span className="hero__hint">других сегодня не записано</span>
            </>
          )}
        </div>
      </div>
    );
  }

  const last = feeds.last;
  const at = parseTs(last?.started_at);
  const headline = feedHeadline(last, 'последний раз ел', 'последнее');

  // Пустое состояние — не исключение, а норма первых недель: кормления голосом
  // могут не записывать вовсе. Показываем подсказку, а не сломанный таймер.
  if (!last || at == null) {
    return (
      <div className="hero__half hero__half--feed">
        <span className="hero__rule" />
        <div className="hero__stack">
          <span className="hero__word hero__word--muted">ЕЩЁ НЕ КОРМИЛИ</span>
          <span className="hero__hint">
            скажите Алисе: <b>«Андрей поел 120 миллилитров»</b>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="hero__half hero__half--feed">
      <span className="hero__rule" />
      <div className="hero__stack">
        <span className="hero__label">{headline.label}</span>
        <span className="hero__word">{headline.word}</span>
        <Past at={at} now={now} tail={feeds.count > 0 ? `${feeds.count}-е за сутки` : undefined} />
      </div>
    </div>
  );
}

export function HeroPanel({ state, events, feeds, ongoing, now }: Props) {
  const asleep = state.sleep.status === 'asleep';
  const busy = !asleep && ongoing !== null && !ongoing.stale;
  const path = useMemo(() => wavePath(asleep), [asleep]);

  return (
    <section
      className={`panel panel--accent hero ${asleep ? 'is-asleep' : busy ? 'is-feeding' : 'is-awake'}`}
    >
      <div
        className="hero__wave"
        style={{ ['--wave-speed' as string]: asleep ? '16s' : busy ? '11s' : '8s' }}
      >
        <svg viewBox="0 0 400 108" preserveAspectRatio="none" aria-hidden="true">
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        </svg>
      </div>
      <StateHalf state={state} events={events} feeds={feeds} ongoing={ongoing} now={now} />
      <FeedHalf feeds={feeds} ongoing={ongoing} now={now} />
    </section>
  );
}
