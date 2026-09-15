import { useCallback, useEffect, useState } from 'react';

export type Route = 'overview' | 'stats' | 'history';

const ROUTES: Route[] = ['overview', 'stats', 'history'];

function read(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (ROUTES as string[]).includes(raw) ? (raw as Route) : 'overview';
}

/**
 * Маршрут в хэше: приложение отдаётся по /dash, и адрес получается /dash/#/stats.
 * Так экран переживает перезагрузку и работает кнопка «назад», а серверу не нужен
 * SPA-fallback на произвольные пути под /dash — он про него ничего не знает.
 */
export function useHashRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(read);

  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((next: Route) => {
    window.location.hash = `#/${next}`;
    setRoute(next);
  }, []);

  return [route, go];
}
