import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiUrl,
  fetchHealth,
  fetchMeasures,
  fetchRecentEvents,
  fetchState,
  fetchUtterances,
} from '../api';
import type {
  EventMessage,
  Health,
  LinkStatus,
  TrackerEvent,
  TrackerState,
  Utterance,
} from '../types';
import { upsertEvent } from '../lib/sleep';
import { loadSnapshot, saveSnapshot } from '../lib/snapshot';
import { STREAM_OPEN_MS, shouldReload } from '../lib/watchdog';

const UTTERANCE_LIMIT = 20;
/** Раз в столько мс освежаем REST-данные даже при живом SSE (страховка от рассинхрона). */
const SLOW_REFRESH_MS = 10 * 60 * 1000;
/** Если EventSource закрылся насовсем — пересоздаём сами. */
const RECONNECT_MS = 4000;
/** Как часто спрашивать /healthz (жив ли LLM-разбор). */
const HEALTH_EVERY_MS = 60_000;
/** Как часто щупать сервер, когда поток молчит. */
const PROBE_EVERY_MS = 15_000;
/** Молчание дольше этого — повод сходить за /api/state и проверить, живы ли мы. */
const SILENCE_MS = 25_000;
/** Страховочный предел: столько молчания — пересоздаём поток в любом случае. */
const ZOMBIE_MS = 10 * 60 * 1000;

/** Отметка о прошлой перезагрузке сторожа — переживает саму перезагрузку. */
const RELOAD_KEY = 'andreytracker.stuck';

function readReloadStamp(): number | null {
  try {
    const raw = window.localStorage.getItem(RELOAD_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeReloadStamp(at: number): void {
  try {
    window.localStorage.setItem(RELOAD_KEY, String(at));
  } catch {
    // приватный режим или переполнение — переживём без отметки
  }
}

/**
 * Отпечаток состояния. Если при опросе он отличается от того, что последним
 * пришло по потоку, значит на сервере что-то произошло, а поток нам этого
 * не принёс — он мёртв, и пересоздавать его надо немедленно.
 */
function signature(s: TrackerState): string {
  return [
    s.sleep.status,
    s.sleep.since,
    s.today.sleepTotalMin,
    s.today.sleepSessions,
    s.pending,
  ].join('|');
}

export interface TrackerData {
  state: TrackerState | null;
  /** Все события за последние 30 часов: сон, кормления, подгузники, замеры. */
  events: TrackerEvent[];
  /** Взвешивания за всю историю — от веса при рождении. */
  measures: TrackerEvent[];
  utterances: Utterance[];
  link: LinkStatus;
  /** /healthz, если сервер его отдал. null — просто не знаем. */
  health: Health | null;
  /** Когда последний раз пришли свежие данные (локальные мс). */
  lastSyncAt: number | null;
  /** Сдвиг часов сервера относительно локальных, мс. */
  clockOffset: number;
  /** Ни разу не получили данных — показываем экран загрузки. */
  booting: boolean;
  /** Сохранить снимок прямо сейчас (перед самообновлением). */
  persist: () => void;
}

export function useTracker(): TrackerData {
  // Снимок прошлой сессии: после самообновления экран рисуется сразу,
  // без чёрной паузы, а свежие данные подъезжают через секунду.
  const restored = useRef(loadSnapshot()).current;

  const [state, setState] = useState<TrackerState | null>(restored?.state ?? null);
  const [events, setEvents] = useState<TrackerEvent[]>(restored?.events ?? []);
  const [measures, setMeasures] = useState<TrackerEvent[]>(restored?.measures ?? []);
  const [utterances, setUtterances] = useState<Utterance[]>(restored?.utterances ?? []);
  const [link, setLink] = useState<LinkStatus>('connecting');
  const [health, setHealth] = useState<Health | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [booting, setBooting] = useState(restored === null);

  const offsetRef = useRef(0);
  const mountedRef = useRef(true);
  /** Когда последний раз хоть что-то пришло с сервера. */
  const lastOkRef = useRef(Date.now());
  /** Получали ли мы данные хоть раз за эту загрузку страницы. */
  const everOkRef = useRef(false);
  /** Когда страница начала работать — сторож не должен сработать на старте. */
  const startedAtRef = useRef(Date.now());
  /** Когда последний раз что-то приходило по SSE (не по REST). */
  const lastStreamAt = useRef(Date.now());
  /** Отпечаток последнего состояния, полученного именно по потоку. */
  const lastStreamSig = useRef<string | null>(null);
  /** Смена эпохи пересоздаёт EventSource. */
  const [streamEpoch, setStreamEpoch] = useState(0);

  /** Обновление state: заодно ловим сдвиг часов сервера. */
  const applyState = useCallback((next: TrackerState) => {
    if (!mountedRef.current) return;
    lastOkRef.current = Date.now();
    everOkRef.current = true;
    setState(next);
    setLastSyncAt(Date.now());
    setBooting(false);
    const serverMs = Date.parse(next.now);
    if (Number.isFinite(serverMs)) {
      const offset = serverMs - Date.now();
      // Пересчитываем только при заметном расхождении, чтобы не дёргать рендер.
      if (Math.abs(offset - offsetRef.current) > 1500) {
        offsetRef.current = offset;
        setClockOffset(offset);
      }
    }
  }, []);

  const applyUtterance = useCallback((next: Utterance) => {
    if (!mountedRef.current) return;
    setUtterances((prev) => {
      const idx = prev.findIndex((item) => item.id === next.id);
      if (idx === -1) {
        const received = next.received_at ?? new Date().toISOString();
        return [{ ...next, received_at: received }, ...prev].slice(0, UTTERANCE_LIMIT);
      }
      const merged = prev.slice();
      merged[idx] = { ...merged[idx], ...next };
      return merged;
    });
    setLastSyncAt(Date.now());
  }, []);

  /**
   * Полная дозагрузка по REST. Вызывается на старте, при каждом (пере)подключении SSE
   * и по медленному таймеру. Важно: при ошибке НИЧЕГО не затираем — на экране
   * должны остаться последние известные данные.
   */
  const refreshAll = useCallback(async (): Promise<boolean> => {
    const results = await Promise.allSettled([
      fetchState(),
      fetchMeasures(),
      fetchUtterances(UTTERANCE_LIMIT),
      fetchRecentEvents(),
    ]);
    if (!mountedRef.current) return false;

    let ok = false;
    const [stateRes, measuresRes, uttRes, eventsRes] = results;
    if (stateRes.status === 'fulfilled') {
      applyState(stateRes.value);
      ok = true;
    }
    if (measuresRes.status === 'fulfilled') {
      setMeasures(measuresRes.value);
      ok = true;
    }
    if (uttRes.status === 'fulfilled') {
      setUtterances(uttRes.value.slice(0, UTTERANCE_LIMIT));
      ok = true;
    }
    if (eventsRes.status === 'fulfilled') {
      setEvents(eventsRes.value);
      ok = true;
    }
    if (ok) {
      lastOkRef.current = Date.now();
      everOkRef.current = true;
      setLastSyncAt(Date.now());
    }
    return ok;
  }, [applyState]);

  // --- первичная загрузка + ретраи, пока сервер не ответит ---
  useEffect(() => {
    mountedRef.current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const attempt = async () => {
      const ok = await refreshAll();
      if (!mountedRef.current) return;
      if (!ok) {
        // Пока не получили ничего ни разу, называть себя «на связи» нельзя,
        // даже если поток событий отрапортовал об открытии: именно на этом
        // экран телевизора и застревал в «подключении» навсегда.
        setLink((prev) =>
          everOkRef.current && prev === 'online' ? prev : 'offline',
        );
        retry = setTimeout(attempt, 5000);
      }
    };
    void attempt();

    const slow = setInterval(() => void refreshAll(), SLOW_REFRESH_MS);
    return () => {
      mountedRef.current = false;
      if (retry) clearTimeout(retry);
      clearInterval(slow);
    };
  }, [refreshAll]);

  // --- SSE ---
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const parse = <T,>(raw: string): T | null => {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    };

    /** Поток не открылся за отведённое время — считаем попытку неудачной. */
    let openDeadline: ReturnType<typeof setTimeout> | undefined;

    const retryLater = () => {
      es?.close();
      es = null;
      if (reconnect) clearTimeout(reconnect);
      reconnect = setTimeout(connect, RECONNECT_MS);
    };

    const connect = () => {
      if (closed) return;
      // Куку сессии (§11) EventSource отправляет сам: поток всегда с того же
      // origin. Это и есть выигрыш по сравнению с basic auth, при котором
      // EventSource не умел слать Authorization вовсе.
      es = new EventSource(apiUrl('/api/stream'));

      // EventSource умеет зависнуть в CONNECTING навсегда: ни onopen, ни
      // onerror. Для экрана это выглядело как вечное «подключение».
      if (openDeadline) clearTimeout(openDeadline);
      openDeadline = setTimeout(() => {
        if (closed || !es || es.readyState === EventSource.OPEN) return;
        setLink('offline');
        retryLater();
      }, STREAM_OPEN_MS);

      es.onopen = () => {
        if (closed) return;
        if (openDeadline) clearTimeout(openDeadline);
        lastStreamAt.current = Date.now();
        setLink('online');
        // При переподключении могли пропустить события — дочитываем по REST.
        void refreshAll();
      };

      es.addEventListener('state', (ev) => {
        const next = parse<TrackerState>((ev as MessageEvent<string>).data);
        if (next) {
          lastStreamAt.current = Date.now();
          lastOkRef.current = Date.now();
          lastStreamSig.current = signature(next);
          setLink('online');
          applyState(next);
        }
      });

      es.addEventListener('event', (ev) => {
        const msg = parse<EventMessage>((ev as MessageEvent<string>).data);
        if (!msg?.event) return;
        lastStreamAt.current = Date.now();
        setLink('online');
        setLastSyncAt(Date.now());
        setEvents((prev) =>
          msg.action === 'deleted'
            ? prev.filter((item) => item.id !== msg.event.id)
            : upsertEvent(prev, msg.event),
        );
        // Замеры живут отдельным списком (вся история, а не 30 часов).
        if (msg.event.type === 'measure') {
          setMeasures((prev) =>
            msg.action === 'deleted'
              ? prev.filter((item) => item.id !== msg.event.id)
              : upsertEvent(prev, msg.event),
          );
        }
      });

      es.addEventListener('utterance', (ev) => {
        const next = parse<Utterance>((ev as MessageEvent<string>).data);
        if (next && typeof next.id === 'number') {
          lastStreamAt.current = Date.now();
          setLink('online');
          applyUtterance(next);
        }
      });

      // Безымянные сообщения (на случай, если сервер шлёт data без event:)
      es.onmessage = () => {
        lastStreamAt.current = Date.now();
        setLink('online');
        setLastSyncAt(Date.now());
      };

      es.onerror = () => {
        if (closed) return;
        setLink('offline');
        // readyState CLOSED (2) — браузер сдался, поднимаем руками.
        if (es && es.readyState === EventSource.CLOSED) retryLater();
      };
    };

    connect();

    // Сторож: раз в 5 с проверяем, что поток жив. Спящий Wi-Fi телевизора
    // умеет оставлять EventSource в CLOSED без onerror.
    const watchdog = setInterval(() => {
      if (closed) return;
      if (!es || es.readyState === EventSource.CLOSED) {
        setLink('offline');
        es?.close();
        es = null;
        if (!reconnect) reconnect = setTimeout(connect, RECONNECT_MS);
      }
    }, 5000);

    return () => {
      closed = true;
      clearInterval(watchdog);
      if (reconnect) clearTimeout(reconnect);
      if (openDeadline) clearTimeout(openDeadline);
      es?.close();
    };
  }, [applyState, applyUtterance, refreshAll, streamEpoch]);

  /**
   * Активная проверка связи. Нужна потому, что «мёртвый» поток не всегда даёт onerror:
   * прокси (vite, nginx, Cloudflare Tunnel) умеет держать сокет открытым, когда
   * бэкенд уже умер — EventSource при этом считает, что всё хорошо, и молчит.
   * Поэтому при затянувшейся тишине сами ходим за /api/state.
   */
  useEffect(() => {
    const probe = setInterval(async () => {
      const silence = Date.now() - lastStreamAt.current;
      if (silence < SILENCE_MS) return;

      const ctrl = new AbortController();
      const bail = setTimeout(() => ctrl.abort(), 6000);
      try {
        const next = await fetchState(ctrl.signal);
        if (!mountedRef.current) return;
        applyState(next);
        setLink('online');

        // HTTP жив. Поток считаем мёртвым, если сервер успел измениться,
        // а нам об этом не сообщил (или молчит уже совсем неприлично долго).
        const sig = signature(next);
        const missedUpdate = lastStreamSig.current !== null && lastStreamSig.current !== sig;
        if (missedUpdate || silence > ZOMBIE_MS) {
          lastStreamAt.current = Date.now();
          lastStreamSig.current = sig;
          setStreamEpoch((n) => n + 1);
        }
      } catch {
        if (mountedRef.current) setLink('offline');
      } finally {
        clearTimeout(bail);
      }
    }, PROBE_EVERY_MS);
    return () => clearInterval(probe);
  }, [applyState]);

  // --- /healthz: доступен ли разбор фраз ---
  useEffect(() => {
    let alive = true;
    const ask = async () => {
      try {
        const next = await fetchHealth();
        if (alive && mountedRef.current) setHealth(next);
      } catch {
        // Не беда: индикатор просто не показываем.
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), HEALTH_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // --- снимок для мгновенного старта ---
  const latest = useRef({ state, events, measures, utterances });
  latest.current = { state, events, measures, utterances };

  const persist = useCallback(() => saveSnapshot(latest.current), []);

  useEffect(() => {
    // Раз в 15 с, а не на каждое изменение: сериализовать сотни событий
    // каждую секунду ни к чему.
    const timer = setInterval(persist, 15_000);
    window.addEventListener('pagehide', persist);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', persist);
    };
  }, [persist]);

  /*
   * Последнее средство: перезагрузка страницы.
   *
   * Когда сеть встала так, что запросы висят, а не падают, странице уже не
   * помогут ни повторы, ни новый поток — её сокеты принадлежат ей самой.
   * Перезагрузка бросает их все разом. Условия срабатывания — в `shouldReload`;
   * снимок экрана сохраняем заранее, чтобы после перезагрузки не мигать
   * пустотой. Отметку о перезагрузке читаем один раз: новая загрузка страницы
   * прочитает её заново и увидит, что попытка уже была.
   */
  useEffect(() => {
    const lastReloadAt = readReloadStamp();
    const timer = setInterval(() => {
      if (!mountedRef.current) return;
      const now = Date.now();
      const stuck = shouldReload({
        now,
        lastOkAt: lastOkRef.current,
        startedAt: startedAtRef.current,
        lastReloadAt,
      });
      if (!stuck) return;
      writeReloadStamp(now);
      try {
        persist();
      } catch {
        // снимок не обязателен
      }
      window.location.reload();
    }, PROBE_EVERY_MS);
    return () => clearInterval(timer);
  }, [persist]);

  return {
    state,
    events,
    measures,
    utterances,
    link,
    health,
    lastSyncAt,
    clockOffset,
    booting,
    persist,
  };
}
