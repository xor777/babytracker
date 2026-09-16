import { useEffect, useMemo, useState } from 'react';
import { EVENTS_LIMIT_MAX, fetchEvents, fetchState, fetchStats } from '../api';
import { ApiError } from '../types';
import type { DailyStats, LoadState, TrackerEvent } from '../types';
import { DAY, parseTs, startOfLocalDay } from '../lib/format';
import { growthSeries } from '../lib/group';
import { buildWindow, coverage, weeks, weightFacts } from '../lib/summary';

export interface PeriodDef {
  id: string;
  label: string;
  days: number;
}

/**
 * Набор периодов зависит от возраста ребёнка.
 *
 * Двухнедельному «месяц» предлагать бессмысленно: две трети окна — время до
 * рождения. Пока жизни меньше месяца, самый широкий пресет честно называется
 * «с рождения» и ровно ей и равен.
 *
 * Суток здесь нет намеренно: «Сводка» отвечает на вопросы врача, а он смотрит
 * тренд. Что происходит прямо сейчас и что было за сегодня — это соседняя
 * вкладка «День», и дублировать её здесь значит просто отодвинуть главное вниз.
 */
export function periodsForAge(ageDays: number | null): PeriodDef[] {
  const span = (ageDays ?? 0) + 1;
  const out: PeriodDef[] = [];
  if (span > 7) out.push({ id: 'week', label: 'Неделя', days: 7 });
  if (span > 14) out.push({ id: 'two', label: '2 недели', days: 14 });
  out.push(
    span > 30
      ? { id: 'month', label: 'Месяц', days: 30 }
      : { id: 'all', label: 'С рождения', days: Math.max(1, span) },
  );
  return out;
}

export interface ChildInfo {
  ageDays: number | null;
  /** Полночь дня рождения, мс. Без неё не считаются ни недели, ни возраст на взвешивании. */
  birthMs: number | null;
  name: string | null;
}

/** Кто перед нами. Отдельно от useStats: от возраста зависит сам набор периодов. */
export function useChild(): ChildInfo {
  const [info, setInfo] = useState<ChildInfo>({ ageDays: null, birthMs: null, name: null });
  useEffect(() => {
    const ac = new AbortController();
    fetchState(ac.signal)
      .then((st) => {
        const raw = st.child?.birthDate;
        // Дата рождения приходит датой без времени — берём полночь местного дня,
        // иначе UTC-полночь уедет на сутки в минус для всех, кто восточнее Гринвича.
        const birthMs = raw ? (parseTs(`${raw}T12:00:00`) ?? null) : null;
        setInfo({
          ageDays: st.child?.ageDays ?? null,
          birthMs: birthMs != null ? startOfLocalDay(birthMs) : null,
          name: st.child?.name ?? null,
        });
      })
      .catch(() => setInfo({ ageDays: null, birthMs: null, name: null }));
    return () => ac.abort();
  }, []);
  return info;
}

interface EventsState {
  rows: TrackerEvent[];
  /** Ленте можно верить. false — запрос не удался, и «записей нет» утверждать нельзя. */
  known: boolean;
  /** Самое старое событие, которое мы точно видели: за ним лимит мог срезать. */
  oldestSeenMs: number | null;
  /** Лента упёрлась в лимит — часть окна осталась за кадром. */
  truncated: boolean;
}

export function useStats(days: number, birthMs: number | null) {
  const [stats, setStats] = useState<DailyStats[]>([]);
  const [measures, setMeasures] = useState<TrackerEvent[]>([]);
  const [events, setEvents] = useState<EventsState>({
    rows: [],
    known: false,
    oldestSeenMs: null,
    truncated: false,
  });
  const [status, setStatus] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const windowStart = useMemo(
    () => startOfLocalDay(Date.now()) - (days - 1) * DAY,
    [days],
  );

  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    setStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    (async () => {
      try {
        const data = await fetchStats(days, ac.signal);
        if (!alive) return;
        setStats(data.days);
        setError(null);
        setStatus('ready');
      } catch (err) {
        if (!alive || (err as Error)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Сводка не загрузилась.');
        setStatus('error');
        return;
      }

      // Вес рисуется от рождения независимо от выбранного периода: взвешивают
      // раз в несколько дней, и узкое окно почти всегда оказалось бы пустым.
      try {
        const from = new Date(Date.now() - 400 * DAY).toISOString();
        const rows = await fetchEvents({ from, types: ['measure'], limit: 500 }, ac.signal);
        if (alive) setMeasures(rows.filter((e) => e.type === 'measure'));
      } catch {
        if (alive) setMeasures([]);
      }

      /*
       * Сырые события окна. Без них суточная сводка не отличает «не было» от
       * «не записали»: сервер отдаёт строку на каждые сутки, и сутки без единой
       * записи приходят нулями. Полнота дневника считается только отсюда.
       *
       * Лимит — потолок контракта. Если лента в него упёрлась, у нас на руках
       * самые свежие события, а про то, что старше, мы не знаем НИЧЕГО. Такие
       * сутки помечаются неизвестными, а не пустыми: «записей нет» — это
       * утверждение, и на обрезанной выборке мы его не заработали.
       */
      try {
        const rows = await fetchEvents(
          { from: new Date(windowStart).toISOString(), limit: EVENTS_LIMIT_MAX },
          ac.signal,
        );
        if (!alive) return;
        const truncated = rows.length >= EVENTS_LIMIT_MAX;
        let oldest: number | null = null;
        for (const e of rows) {
          const at = parseTs(e.started_at);
          if (at != null && (oldest == null || at < oldest)) oldest = at;
        }
        setEvents({
          rows,
          known: true,
          oldestSeenMs: truncated ? oldest : null,
          truncated,
        });
      } catch {
        if (alive) {
          setEvents({ rows: [], known: false, oldestSeenMs: null, truncated: false });
        }
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
  }, [days, windowStart, nonce]);

  const weight = useMemo(() => growthSeries(measures, 'weight'), [measures]);
  const height = useMemo(() => growthSeries(measures, 'height'), [measures]);
  const head = useMemo(() => growthSeries(measures, 'head'), [measures]);

  const cells = useMemo(
    () =>
      buildWindow({
        days: stats,
        events: events.rows,
        eventsKnown: events.known,
        oldestSeenMs: events.oldestSeenMs,
        birthMs,
      }),
    [stats, events, birthMs],
  );

  const cover = useMemo(() => coverage(cells, birthMs), [cells, birthMs]);
  const weekRows = useMemo(() => weeks(cells), [cells]);
  const facts = useMemo(() => weightFacts(weight, birthMs), [weight, birthMs]);

  return {
    cells,
    coverage: cover,
    weeks: weekRows,
    events: events.rows,
    eventsKnown: events.known,
    eventsTruncated: events.truncated,
    windowStart,
    weight,
    weightFacts: facts,
    height,
    head,
    status,
    error,
    reload: () => setNonce((n) => n + 1),
  };
}
