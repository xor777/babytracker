import { useCallback, useEffect, useState } from 'react';

/**
 * `devices` — экран одобрения и отзыва устройств (§11). Вкладки для него нет
 * намеренно: заходят туда несколько раз в жизни, а место в нижней навигации
 * стоит дорого. Попасть можно из настроек и по баннеру, который появляется
 * сам, когда кто-то просится.
 */
export type Route = 'overview' | 'stats' | 'history' | 'devices';

const ROUTES: Route[] = ['overview', 'stats', 'history', 'devices'];

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
