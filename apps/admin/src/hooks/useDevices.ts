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

export function useDevices(active: boolean): DevicesData {
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
      // Молча: экран не должен мигать ошибкой из-за одного неудачного опроса.
      // Про 401 позаботится общий обработчик — он уводит на страницу сопряжения.
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), active ? POLL_MS : IDLE_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh, active]);

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
