import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteEvent,
  fetchChangeSets,
  fetchEvents,
  fetchUtterances,
  findChangeSetForEvent,
  patchEvent,
  revertChangeSet,
} from '../api';
import { ApiError } from '../types';
import type { ChangeSet, EventPatch, LoadState, TrackerEvent, Utterance } from '../types';
import { attachUtterances, buildSections } from '../lib/group';
import { DAY, localDateKey, parseTs, startOfLocalDay } from '../lib/format';
import { classifyPhrase } from '../lib/utterance';

export interface HistoryFilters {
  /** Глубина ленты в сутках: 1 / 3 / 7 / 30. */
  days: number;
  /** Пустой список — все типы. */
  types: string[];
  showDeleted: boolean;
}

/** Пресеты периода. «Всё» — с запасом на всю жизнь ребёнка. */
export const RANGE_PRESETS = [1, 7, 30, 400];

const DEFAULT_FILTERS: HistoryFilters = { days: 7, types: [], showDeleted: false };

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
  const [changeSets, setChangeSets] = useState<ChangeSet[]>([]);
  const [status, setStatus] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  /** Некритичная поломка: лента жива, но чего-то не хватает. Молчать о ней нельзя. */
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [busySet, setBusySet] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const dayKey = useDayKey();
  /** Подобрали ли уже стартовый период под реальные данные (делается один раз). */
  const autoRanged = useRef(false);
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
        // Наборы изменений идут вместе с фразами: без них не видно, что фраза
        // изменила существующую запись, и «проснулся» выглядит пустышкой.
        const [said, sets] = await Promise.all([
          fetchUtterances(200, ac.signal),
          fetchChangeSets(200, ac.signal).catch(() => [] as ChangeSet[]),
        ]);
        if (!alive) return;
        setUtterances(said);
        setChangeSets(sets);
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

  /*
   * Стартовый период подбираем под данные, а не наоборот. У двухнедельного ребёнка
   * записей может не быть неделю: фиксированное «Сегодня» показывало бы пустой экран,
   * на котором не за что даже нажать, — ровно на это и жаловались.
   */
  useEffect(() => {
    if (autoRanged.current) return;
    const ac = new AbortController();
    (async () => {
      try {
        const [newest] = await fetchEvents({ limit: 1 }, ac.signal);
        if (autoRanged.current) return;
        autoRanged.current = true;
        const ms = parseTs(newest?.started_at);
        if (ms == null) return;
        const ageDays = Math.floor((Date.now() - startOfLocalDay(ms)) / DAY) + 1;
        const fit = RANGE_PRESETS.find((d) => d >= ageDays) ?? RANGE_PRESETS.at(-1)!;
        setFilters((f) => (fit > f.days ? { ...f, days: fit } : f));
      } catch (err) {
        // Прерванный запрос — не отказ: в StrictMode первый прогон эффекта всегда
        // отменяется, и пометив попытку выполненной, мы бы отключили подбор совсем.
        if ((err as Error)?.name === 'AbortError') return;
        autoRanged.current = true; // не вышло — остаёмся на пресете по умолчанию
      }
    })();
    return () => ac.abort();
  }, []);

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
  /**
   * Отмена того, что сделала фраза (§9.6). Работает и для созданных записей
   * (сервер их прячет), и для изменённых (восстанавливает прежнее состояние).
   * После отката перечитываем всё: у наборов меняется reverted_at.
   */
  const undoChangeSet = useCallback(
    async (changeSetId: string): Promise<string | null> => {
      setBusySet(changeSetId);
      try {
        await revertChangeSet(changeSetId);
        setError(null);
        setNonce((n) => n + 1);
        return null;
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : 'Отменить не получилось. Попробуйте ещё раз.';
        setError(message);
        return message;
      } finally {
        setBusySet(null);
      }
    },
    [],
  );

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

  const setsByUtterance = useMemo(() => {
    const map = new Map<number, ChangeSet[]>();
    for (const cs of changeSets) {
      if (cs.utterance_id == null) continue;
      const list = map.get(cs.utterance_id);
      if (list) list.push(cs);
      else map.set(cs.utterance_id, [cs]);
    }
    return map;
  }, [changeSets]);

  /** Все известные события по id — включая удалённые: изменённое могли и удалить. */
  const eventsById = useMemo(() => {
    const map = new Map<number, TrackerEvent>();
    for (const e of withText) map.set(e.id, e);
    return map;
  }, [withText]);

  const visible = useMemo(() => {
    const typeSet = new Set(filters.types);
    return withText.filter((e) => {
      if (!filters.showDeleted && e.deleted_at) return false;
      if (typeSet.size && !typeSet.has(e.type)) return false;
      return true;
    });
  }, [withText, filters.types, filters.showDeleted]);

  /**
   * Фразы без единой записи. Показываем только те, что действительно требуют
   * внимания: вопросы к Алисе и команды, отработавшие штатно, — не дневник
   * ребёнка и не проблема (см. lib/utterance.ts).
   */
  const orphans = useMemo(() => {
    if (filters.types.length) return [];
    const used = new Set(withText.map((e) => e.utterance_id).filter((id) => id != null));
    const fromMs = parseTs(from) ?? 0;
    return utterances.filter((u) => {
      if (used.has(u.id)) return false;
      const ms = parseTs(u.received_at);
      if (ms == null || ms < fromMs) return false;
      // Фраза, изменившая данные, показывается ВСЕГДА — даже если разбор
      // отработал штатно: человек должен видеть, что дневник поменялся, и мочь
      // это отменить.
      const sets = setsByUtterance.get(u.id) ?? [];
      if (sets.some((cs) => (cs.events?.length ?? 0) > 0)) return true;
      return classifyPhrase(u).show;
    });
  }, [utterances, withText, from, filters.types.length, setsByUtterance]);

  const sections = useMemo(
    () => buildSections(visible, orphans, setsByUtterance, eventsById),
    [visible, orphans, setsByUtterance, eventsById],
  );

  const deletedCount = useMemo(() => withText.filter((e) => e.deleted_at).length, [withText]);
  const phraseCount = useMemo(
    () => sections.reduce((sum, s) => sum + s.phrases, 0),
    [sections],
  );

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
    busySet,
    undoChangeSet,
    deletedCount,
    phraseCount,
    total: visible.length,
    save,
    remove,
    restore,
  };
}
