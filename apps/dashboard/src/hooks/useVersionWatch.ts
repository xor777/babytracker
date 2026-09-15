import { useEffect, useRef } from 'react';

/**
 * Самообновление экрана.
 *
 * WebView телевизора загружает страницу один раз и держит её сутками: после
 * выката человек видит старую версию, пока кто-нибудь не сходит за пультом.
 * Поэтому дашборд сам следит за версией.
 *
 * Как узнаём версию: Vite подмешивает хеш в имя бандла, и в `index.html` лежит
 * ссылка вида `/assets/index-DNl0KYR5.js`. Периодически перечитываем свой же
 * `index.html` (`cache: no-store`) и сравниваем имя с тем, которым запущены.
 * Ничего не требуется ни от сервера, ни от сборки.
 */
const CHECK_EVERY_MS = 60_000;
/** Сколько раз подряд надо увидеть новую версию, прежде чем перезагружаться. */
const CONFIRMATIONS = 2;
/** Не чаще одной попытки на версию в этот срок. */
const MIN_RETRY_MS = 10 * 60 * 1000;
/** Больше двух попыток на одну и ту же версию — значит что-то не так, прекращаем. */
const MAX_ATTEMPTS = 2;
const GUARD_KEY = 'andreytracker.reload';

interface Guard {
  target: string;
  at: number;
  attempts: number;
}

function readGuard(): Guard | null {
  try {
    const raw = window.localStorage.getItem(GUARD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Guard;
    return typeof parsed?.target === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeGuard(guard: Guard | null): void {
  try {
    if (guard) window.localStorage.setItem(GUARD_KEY, JSON.stringify(guard));
    else window.localStorage.removeItem(GUARD_KEY);
  } catch {
    // приватный режим или переполнение — переживём без защиты от цикла
  }
}

/** Путь бандла, которым запущена текущая страница. null — dev-режим, слежение не нужно. */
function runningAsset(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  const src = el?.getAttribute('src');
  if (!src) return null;
  const path = new URL(src, window.location.href).pathname;
  return /\/assets\/.+\.js$/.test(path) ? path : null;
}

function extractAsset(html: string): string | null {
  for (const match of html.matchAll(/src="([^"]+\.js)"/g)) {
    const raw = match[1];
    if (!raw.includes('/assets/')) continue;
    try {
      return new URL(raw, window.location.href).pathname;
    } catch {
      return null;
    }
  }
  return null;
}

/** «index-DNl0KYR5.js» → «DNl0KYR5»: стабильный ярлык версии для адреса. */
function versionTag(assetPath: string): string {
  const name = assetPath.split('/').pop() ?? assetPath;
  const parts = name.replace(/\.js$/, '').split('-');
  return parts[parts.length - 1] || name;
}

export interface VersionWatchOptions {
  /** Вызывается прямо перед перезагрузкой — сохранить снимок экрана. */
  onBeforeReload?: () => void;
}

export function useVersionWatch({ onBeforeReload }: VersionWatchOptions = {}): void {
  const pending = useRef<{ target: string; seen: number } | null>(null);
  const beforeReload = useRef(onBeforeReload);
  beforeReload.current = onBeforeReload;

  useEffect(() => {
    const current = runningAsset();
    if (!current) return; // dev: обновлением занимается HMR

    // Прошлая перезагрузка удалась — снимаем защиту, чтобы она не мешала дальше.
    const guard = readGuard();
    if (guard && guard.target === current) writeGuard(null);

    const indexUrl = `${window.location.origin}${window.location.pathname}`;
    let stopped = false;

    const reloadTo = (target: string) => {
      const rec = readGuard();
      const now = Date.now();
      if (rec?.target === target) {
        // Уже пробовали: не зацикливаемся, если после перезагрузки страница
        // снова оказывается старой (например, промежуточный кеш отдаёт своё).
        if (rec.attempts >= MAX_ATTEMPTS) return;
        if (now - rec.at < MIN_RETRY_MS) return;
        writeGuard({ target, at: now, attempts: rec.attempts + 1 });
      } else {
        writeGuard({ target, at: now, attempts: 1 });
      }

      try {
        beforeReload.current?.();
      } catch {
        // снимок не обязателен
      }

      // Метка версии в адресе обходит кеш HTML и при этом стабильна:
      // повторная попытка той же версии не плодит новых адресов.
      const url = new URL(window.location.href);
      url.searchParams.set('_v', versionTag(target));
      window.location.replace(url.toString());
    };

    const check = async () => {
      if (stopped) return;
      let html: string;
      try {
        const res = await fetch(indexUrl, { cache: 'no-store', headers: { accept: 'text/html' } });
        if (!res.ok) return; // сервер недоступен — это не повод обновляться
        html = await res.text();
      } catch {
        return; // обрыв связи не должен приводить к перезагрузке
      }
      if (stopped) return;

      const deployed = extractAsset(html);
      if (!deployed) return; // не распознали страницу — молчим

      if (deployed === current) {
        pending.current = null;
        return;
      }

      // Подтверждаем находку: одиночный странный ответ (или момент выката,
      // когда файлы ещё доливаются) не должен приводить к перезагрузке.
      const seen = pending.current?.target === deployed ? pending.current.seen + 1 : 1;
      pending.current = { target: deployed, seen };
      if (seen >= CONFIRMATIONS) reloadTo(deployed);
    };

    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    // Первую проверку делаем не сразу: дать экрану загрузиться и не совпасть
    // с волной стартовых запросов.
    const first = setTimeout(() => void check(), 20_000);

    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(first);
    };
  }, []);
}
