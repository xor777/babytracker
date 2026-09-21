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
  event: TrackerEvent | null;
  now: number;
  /** Сон показываем иначе: он может идти прямо сейчас. */
  ongoing?: boolean;
}

function LastCard({ label, event, now, ongoing }: LastCardProps) {
  const at = parseTs(event?.started_at);
  const mins = at != null ? Math.max(0, Math.round((now - at) / MINUTE)) : null;
  // Только что записанное — «только что», а не «0 мин назад»: ноль минут
  // не длительность, а её отсутствие (так же читает это и экран в детской).
  const justNow = mins != null && mins < 1;
  // Строка во всю ширину, а не карточка в треть экрана: раньше на каждую
  // приходилось ~110 px, и «назад · 19:00» в них переносилось пополам.
  // Теперь «назад» стоит при своём числе, а время выстроено в столбец справа.
  const ago =
    mins == null ? null : justNow ? 'только что' : `${formatMinutes(mins)} назад`;

  return (
    <div className="lastcard" data-ongoing={ongoing ? 'yes' : undefined}>
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
          <div className="lastcard__sub">{formatTime(at)}</div>
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
  // `wet` и `dirty` у сервера УЖЕ включают в себя `both` (см. dailyStats в
  // apps/server/src/events.ts и тест «both — это и мокрый подгузник тоже»).
  // Прибавлять его второй раз — значит считать такой подгузник дважды.
  const wet = o.today?.diapers.wet ?? 0;
  const dirty = o.today?.diapers.dirty ?? 0;
  const diaperCount = o.today?.diapers.total ?? o.timeline.diapers.length;
  const sleepMin = o.today?.sleep.totalMin ?? o.timeline.sleepMin;

  const nothingToday =
    o.timeline.sleeps.length === 0 &&
    o.timeline.feeds.length === 0 &&
    o.timeline.diapers.length === 0;
  const nothingAtAll = o.events.length === 0;

  const sessions = o.today?.sleep.sessions ?? 0;
  const tileNotes: string[] = [];
  if (diaperCount > 0) {
    tileNotes.push(
      `подгузники: ${wet} ${plural(wet, 'мокрый', 'мокрых', 'мокрых')}, ` +
        `${dirty} ${plural(dirty, 'грязный', 'грязных', 'грязных')}`,
    );
  }
  if (sessions > 0) {
    tileNotes.push(
      `сон: ${sessions} ${plural(sessions, 'отрезок', 'отрезка', 'отрезков')}`,
    );
  }

  return (
    <>
      {/* --- что происходит прямо сейчас ---
          Цвета здесь нет намеренно: он работает в графиках и называет там тип
          записи. «Сейчас» отмечено формой — чернильной точкой и жирной строкой
          у идущего сна. Янтарный, который был раньше, к тому же читался как
          предупреждение, а бодрствование — не происшествие. */}
      <section className="hero">
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
              {/* «прошлый сон 0 мин» — не факт о сне, а мусор: сон, закрытый
                  в ту же минуту, о длительности ничего не говорит. */}
              {o.state?.sleep?.lastSleep && !asleep && o.state.sleep.lastSleep.durationMin > 0
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
        <LastCard label="Кормление" event={o.last.feed} now={o.now} />
        <LastCard label="Подгузник" event={o.last.diaper} now={o.now} />
        <LastCard label="Сон" event={o.last.sleep} now={o.now} ongoing={asleep} />
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
            <div className="tile">
              <div className="tile__value">{feedCount}</div>
              <div className="tile__label">
                {plural(feedCount, 'кормление', 'кормления', 'кормлений')}
              </div>
            </div>
            <div className="tile">
              <div className="tile__value">{diaperCount}</div>
              <div className="tile__label">
                {plural(diaperCount, 'подгузник', 'подгузника', 'подгузников')}
              </div>
            </div>
            <div className="tile">
              <div className="tile__value">{formatHours(sleepMin)}</div>
              <div className="tile__label">сна</div>
            </div>
          </div>

          {/* Уточнения вынесены из плиток в одну строку под ними: в колонке
              шириной в треть экрана «3 мокрых · 0 грязных» переносилось и
              тянуло вверх высоту всего ряда. Заодно ушла и неправильная
              форма: «1 мокрых» вместо «1 мокрый». */}
          {tileNotes.length > 0 ? (
            <p className="tiles__note">{tileNotes.join(' · ')}</p>
          ) : null}

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
