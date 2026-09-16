import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveByCode,
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
 * ждёт, когда на телефоне появится подтверждение, что его заявка дошла.
 * Десять секунд в этой ситуации ощущаются как «не работает», и он начинает
 * перезапускать приложение. Запрос крошечный, а опрос идёт только пока
 * экран устройств открыт.
 */
const POLL_MS = 5000;

/**
 * Режим опроса. Их стало два, а не три.
 *
 *  - `active` — экран устройств открыт, человек ждёт появления своей заявки;
 *  - `off` — экран закрыт или сессии нет. Опрос молчит.
 *
 * Пропал режим `idle` — редкий фоновый опрос при закрытом экране. Он
 * существовал ради баннера «N устройств просят доступ», всплывавшего поверх
 * любого экрана, и вместе с баннером потерял смысл: спрашивать сервер о том,
 * чего нигде не показывают, незачем.
 *
 * Сценарий «стою перед телевизором и жду» при этом не сломан, и вот почему.
 * Раньше телефон лежал в кармане, а баннер был единственным способом узнать,
 * что заявка дошла, — отсюда и фоновый опрос. Теперь одобрение требует
 * НАБРАТЬ код с экрана устройства, то есть человек в любом случае берёт
 * телефон в руки и открывает этот экран. Как только он его открыл, опрос
 * идёт раз в пять секунд — вдвое чаще прежнего фонового. Ждать, глядя на
 * экран, который молчит, здесь не приходится.
 */
export type DevicesPollMode = 'active' | 'off';

export interface DevicesData {
  pending: PendingDevice[];
  sessions: DeviceSession[];
  /** Ошибка последнего действия — показывается рядом с кнопками. */
  error: string | null;
  /** Что получилось: «устройство одобрено». Живёт до следующего действия. */
  notice: string | null;
  busy: boolean;
  loaded: boolean;
  /** Одобрение — только по коду с экрана устройства (§11.9). */
  approve: (userCode: string) => Promise<boolean>;
  deny: (id: number) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  clearMessages: () => void;
}

export function useDevices(mode: DevicesPollMode): DevicesData {
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    const timer = setInterval(() => void refresh(), POLL_MS);
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
    async (fn: () => Promise<void>, ok: string | null = null): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setNotice(null);
      let success = false;
      try {
        await fn();
        success = true;
        if (ok) setNotice(ok);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не получилось.');
      } finally {
        setBusy(false);
        await refresh();
      }
      return success;
    },
    [refresh],
  );

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return {
    pending,
    sessions,
    error,
    notice,
    busy,
    loaded,
    approve: (userCode) =>
      act(
        () => approveByCode(userCode),
        'Устройство одобрено — оно подключится через несколько секунд.',
      ),
    deny: async (id) => {
      await act(() => denyPending(id));
    },
    revoke: async (id) => {
      await act(() => revokeDevice(id));
    },
    refresh,
    clearMessages,
  };
}
