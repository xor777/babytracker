import { useEffect, useMemo, useState } from 'react';
import { fetchEvents, fetchState, fetchStats } from '../api';
import { ApiError } from '../types';
import type { DailyStats, LoadState, TrackerEvent } from '../types';
import { DAY, startOfLocalDay } from '../lib/format';
import { growthSeries } from '../lib/group';
import { buildDayTimeline } from '../lib/timeline';

export interface PeriodDef {
  id: string;
  label: string;
  days: number;
}

/**
 * Набор периодов зависит от возраста ребёнка. Двухнедельному «месяц» предлагать
 * бессмысленно: три четверти окна — время до рождения. Пока жизни меньше месяца,
 * последний пресет честно называется «с рождения».
 */
export function periodsForAge(ageDays: number | null): PeriodDef[] {
  const span = (ageDays ?? 0) + 1;
  const out: PeriodDef[] = [{ id: 'day', label: 'Сутки', days: 1 }];
  if (span > 2) out.push({ id: 'week', label: 'Неделя', days: Math.min(7, span) });
  if (span > 7) {
    out.push(
      span >= 30
        ? { id: 'month', label: 'Месяц', days: 30 }
        : { id: 'all', label: 'С рождения', days: span },
    );
  }
  return out;
}

/** Возраст ребёнка. Отдельно от useStats: от него зависит сам набор периодов. */
export function useChildAge(): number | null {
  const [ageDays, setAgeDays] = useState<number | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    fetchState(ac.signal)
      .then((st) => setAgeDays(st.child?.ageDays ?? null))
      .catch(() => setAgeDays(null));
    return () => ac.abort();
  }, []);
  return ageDays;
}

export function useStats(days: number, withDayEvents: boolean) {
  const [stats, setStats] = useState<DailyStats[]>([]);
  const [measures, setMeasures] = useState<TrackerEvent[]>([]);
  const [dayEvents, setDayEvents] = useState<TrackerEvent[]>([]);
  const [status, setStatus] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

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
      // раз в несколько дней, и окно «сутки» почти всегда оказалось бы пустым.
      try {
        const from = new Date(Date.now() - 400 * DAY).toISOString();
        const rows = await fetchEvents({ from, types: ['measure'], limit: 500 }, ac.signal);
        if (alive) setMeasures(rows.filter((e) => e.type === 'measure'));
      } catch {
        if (alive) setMeasures([]);
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
  }, [days, nonce]);

  useEffect(() => {
    if (!withDayEvents) {
      setDayEvents([]);
      return;
    }
    const ac = new AbortController();
    const from = new Date(startOfLocalDay(Date.now()) - 12 * 60 * 60_000).toISOString();
    fetchEvents({ from, limit: 400 }, ac.signal)
      .then(setDayEvents)
      .catch(() => setDayEvents([]));
    return () => ac.abort();
  }, [withDayEvents, nonce]);

  const weight = useMemo(() => growthSeries(measures, 'weight'), [measures]);
  const height = useMemo(() => growthSeries(measures, 'height'), [measures]);
  const head = useMemo(() => growthSeries(measures, 'head'), [measures]);

  const todayTimeline = useMemo(
    () => buildDayTimeline(dayEvents, startOfLocalDay(Date.now())),
    [dayEvents],
  );

  return {
    stats,
    weight,
    height,
    head,
    todayTimeline,
    status,
    error,
    reload: () => setNonce((n) => n + 1),
  };
}
