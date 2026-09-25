import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveByCode,
  closeAliceEnroll,
  denyPending,
  fetchAliceIdentities,
  fetchDevices,
  openAliceEnroll,
  revokeAliceIdentity,
  revokeDevice,
  type AliceIdentity,
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

export interface AliceData {
  /** Кто уже может записывать в дневник голосом. */
  trusted: AliceIdentity[];
  /** Последнее обращение незнакомого аккаунта — видно, что попытка дошла. */
  lastUnknownAt: string | null;
  enrollOpenUntil: string | null;
  identityCheck: boolean;
}

export interface DevicesData {
  pending: PendingDevice[];
  sessions: DeviceSession[];
  /** null — ещё не загрузилось или сервер не ответил. */
  alice: AliceData | null;
  /** Голос, который только что подключили кнопкой, — до следующего действия. */
  justEnrolledId: number | null;
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
  openEnroll: () => Promise<void>;
  closeEnroll: () => Promise<void>;
  revokeAlice: (id: number) => Promise<void>;
  refresh: () => Promise<void>;
  clearMessages: () => void;
}

export function useDevices(mode: DevicesPollMode): DevicesData {
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [alice, setAlice] = useState<AliceData | null>(null);
  const [justEnrolledId, setJustEnrolledId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);
  /**
   * Кого подключили кнопкой, на момент прошлого опроса. null — первого опроса
   * ещё не было: уже подключённые раньше не должны выглядеть новостью.
   */
  const enrolledSeen = useRef<Set<number> | null>(null);

  const refresh = useCallback(async () => {
    // Два запроса независимы: сбой одного не должен прятать другой список.
    const [devicesRes, aliceRes] = await Promise.allSettled([
      fetchDevices(),
      fetchAliceIdentities(),
    ]);
    if (!alive.current) return;

    // Сбои — молча: экран не должен мигать ошибкой из-за одного неудачного
    // опроса, а телефон теряет сеть постоянно. Потеря сессии сюда не
    // относится — её ловит App по 401 из /api/state и показывает «Сессия
    // завершена», после чего опрос уходит в режим `off`.
    if (devicesRes.status === 'fulfilled') {
      setPending(devicesRes.value.pending);
      setSessions(devicesRes.value.sessions);
      setLoaded(true);
    }

    if (aliceRes.status === 'fulfilled') {
      const data = aliceRes.value;
      const trusted = data.identities.filter((i) => i.status === 'trusted');
      const unknown = data.identities.filter((i) => i.status === 'pending');
      const lastUnknownAt =
        unknown.map((i) => i.lastSeenAt).sort().at(-1) ?? null;

      // Окно подключения закрывается само, когда кто-то новый заговорил.
      // Человек, который нажал кнопку и ждёт, должен это увидеть, а не
      // догадываться по исчезнувшему таймеру. Показывается в самом разделе
      // «Алиса», а не общей полоской вверху: смотрят в этот момент туда.
      const enrolled = trusted.filter((i) => i.source === 'enroll').map((i) => i.id);
      const before = enrolledSeen.current;
      const fresh = before === null ? undefined : enrolled.find((id) => !before.has(id));
      if (fresh !== undefined) setJustEnrolledId(fresh);
      enrolledSeen.current = new Set(enrolled);

      setAlice({
        trusted,
        lastUnknownAt,
        enrollOpenUntil: data.enrollOpenUntil,
        identityCheck: data.identityCheck,
      });
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
      setJustEnrolledId(null);
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
    setJustEnrolledId(null);
  }, []);

  return {
    pending,
    sessions,
    alice,
    justEnrolledId,
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
    openEnroll: async () => {
      await act(() => openAliceEnroll());
    },
    closeEnroll: async () => {
      await act(() => closeAliceEnroll());
    },
    revokeAlice: async (id) => {
      await act(() => revokeAliceIdentity(id));
    },
    refresh,
    clearMessages,
  };
}
