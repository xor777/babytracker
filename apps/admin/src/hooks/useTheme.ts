import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'bt-theme';

/** Цвет строки состояния должен совпадать с фоном, иначе получится тёмная полоса над светлым. */
const THEME_COLOR = { light: '#eef1f4', dark: '#070b0e' };

export function readThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // приватный режим — остаёмся на системной
  }
  return 'system';
}

/** Применение темы вынесено наружу: тот же код работает до монтирования React. */
export function applyTheme(mode: ThemeMode): void {
  const prefersLight =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  const light = mode === 'light' || (mode === 'system' && prefersLight);
  document.documentElement.classList.toggle('theme-light', light);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? THEME_COLOR.light : THEME_COLOR.dark);
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readThemeMode);

  useEffect(() => {
    applyTheme(mode);
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyTheme(mode);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const choose = useCallback((next: ThemeMode) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // выбор не переживёт перезапуск, но текущую сессию отработает
    }
    setMode(next);
  }, []);

  return { mode, choose };
}
