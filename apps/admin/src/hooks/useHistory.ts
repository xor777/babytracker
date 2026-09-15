import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteEvent, fetchEvents, fetchUtterances, patchEvent, restoreEvent } from '../api';
import { ApiError } from '../types';
import type { EventPatch, LoadState, TrackerEvent, Utterance } from '../types';
import { attachUtterances, buildSections } from '../lib/group';
import { DAY, parseTs } from '../lib/format';

export interface HistoryFilters {
  /** Глубина ленты в сутках: 1 / 3 / 7 / 30. */
  days: number;
  /** Пустой список — все типы. */
  types: string[];
  showDeleted: boolean;
}

const DEFAULT_FILTERS: HistoryFilters = { days: 3, types: [], showDeleted: false };

export function useHistory() {
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
  const [rows, setRows] = useState<TrackerEvent[]>([]);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [status, setStatus] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const from = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return new Date(d.getTime() - (filters.days - 1) * DAY).toISOString();
  }, [filters.days]);

  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    setStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    (async () => {
      try {
        // include_deleted всегда: удалённое нужно, чтобы «вернуть» работало без перезагрузки.
        const events = await fetchEvents(
          { from, includeDeleted: true, limit: Math.min(1000, filtersRef.current.days * 80) },
          ac.signal,
        );
        // Фразы тянем отдельно: сервер может ещё не приклеивать их к событиям (§10.4 в работе).
        let said: Utterance[] = [];
        try {
          said = await fetchUtterances(300, ac.signal);
        } catch {
          said = [];
        }
        if (!alive) return;
        setRows(events);
        setUtterances(said);
        setError(null);
        setStatus('ready');
      } catch (err) {
        if (!alive || (err as Error)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить историю.');
        setStatus('error');
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
  }, [from, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  /** Ответ сервера кладём на место старой строки — без перезапроса всей ленты. */
  const merge = useCallback((updated: TrackerEvent | null, id: number) => {
    if (!updated) {
      setNonce((n) => n + 1);
      return;
    }
    setRows((prev) => prev.map((e) => (e.id === id ? { ...e, ...updated } : e)));
  }, []);

  const withBusy = useCallback(
    async (id: number, fn: () => Promise<TrackerEvent | null>) => {
      setBusyId(id);
      try {
        merge(await fn(), id);
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Изменение не сохранилось.');
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [merge],
  );

  const save = useCallback(
    (id: number, patch: EventPatch) => withBusy(id, () => patchEvent(id, patch)),
    [withBusy],
  );
  const remove = useCallback((id: number) => withBusy(id, () => deleteEvent(id)), [withBusy]);
  const restore = useCallback((id: number) => withBusy(id, () => restoreEvent(id)), [withBusy]);

  const withText = useMemo(() => attachUtterances(rows, utterances), [rows, utterances]);

  const visible = useMemo(() => {
    const typeSet = new Set(filters.types);
    return withText.filter((e) => {
      if (!filters.showDeleted && e.deleted_at) return false;
      if (typeSet.size && !typeSet.has(e.type)) return false;
      return true;
    });
  }, [withText, filters.types, filters.showDeleted]);

  /**
   * Фразы, не породившие ни одной записи. Показываем не все: разобранная фраза часто
   * не создаёт события, а правит существующее («проснулся» закрывает открытый сон) —
   * такие в ленте были бы ложной тревогой. Настоящий пробел — это упавший или
   * ещё не доехавший разбор.
   */
  const orphans = useMemo(() => {
    if (filters.types.length) return [];
    const used = new Set(withText.map((e) => e.utterance_id).filter((id) => id != null));
    const fromMs = parseTs(from) ?? 0;
    return utterances.filter((u) => {
      if (used.has(u.id)) return false;
      if (u.status === 'done') return false;
      const ms = parseTs(u.received_at);
      return ms != null && ms >= fromMs;
    });
  }, [utterances, withText, from, filters.types.length]);

  const sections = useMemo(() => buildSections(visible, orphans), [visible, orphans]);

  const deletedCount = useMemo(
    () => withText.filter((e) => e.deleted_at).length,
    [withText],
  );

  return {
    filters,
    setFilters,
    sections,
    status,
    error,
    setError,
    reload,
    busyId,
    deletedCount,
    total: visible.length,
    save,
    remove,
    restore,
  };
}
