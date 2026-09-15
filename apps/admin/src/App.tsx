import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './types';
import { useHashRoute } from './hooks/useHashRoute';
import { HistoryScreen } from './components/HistoryScreen';
import { StatsScreen } from './components/StatsScreen';
import { plural } from './lib/format';

interface Child {
  name: string;
  ageDays: number;
}

const TABS = [
  { id: 'history' as const, label: 'Журнал' },
  { id: 'stats' as const, label: 'Сводка' },
];

export function App() {
  const [route, go] = useHashRoute();
  const [child, setChild] = useState<Child | null>(null);
  const [authBlocked, setAuthBlocked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/state', { signal: ac.signal, cache: 'no-store' });
        if (res.status === 401) {
          setAuthBlocked(true);
          return;
        }
        if (!res.ok) throw new ApiError(res.status, 'state');
        const data = await res.json();
        setChild({ name: data?.child?.name ?? 'Ребёнок', ageDays: data?.child?.ageDays ?? 0 });
      } catch {
        // Шапка — украшение: без неё экран обязан работать.
      }
    })();
    return () => ac.abort();
  }, []);

  const onBusy = useCallback((value: boolean) => setBusy(value), []);

  /**
   * 401 приходит от Basic Auth на Caddy (§10.4). Броузер спрашивает пароль сам,
   * но если сессия отвалилась посреди работы — fetch просто получает 401 и молчит.
   * Поэтому говорим прямо: нужна перезагрузка, тогда снова появится окно входа.
   */
  if (authBlocked) {
    return (
      <div className="app">
        <main className="main">
          <p className="placeholder">
            <span className="placeholder__big">Нужен вход</span>
            Сервер просит логин и пароль. Обновите страницу — браузер спросит их снова.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn--primary"
              style={{ flex: 'none' }}
              onClick={() => window.location.reload()}
            >
              Обновить страницу
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__row">
          <div className="brand">
            <span className="brand__name">{child?.name ?? 'BabyTracker'}</span>
            {child ? (
              <span className="brand__age">
                {child.ageDays} {plural(child.ageDays, 'день', 'дня', 'дней')}
              </span>
            ) : null}
          </div>
          <span className="topbar__spacer" />
          <button
            type="button"
            className="icon-btn"
            data-busy={busy}
            onClick={() => window.location.reload()}
            aria-label="Обновить"
            title="Обновить"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="segmented" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="segmented__item"
              aria-selected={route === tab.id}
              onClick={() => go(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <main className="main">
        {route === 'history' ? <HistoryScreen onBusy={onBusy} /> : <StatsScreen />}
      </main>
    </div>
  );
}
