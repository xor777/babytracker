/*
 * Service worker админки /dash.
 *
 * Задача одна: телефон постоянно теряет сеть, и приложение, запущенное с
 * домашнего экрана, не должно превращаться в белый экран. Поэтому последнее
 * известное состояние отдаётся из кэша — но честно помеченным датой, чтобы
 * интерфейс мог сказать «данные от 19:45», а не выдать вчерашние цифры
 * за сегодняшние.
 *
 * Про аутентификацию (§11: сессии устройств вместо basic auth). Все запросы
 * идут тем же Request, что создала страница, то есть с кукой сессии; своего
 * хранилища секретов воркеру не нужно и быть не должно.
 *
 * Две ловушки, обе тихие, обе приводят к тому, что приложение выглядит
 * работающим, когда доступа уже нет:
 *
 *  1. Ответ 401 в кэше подменил бы собой требование войти. Не кэшируем.
 *  2. Куда опаснее: без сессии сервер отвечает на переход РЕДИРЕКТОМ на
 *     страницу сопряжения. `fetch` следует за ним молча и возвращает вполне
 *     успешный ответ 200 — страницу с кодом. Положив его в кэш под именем
 *     оболочки приложения, воркер намертво подменил бы дневник экраном
 *     сопряжения, и переживало бы это даже возврат сессии. Поэтому ответы,
 *     полученные через редирект, в кэш не попадают никогда.
 */

/* Версия сменена вместе с переездом на сессии устройств: старые кэши, снятые
   при basic auth, надо выбросить целиком, а не донашивать. */
const VERSION = 'v2';
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

/** Можно ли вообще класть этот ответ в кэш. */
function cacheable(response) {
  // `redirected` — это и есть признак, что сервер увёл нас на страницу
  // сопряжения: статус при этом 200, и по нему отличить нельзя.
  if (!response.ok || response.redirected) return false;
  if (response.type === 'opaqueredirect') return false;
  return true;
}

/** Ответ из кэша помечаем датой — по ней интерфейс пишет «данные от 19:45». */
async function putStamped(cacheName, request, response) {
  if (!cacheable(response)) return response;
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
    // 401 в кэш не кладём: иначе требование войти подменится «успешным» ответом.
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
        .then((res) => {
          // Увели на сопряжение — отдаём как есть и НЕ трогаем кэш оболочки.
          if (!cacheable(res)) return res;
          return putStamped(SHELL, INDEX, res);
        })
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

/*
 * Выход из сессии: страница просит забыть всё, что отложено про запас.
 *
 * Страница и сама умеет чистить `caches` — они на том же origin, — но воркер
 * может успеть положить что-то обратно между её вызовом и снятием
 * регистрации. Поэтому уборку делает и он, по прямой просьбе.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'bt-forget') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});
