import { useEffect, useState } from 'react';
import { currentFreshness, onFreshness } from '../api';

/**
 * Связь и свежесть данных. Телефон теряет сеть постоянно, и приложение,
 * запущенное с домашнего экрана, обязано в этот момент показывать последнее
 * известное состояние — но так, чтобы человек понимал: это не «сейчас».
 */
export function useConnection() {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [cachedAt, setCachedAt] = useState<string | null>(currentFreshness);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const off = onFreshness(setCachedAt);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      off();
    };
  }, []);

  return { online, cachedAt, stale: cachedAt !== null };
}
