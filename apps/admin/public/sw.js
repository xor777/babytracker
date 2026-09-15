/*
 * Service worker админки /dash.
 *
 * Задача одна: телефон постоянно теряет сеть, и приложение, запущенное с
 * домашнего экрана, не должно превращаться в белый экран. Поэтому последнее
 * известное состояние отдаётся из кэша — но честно помеченным датой, чтобы
 * интерфейс мог сказать «данные от 19:45», а не выдать вчерашние цифры
 * за сегодняшние.
 *
 * Про аутентификацию: все запросы идут тем же Request, что создала страница,
 * то есть с credentials: 'same-origin'. Basic Auth на Caddy при этом проходит
 * штатно, и отдельного хранилища учётных данных воркеру не нужно.
 * Ответы 401 не кэшируются никогда — иначе после разлогина приложение
 * показывало бы «успешный» кэш вместо запроса пароля.
 */

const VERSION = 'v1';
const SHELL = `bt-shell-${VERSION}`;
const DATA = `bt-data-${VERSION}`;
const SCOPE = new URL(self.registration.scope).pathname; // «/dash/»
const INDEX = `${SCOPE}index.html`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll([INDEX, `${SCOPE}manifest.webmanifest`]))
      .catch(() => undefined) // офлайн на установке — не повод падать
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/** Ответ из кэша помечаем датой — по ней интерфейс пишет «данные от 19:45». */
async function putStamped(cacheName, request, response) {
  if (!response.ok) return response;
  const body = await response.clone().arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set('x-cached-at', new Date().toISOString());
  const cache = await caches.open(cacheName);
  await cache.put(request, new Response(body, { status: 200, headers }));
  return response;
}

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    // 401 в кэш не кладём: иначе запрос пароля подменится «успешным» ответом.
    if (fresh.status === 401) return fresh;
    return await putStamped(DATA, request, fresh);
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh.status === 401) return fresh;
  return putStamped(cacheName, request, fresh);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Переход по адресу: сначала сеть, иначе — сохранённая оболочка приложения.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => putStamped(SHELL, INDEX, res))
        .catch(async () => (await caches.match(INDEX)) ?? Response.error()),
    );
    return;
  }

  // Собранные ассеты неизменяемы (имя содержит хэш) — можно смело из кэша.
  if (url.pathname.startsWith(`${SCOPE}assets/`)) {
    event.respondWith(cacheFirst(request, SHELL));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.startsWith(SCOPE)) {
    event.respondWith(
      cacheFirst(request, SHELL).catch(async () => (await caches.match(request)) ?? Response.error()),
    );
  }
});
