import { useEffect, useMemo, useState } from 'react';
import { fetchEvents, fetchState, fetchStats } from '../api';
import { ApiError } from '../types';
import type { DailyStats, LoadState, TrackerEvent, TrackerState } from '../types';
import { HOUR, startOfLocalDay } from '../lib/format';
import { buildDayTimeline, feedGaps, lastOfType } from '../lib/timeline';

/** Смотрим на 40 часов назад: «когда последний раз ел» в 2 ночи лежит во вчера. */
const LOOKBACK = 40 * HOUR;

export function useOverview() {
  const [state, setState] = useState<TrackerState | null>(null);
  const [events, setEvents] = useState<TrackerEvent[]>([]);
  const [today, setToday] = useState<DailyStats | null>(null);
  const [status, setStatus] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /** Таймер текущего состояния тикает локально, сервер для этого не дёргаем. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    setStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    (async () => {
      try {
        const from = new Date(Date.now() - LOOKBACK).toISOString();
        const [st, rows] = await Promise.all([
          fetchState(ac.signal),
          fetchEvents({ from, limit: 400 }, ac.signal),
        ]);
        if (!alive) return;
        setState(st);
        setEvents(rows);
        setError(null);
        setStatus('ready');
      } catch (err) {
        if (!alive || (err as Error)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить состояние.');
        setStatus('error');
        return;
      }
      // Сводка за сутки — ради норм AAP; без неё экран живёт, просто без ориентиров.
      try {
        const stats = await fetchStats(1, ac.signal);
        if (alive) setToday(stats.days[0] ?? null);
      } catch {
        if (alive) setToday(null);
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
  }, [nonce]);

  const dayStart = startOfLocalDay(now);
  const timeline = useMemo(
    () => buildDayTimeline(events, dayStart, now),
    // now меняется каждую секунду, но пересобирать ленту чаще раза в минуту незачем
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, dayStart, Math.floor(now / 60_000)],
  );

  const last = useMemo(
    () => ({
      feed: lastOfType(events, 'feed'),
      diaper: lastOfType(events, 'diaper'),
      sleep: lastOfType(events, 'sleep'),
    }),
    [events],
  );

  const gaps = useMemo(() => feedGaps(timeline.feeds), [timeline.feeds]);

  return {
    state,
    events,
    today,
    timeline,
    last,
    gaps,
    now,
    status,
    error,
    reload: () => setNonce((n) => n + 1),
  };
}
