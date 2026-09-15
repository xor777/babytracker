import { useEffect, useState } from 'react';
import { fetchEvents, fetchStats } from '../api';
import { ApiError } from '../types';
import type { LoadState, StatsResponse, TrackerEvent } from '../types';
import { DAY } from '../lib/format';

export function useStats(days = 7) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [measures, setMeasures] = useState<TrackerEvent[]>([]);
  const [status, setStatus] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    setStatus('loading');
    (async () => {
      try {
        const data = await fetchStats(days, ac.signal);
        if (!alive) return;
        setStats(data);
        setError(null);
        setStatus('ready');
      } catch (err) {
        if (!alive || (err as Error)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Сводка не загрузилась.');
        setStatus('error');
      }
      // Ростовые кривые строим сами из событий: полгода измерений — это десятки строк.
      try {
        const from = new Date(Date.now() - 180 * DAY).toISOString();
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

  return { stats, measures, status, error, reload: () => setNonce((n) => n + 1) };
}
