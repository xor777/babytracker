import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approvePending,
  denyPending,
  fetchDevices,
  revokeDevice,
  type DeviceSession,
  type PendingDevice,
} from '../api';

/**
 * Как часто переспрашивать, не ждёт ли кто одобрения.
 *
 * Пять секунд — потому что по ту сторону стоит человек перед телевизором и
 * ждёт, когда на телефоне появится его код. Десять секунд в этой ситуации
 * ощущаются как «не работает», и он начинает перезапускать приложение.
 * Запрос крошечный, а опрос идёт только пока экран открыт.
 */
const POLL_MS = 5000;

/** Когда экран устройств закрыт, хватает и редкой проверки — она для баннера. */
const IDLE_POLL_MS = 20_000;

/**
 * Режим опроса.
 *
 *  - `active` — экран устройств открыт, человек ждёт появления своей заявки;
 *  - `idle` — экран закрыт, опрос нужен только баннеру;
 *  - `off` — сессии нет. Долбить сервер запросами, которые заведомо вернут
 *    401, незачем: он на них всё равно не ответит ничем полезным.
 */
export type DevicesPollMode = 'active' | 'idle' | 'off';

export interface DevicesData {
  pending: PendingDevice[];
  sessions: DeviceSession[];
  /** Ошибка последнего действия — показывается рядом с кнопками. */
  error: string | null;
  busy: boolean;
  loaded: boolean;
  approve: (id: number) => Promise<void>;
  deny: (id: number) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useDevices(mode: DevicesPollMode): DevicesData {
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchDevices();
      if (!alive.current) return;
      setPending(data.pending);
      setSessions(data.sessions);
      setLoaded(true);
    } catch {
      // Молча: экран не должен мигать ошибкой из-за одного неудачного опроса,
      // а телефон теряет сеть постоянно. Потеря сессии сюда не относится —
      // её ловит App по 401 из /api/state и показывает «Сессия завершена»,
      // после чего опрос уходит в режим `off`.
    }
  }, []);

  useEffect(() => {
    if (mode === 'off') return;
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), mode === 'active' ? POLL_MS : IDLE_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh, mode]);

  /**
   * Действие + немедленное обновление списка. Оптимистично ничего не рисуем:
   * одобрение устройства — не то место, где стоит показывать успех, которого
   * могло не случиться.
   */
  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не получилось.');
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  return {
    pending,
    sessions,
    error,
    busy,
    loaded,
    approve: (id) => act(() => approvePending(id)),
    deny: (id) => act(() => denyPending(id)),
    revoke: (id) => act(() => revokeDevice(id)),
    refresh,
  };
}
