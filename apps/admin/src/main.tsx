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
 *
 * Про дверь (§11). Файл воркера лежит под /dash и закрыт сессией, как и всё
 * остальное. Это работает потому, что браузер запрашивает скрипт воркера в
 * режиме credentials «same-origin» — то есть с нашей же кукой, — а регистрация
 * идёт из уже загруженного приложения, у которого сессия по определению есть.
 *
 * Полезный побочный эффект: после выхода воркер не сможет ни обновиться, ни
 * установиться заново — сервер ответит ему 401.
 *
 * Если какой-нибудь браузер всё же откажется слать куку, отказ будет мягким:
 * приложение останется полностью рабочим, просто без офлайна. Но молчать о
 * таком нельзя — иначе потерю офлайна обнаружат в метро через полгода.
 */
if ('serviceWorker' in navigator) {
  const base = import.meta.env.BASE_URL;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((err: unknown) => {
      console.warn(
        'офлайн-режим недоступен: не удалось зарегистрировать service worker.',
        err,
      );
    });
  });
}
