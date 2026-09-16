import { useCallback, useEffect, useState } from 'react';
import { useTheme } from './hooks/useTheme';
import { useConnection } from './hooks/useConnection';
import { SettingsSheet } from './components/SettingsSheet';
import { formatWhen } from './lib/format';
import { fetchState, goToPairing } from './api';
import { ApiError } from './types';
import { useHashRoute } from './hooks/useHashRoute';
import { OverviewScreen } from './components/OverviewScreen';
import { HistoryScreen } from './components/HistoryScreen';
import { StatsScreen } from './components/StatsScreen';
import { DevicesScreen } from './components/DevicesScreen';
import { useDevices } from './hooks/useDevices';
import { plural } from './lib/format';

interface Child {
  name: string;
  ageDays: number;
}

/*
 * Обзор первым и по умолчанию: девять из десяти заходов — это «что с ним сейчас
 * и сколько он сегодня съел», а не разбор истории. Сводка вторая — туда идут
 * осознанно, за динамикой. Журнал третий: это инструмент починки, нужный реже.
 */
const TABS = [
  { id: 'overview' as const, label: 'День' },
  { id: 'stats' as const, label: 'Сводка' },
  { id: 'history' as const, label: 'Журнал' },
];

export function App() {
  const [route, go] = useHashRoute();
  const [child, setChild] = useState<Child | null>(null);
  const [authBlocked, setAuthBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const theme = useTheme();
  const link = useConnection();
  /*
   * Заявки опрашиваем ТОЛЬКО пока открыт экран устройств.
   *
   * Раньше опрос шёл всё время, пока приложение открыто, и кормил баннер
   * «N устройств просят доступ», всплывавший поверх любого экрана. Баннера
   * больше нет (см. ниже), а опрос ради того, чего нигде не показывают, —
   * это запрос к серверу каждые двадцать секунд с каждого телефона впустую.
   */
  const devices = useDevices(authBlocked || route !== 'devices' ? 'off' : 'active');

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const data = await fetchState(ac.signal);
        setChild({ name: data?.child?.name ?? 'Ребёнок', ageDays: data?.child?.ageDays ?? 0 });
      } catch (err) {
        // Шапка — украшение: без неё экран обязан работать. Кроме 401 — он означает,
        // что и остальные запросы не пройдут, и человеку нужно об этом сказать.
        if (err instanceof ApiError && err.status === 401) setAuthBlocked(true);
      }
    })();
    return () => ac.abort();
  }, []);

  const onBusy = useCallback((value: boolean) => setBusy(value), []);

  /**
   * 401 означает, что сессии устройства больше нет: её отозвали, она истекла
   * или приложение открылось из офлайн-кэша, пережившего выход (§11).
   *
   * Перезагрузка здесь не поможет и даже вредна: service worker честно отдаст
   * сохранённую оболочку, и человек будет по кругу видеть работающее на вид
   * приложение, которое не может получить ни одной цифры. Поэтому уводим на
   * страницу сопряжения — и по дороге стираем офлайн-кэш, чтобы приложение
   * не показывало историю ребёнка из памяти телефона после выхода.
   */
  if (authBlocked) {
    return (
      <div className="app">
        {/* Офлайн: показываем последнее известное состояние, но честно датируем его. */}
      {link.stale || !link.online ? (
        <div className="offline" role="status">
          {link.online ? 'Сервер не ответил' : 'Нет сети'}
          {link.cachedAt
            ? ` · данные от ${formatWhen(link.cachedAt)}`
            : ' · показано последнее, что загрузилось'}
        </div>
      ) : null}

      <main className="main">
          <p className="placeholder">
            <span className="placeholder__big">Сессия завершена</span>
            Это устройство больше не подключено к дневнику. Подключите его заново:
            откроется экран с кодом, который нужно одобрить с другого устройства.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn--primary"
              style={{ flex: 'none' }}
              onClick={() => goToPairing()}
            >
              Подключить устройство
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
            <span className="brand__name">{child?.name ?? 'ANDREYTRACKER'}</span>
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
          <button
            type="button"
            className="icon-btn"
            onClick={() => setSettings(true)}
            aria-label="Настройки"
            title="Настройки"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="3.1" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
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

      {/* Офлайн: показываем последнее известное состояние, но честно датируем его. */}
      {link.stale || !link.online ? (
        <div className="offline" role="status">
          {link.online ? 'Сервер не ответил' : 'Нет сети'}
          {link.cachedAt
            ? ` · данные от ${formatWhen(link.cachedAt)}`
            : ' · показано последнее, что загрузилось'}
        </div>
      ) : null}

      {/*
        Баннера «N устройств просят доступ» здесь больше нет, и это главное
        изменение экрана, а не уборка лишнего.

        Он всплывал поверх любого экрана, пока есть заявки, и вёл в одобрение
        одним нажатием. Заказчик: «чтобы на главной не всплывало и жена
        случайно не одобрила никому» — дневником пользуются двое, и второй
        человек только осваивает приложение. Всплывающее «кто-то просит
        доступ» с кнопкой рядом — это приглашение нажать, а нажатие впускало
        чужое устройство в историю ребёнка.

        Одобрение переехало целиком на #/devices и требует набрать код с
        экрана устройства. Сюда не просачивается ни баннер, ни счётчик заявок:
        любое число «ждут: N» на обычном экране — тот же соблазн, только
        мельче шрифтом.
      */}

      <main className="main">
        {route === 'overview' ? <OverviewScreen /> : null}
        {route === 'stats' ? <StatsScreen /> : null}
        {route === 'history' ? <HistoryScreen onBusy={onBusy} /> : null}
        {route === 'devices' ? <DevicesScreen devices={devices} /> : null}
      </main>

      {settings ? (
        <SettingsSheet
          mode={theme.mode}
          onChoose={theme.choose}
          cachedAt={link.cachedAt}
          online={link.online}
          onDevices={() => {
            setSettings(false);
            go('devices');
          }}
          onClose={() => setSettings(false)}
        />
      ) : null}
    </div>
  );
}
