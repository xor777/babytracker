import type { CSSProperties } from 'react';
import { useOverview } from '../hooks/useOverview';
import {
  MINUTE,
  formatHours,
  formatMinutes,
  formatTime,
  parseTs,
  plural,
  splitStopwatch,
} from '../lib/format';
import { DayStrip } from './DayStrip';
import { NormMeter } from './NormMeter';
import type { TrackerEvent } from '../types';

interface LastCardProps {
  label: string;
  tone: string;
  event: TrackerEvent | null;
  now: number;
  /** Сон показываем иначе: он может идти прямо сейчас. */
  ongoing?: boolean;
}

function LastCard({ label, tone, event, now, ongoing }: LastCardProps) {
  const at = parseTs(event?.started_at);
  // Три карточки в ряд на 390 px — это ~110 px на каждую. Всё, что длиннее
  // «2 ч 7 мин», рассыпается на три строки, поэтому «назад» уехало в подпись.
  const ago = at != null ? formatMinutes(Math.round((now - at) / MINUTE)) : null;

  return (
    <div className="lastcard" style={{ '--tone': tone } as CSSProperties}>
      <div className="lastcard__label">{label}</div>
      {at == null ? (
        <div className="lastcard__empty">ещё не записывали</div>
      ) : ongoing ? (
        <>
          <div className="lastcard__value">идёт</div>
          <div className="lastcard__sub">с {formatTime(at)}</div>
        </>
      ) : (
        <>
          <div className="lastcard__value">{ago}</div>
          <div className="lastcard__sub">назад · {formatTime(at)}</div>
        </>
      )}
    </div>
  );
}

export function OverviewScreen() {
  const o = useOverview();

  if (o.status === 'error') {
    return (
      <div className="banner" role="status">
        <span>{o.error}</span>
        <button type="button" className="banner__btn" onClick={o.reload}>
          Ещё раз
        </button>
      </div>
    );
  }

  if (o.status === 'loading' && !o.state) {
    return <p className="placeholder">Смотрю, что происходит…</p>;
  }

  const asleep = o.state?.sleep?.status === 'asleep';
  const sinceMs = parseTs(o.state?.sleep?.since);
  const elapsed = sinceMs != null ? Math.max(0, o.now - sinceMs) : null;
  const watch = elapsed != null ? splitStopwatch(elapsed) : null;

  const feedCount = o.today?.feeds.total ?? o.timeline.feeds.length;
  const wet = (o.today?.diapers.wet ?? 0) + (o.today?.diapers.both ?? 0);
  const dirty = (o.today?.diapers.dirty ?? 0) + (o.today?.diapers.both ?? 0);
  const diaperCount = o.today?.diapers.total ?? o.timeline.diapers.length;
  const sleepMin = o.today?.sleep.totalMin ?? o.timeline.sleepMin;

  const nothingToday =
    o.timeline.sleeps.length === 0 &&
    o.timeline.feeds.length === 0 &&
    o.timeline.diapers.length === 0;
  const nothingAtAll = o.events.length === 0;

  // Пока состояния нет — нейтральный акцент: янтарный читался бы как предупреждение,
  // а «записей ещё не было» у двухнедельного ребёнка это норма, а не проблема.
  const tone = sinceMs == null ? 'var(--cyan)' : asleep ? 'var(--t-sleep)' : 'var(--amber)';

  return (
    <>
      {/* --- что происходит прямо сейчас --- */}
      <section className="hero" style={{ '--tone': tone } as CSSProperties}>
        {sinceMs == null ? (
          <>
            <div className="hero__state">Пока тихо</div>
            <p className="hero__sub">
              Состояние появится, как только вы скажете Алисе первое «заснул» или
              «покормила».
            </p>
          </>
        ) : (
          <>
            <div className="hero__state">{asleep ? 'Спит' : 'Бодрствует'}</div>
            <div className="hero__timer">
              <span className="hero__hm">{watch?.hm}</span>
              <span className="hero__sec">:{watch?.sec}</span>
            </div>
            <p className="hero__sub">
              {asleep ? 'уснул' : 'проснулся'} в {formatTime(sinceMs)}
              {o.state?.sleep?.lastSleep && !asleep
                ? ` · прошлый сон ${formatMinutes(o.state.sleep.lastSleep.durationMin)}`
                : ''}
            </p>
          </>
        )}
        {(o.state?.pending ?? 0) > 0 ? (
          <div className="hero__pending">
            Алиса разбирает {o.state?.pending}{' '}
            {plural(o.state?.pending ?? 0, 'фразу', 'фразы', 'фраз')}
          </div>
        ) : null}
      </section>

      {/* --- когда в последний раз --- */}
      <div className="lastrow">
        <LastCard label="Кормление" tone="var(--t-feed)" event={o.last.feed} now={o.now} />
        <LastCard label="Подгузник" tone="var(--t-diaper)" event={o.last.diaper} now={o.now} />
        <LastCard
          label="Сон"
          tone="var(--t-sleep)"
          event={o.last.sleep}
          now={o.now}
          ongoing={asleep}
        />
      </div>

      {/* --- ритм суток --- */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">Сутки</h2>
          <span className="card__aside">{formatTime(o.now)}</span>
        </div>
        <DayStrip timeline={o.timeline} />
        {o.gaps ? (
          <p className="card__note">
            Между кормлениями в среднем {formatMinutes(o.gaps.avgMin)}, самый длинный
            промежуток {formatMinutes(o.gaps.maxMin)}.
          </p>
        ) : null}
      </section>

      {/* --- итоги суток --- */}
      {nothingToday ? (
        <div className="empty empty--inline">
          <h2 className="empty__title">Сегодня записей пока нет</h2>
          <p className="empty__text">
            {nothingAtAll
              ? 'Скажите Алисе «Андрей заснул» или «покормила» — запись появится здесь через пару секунд.'
              : 'Вчерашние записи никуда не делись — они в Журнале.'}
          </p>
        </div>
      ) : (
        <section className="card">
          <div className="card__head">
            <h2 className="card__title">Сегодня</h2>
            <span className="card__aside">сутки ещё идут</span>
          </div>

          <div className="tiles">
            <div className="tile" style={{ '--tone': 'var(--t-feed)' } as CSSProperties}>
              <div className="tile__value">{feedCount}</div>
              <div className="tile__label">
                {plural(feedCount, 'кормление', 'кормления', 'кормлений')}
              </div>
            </div>
            <div className="tile" style={{ '--tone': 'var(--t-diaper)' } as CSSProperties}>
              <div className="tile__value">{diaperCount}</div>
              <div className="tile__label">
                {plural(diaperCount, 'подгузник', 'подгузника', 'подгузников')}
              </div>
              {diaperCount > 0 ? (
                <div className="tile__hint">
                  {wet} мокрых · {dirty} грязных
                </div>
              ) : null}
            </div>
            <div className="tile" style={{ '--tone': 'var(--t-sleep)' } as CSSProperties}>
              <div className="tile__value">{formatHours(sleepMin)}</div>
              <div className="tile__label">сна</div>
              {o.today?.sleep.sessions ? (
                <div className="tile__hint">
                  {o.today.sleep.sessions}{' '}
                  {plural(o.today.sleep.sessions, 'отрезок', 'отрезка', 'отрезков')}
                </div>
              ) : null}
            </div>
          </div>

          {/* Ориентиры показываем спокойно и только там, где сервер их прислал.
              За неполные сутки вердикт не выносится — об этом сказано выше. */}
          {o.today?.norms?.feeds ? (
            <div className="overview__norm">
              <div className="overview__norm-label">Кормления за сутки</div>
              <NormMeter
                value={feedCount}
                norm={o.today.norms.feeds}
                partial
                tone="var(--t-feed)"
              />
            </div>
          ) : null}
          {o.today?.norms?.wetDiapers ? (
            <div className="overview__norm">
              <div className="overview__norm-label">Мокрые подгузники</div>
              <NormMeter
                value={wet}
                norm={o.today.norms.wetDiapers}
                partial
                tone="var(--t-diaper)"
              />
            </div>
          ) : null}
        </section>
      )}
    </>
  );
}
