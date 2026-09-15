import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, readThemeMode } from './hooks/useTheme';
import './styles.css';

// Тему применяем до первого кадра, иначе при светлой настройке моргнёт тёмным.
applyTheme(readThemeMode());

const root = document.getElementById('root');
if (!root) throw new Error('#root не найден');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/*
 * Service worker: приложение с домашнего экрана не должно превращаться в белый
 * экран, когда телефон в очередной раз потерял сеть. Регистрируем после загрузки,
 * чтобы не отнимать время у первого рендера.
 */
if ('serviceWorker' in navigator) {
  const base = import.meta.env.BASE_URL;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      // без офлайна жить можно — приложение остаётся рабочим
    });
  });
}
