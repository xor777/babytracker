import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteEvent,
  fetchEvents,
  fetchUtterances,
  findChangeSetForEvent,
  patchEvent,
  revertChangeSet,
} from '../api';
import { ApiError } from '../types';
import type { EventPatch, LoadState, TrackerEvent, Utterance } from '../types';
import { attachUtterances, buildSections } from '../lib/group';
import { DAY, localDateKey, parseTs } from '../lib/format';

export interface HistoryFilters {
  /** Глубина ленты в сутках: 1 / 3 / 7 / 30. */
  days: number;
  /** Пустой список — все типы. */
  types: string[];
  showDeleted: boolean;
}

const DEFAULT_FILTERS: HistoryFilters = { days: 3, types: [], showDeleted: false };

/**
 * Текущая локальная дата. Телефон, оставленный открытым через полночь, иначе
 * продолжал бы спрашивать вчерашний диапазон.
 */
function useDayKey(): string {
  const [key, setKey] = useState(() => localDateKey(Date.now()));
  useEffect(() => {
    const tick = () => setKey(localDateKey(Date.now()));
    const timer = setInterval(tick, 5 * 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return key;
}

export function useHistory() {
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
  const [rows, setRows] = useState<TrackerEvent[]>([]);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [status, setStatus] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  /** Некритичная поломка: лента жива, но чего-то не хватает. Молчать о ней нельзя. */
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const dayKey = useDayKey();
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  /** Каким набором изменений отменяется удаление события (§9.6). */
  const revertKeys = useRef(new Map<number, string>());

  const from = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return new Date(d.getTime() - (filters.days - 1) * DAY).toISOString();
    // dayKey в зависимостях намеренно: после полуночи окно обязано сдвинуться.
  }, [filters.days, dayKey]);

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
        if (!alive) return;
        setRows(events);
        setError(null);
        setStatus('ready');
      } catch (err) {
        if (!alive || (err as Error)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить историю.');
        setStatus('error');
        return;
      }

      /*
       * Фразы — дополнение, а не основа: текст цитаты приходит вместе с событием
       * полем utterance_text. Отсюда берутся статус разбора и фразы, не давшие
       * ни одной записи. Поломка здесь не должна валить ленту, но и молчать о ней
       * нельзя — именно молчаливый catch однажды спрятал отсутствие фраз целиком.
       */
      try {
        const said = await fetchUtterances(200, ac.signal);
        if (!alive) return;
        setUtterances(said);
        setNotice(null);
      } catch (err) {
        if (!alive || (err as Error)?.name === 'AbortError') return;
        setUtterances([]);
        setNotice(
          err instanceof ApiError
            ? `Статусы разбора не загрузились: ${err.message}`
            : 'Статусы разбора не загрузились.',
        );
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
  }, [from, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  /** Ответ сервера кладём на место старых строк — без перезапроса всей ленты. */
  const merge = useCallback((updated: TrackerEvent[]) => {
    if (!updated.length) {
      setNonce((n) => n + 1);
      return;
    }
    const byId = new Map(updated.map((e) => [e.id, e]));
    setRows((prev) => prev.map((e) => (byId.has(e.id) ? { ...e, ...byId.get(e.id)! } : e)));
  }, []);

  /** Все мутации возвращают текст ошибки (или null): вызывающий обязан его показать. */
  const run = useCallback(
    async (id: number, fn: () => Promise<TrackerEvent[]>): Promise<string | null> => {
      setBusyId(id);
      try {
        merge(await fn());
        setError(null);
        return null;
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : 'Изменение не сохранилось. Попробуйте ещё раз.';
        setError(message);
        return message;
      } finally {
        setBusyId(null);
      }
    },
    [merge],
  );

  const save = useCallback(
    (id: number, patch: EventPatch) =>
      run(id, async () => {
        const event = await patchEvent(id, patch);
        return event ? [event] : [];
      }),
    [run],
  );

  const remove = useCallback(
    (id: number) =>
      run(id, async () => {
        const { event, revertWith } = await deleteEvent(id);
        if (revertWith) revertKeys.current.set(id, revertWith);
        return event ? [event] : [];
      }),
    [run],
  );

  /**
   * Возврат идёт через откат набора изменений (§9.6) — другого пути у сервера нет.
   * Если удаляли не мы, набор находим по журналу; если и там пусто, честно говорим.
   */
  const restore = useCallback(
    (id: number) =>
      run(id, async () => {
        const known = revertKeys.current.get(id);
        const changeSetId = known ?? (await findChangeSetForEvent(id));
        if (!changeSetId) {
          throw new ApiError(
            404,
            'Не нашли, каким изменением удалили эту запись, — вернуть её из админки не получится.',
          );
        }
        const restored = await revertChangeSet(changeSetId);
        revertKeys.current.delete(id);
        return restored;
      }),
    [run],
  );

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

  const deletedCount = useMemo(() => withText.filter((e) => e.deleted_at).length, [withText]);

  return {
    filters,
    setFilters,
    sections,
    status,
    error,
    notice,
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
