/**
 * §11: дверь. Единственная точка проверки доступа.
 *
 * Это главное место риска всей затеи. Раньше сторожил Caddy и сторожил всё
 * скопом; теперь сторожит приложение, а у Fastify есть несколько способов
 * отдать ответ мимо обработчика маршрута — статика, SPA-fallback, обработчик
 * 404. Забыть любой из них значит открыть историю ребёнка всему интернету,
 * причём молча: ответ будет выглядеть совершенно нормальным.
 *
 * Поэтому проверка здесь тупая и полная: берём каждый путь, которым сервер
 * вообще может что-то отдать, и требуем, чтобы без сессии он не отдал ничего.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { TEST_SECRET, aliceBody, authorize, makeTestApp, testConfig, testDb } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { isOpenPath, pathOf, safeNext } from '../src/auth-guard.ts';
import { SESSION_COOKIE, issueSession } from '../src/device-auth.ts';

/* ------------------------------------------------------------------ */
/* Приложение, максимально похожее на боевое: со всей статикой на диске */
/* ------------------------------------------------------------------ */

const DASHBOARD_MARK = 'ДАШБОРД-ТЕЛЕВИЗОРА-СЕКРЕТ';
const ADMIN_MARK = 'АДМИНКА-СЕКРЕТ';

interface Fixture {
  app: ReturnType<typeof createApp>['app'];
  db: ReturnType<typeof testDb>;
  cookie: string;
  close: () => Promise<void>;
}

/** Собранный дашборд и собранная админка на диске — как после pnpm build. */
async function makeFullApp(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-guard-'));
  const tv = path.join(dir, 'tv');
  const admin = path.join(dir, 'admin');
  fs.mkdirSync(path.join(tv, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(admin, 'assets'), { recursive: true });

  fs.writeFileSync(path.join(tv, 'index.html'), `<html>${DASHBOARD_MARK}</html>`);
  fs.writeFileSync(path.join(tv, 'assets', 'app-a1b2c3.js'), `// ${DASHBOARD_MARK} bundle`);
  fs.writeFileSync(path.join(admin, 'index.html'), `<html>${ADMIN_MARK}</html>`);
  fs.writeFileSync(path.join(admin, 'assets', 'admin-d4e5f6.js'), `// ${ADMIN_MARK} bundle`);
  fs.writeFileSync(path.join(admin, 'sw.js'), 'self.addEventListener("install", () => {});');
  fs.writeFileSync(path.join(admin, 'manifest.webmanifest'), '{"name":"BabyTracker"}');
  fs.writeFileSync(path.join(admin, 'icon-192.png'), 'PNG');

  const cfg = testConfig({ DASHBOARD_DIST: tv, ADMIN_DIST: admin });
  const db = testDb();
  const { app, sse } = createApp({ cfg, db, logger: false });
  await app.ready();

  const issued = issueSession(db, { kind: 'browser', label: 'Тест' });

  return {
    app,
    db,
    cookie: `${SESSION_COOKIE}=${issued.token}`,
    close: async () => {
      sse.close();
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ================================================================== */
/* Перечень открытого — сам по себе                                   */
/* ================================================================== */

test('открыт ровно перечень, и ни один похожий путь в него не попадает', () => {
  // Открыто:
  for (const p of ['/healthz', '/alice', '/alice/деадбиф', '/pair', '/api/device/code', '/api/device/token']) {
    assert.equal(isOpenPath('GET', p), true, `${p} обязан быть открыт`);
  }

  // Закрыто — включая то, что похоже на открытое:
  const closed = [
    '/',
    '/healthzz',
    '/healthz/',
    '//healthz',
    '/healthz2',
    '/alicexyz',
    '/aliceee/x',
    '/Alice/секрет',
    '/pair/',
    '/pairing',
    '/pair/x',
    '/api/device',
    '/api/device/codes',
    '/api/device/code/x',
    '/api/state',
    '/api/stream',
    '/dash',
    // Процентное кодирование: декодировать здесь и не декодировать в роутере
    // означало бы открыть путь, который на деле уйдёт в SPA-fallback.
    '/%68ealthz',
    '/%2Fhealthz',
    '/api/%64evice/code',
  ];
  for (const p of closed) {
    assert.equal(isOpenPath('GET', p), false, `${p} обязан быть закрыт`);
  }
});

test('строка запроса и якорь не превращают закрытый путь в открытый', () => {
  assert.equal(pathOf('/healthz?x=1'), '/healthz');
  assert.equal(pathOf('/api/state?from=x#y'), '/api/state');
  assert.equal(isOpenPath('GET', pathOf('/api/state?a=/healthz')), false);
  assert.equal(isOpenPath('GET', pathOf('/healthz?next=/api/state')), true);
});

test('возврат после сопряжения ведёт только на свои страницы', () => {
  assert.equal(safeNext('/dash'), '/dash');
  assert.equal(safeNext('/dash/'), '/dash');
  assert.equal(safeNext('/api/state'), '/');
  // Открытый редирект: «//evil.example» выглядит путём, а читается как хост.
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('/\\evil.example'), '/');
});

/* ================================================================== */
/* Мимо двери не проходит НИЧЕГО                                       */
/* ================================================================== */

test('без сессии закрыто всё: статика, ассеты, API, SSE, SPA-fallback, 404', async (t) => {
  const h = await makeFullApp();
  t.after(h.close);

  // Сначала убедимся, что с сессией всё это действительно что-то отдаёт, —
  // иначе тест «всё закрыто» проходил бы и на сломанном сервере.
  const withCookie = (url: string) =>
    h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

  assert.match((await withCookie('/')).body, new RegExp(DASHBOARD_MARK));
  assert.match((await withCookie('/dash')).body, new RegExp(ADMIN_MARK));
  assert.match((await withCookie('/assets/app-a1b2c3.js')).body, new RegExp(DASHBOARD_MARK));
  assert.equal((await withCookie('/api/state')).statusCode, 200);

  const closedPaths: Array<[string, string]> = [
    ['GET', '/'],
    ['GET', '/index.html'],
    ['GET', '/assets/app-a1b2c3.js'],
    ['GET', '/dash'],
    ['GET', '/dash/'],
    ['GET', '/dash/index.html'],
    ['GET', '/dash/assets/admin-d4e5f6.js'],
    ['GET', '/dash/sw.js'],
    ['GET', '/dash/manifest.webmanifest'],
    ['GET', '/dash/icon-192.png'],
    ['GET', '/api/state'],
    ['GET', '/api/events'],
    ['GET', '/api/events?include_deleted=true'],
    ['GET', '/api/utterances'],
    ['GET', '/api/sleep/daily'],
    ['GET', '/api/stats/daily'],
    ['GET', '/api/change-sets'],
    ['GET', '/api/stream'],
    ['GET', '/api/alice/identities'],
    ['GET', '/api/alice/pending'],
    ['GET', '/api/devices'],
    ['GET', '/api/auth/session'],
    // SPA-fallback: раньше он отдавал дашборд на любой неизвестный путь
    ['GET', '/любой/путь'],
    ['GET', '/history'],
    ['GET', '/чего-нет'],
    // несуществующие пути
    ['GET', '/api/нет-такого'],
    ['GET', '/dash/нет-такого'],
    ['GET', '/нет-такого-файла.js'],
    // запись
    ['POST', '/api/events'],
    ['PATCH', '/api/events/1'],
    ['DELETE', '/api/events/1'],
    ['POST', '/api/utterances/1/reparse'],
    ['POST', '/api/change-sets/x/revert'],
    ['POST', '/api/devices/approve'],
    ['POST', '/api/devices/x/revoke'],
    ['POST', '/api/auth/logout'],
  ];

  for (const [method, url] of closedPaths) {
    const res = await h.app.inject({ method: method as 'GET', url });

    assert.ok(
      res.statusCode === 401 || res.statusCode === 303,
      `${method} ${url} → ${res.statusCode}: без сессии допустимы только 401 и редирект`,
    );
    if (res.statusCode === 303) {
      assert.match(String(res.headers.location), /^\/pair\?next=/, `${method} ${url}`);
    }

    // И, что важнее статуса: в ответе не должно быть ничего из закрытого.
    assert.equal(res.body.includes(DASHBOARD_MARK), false, `${method} ${url}: утёк дашборд`);
    assert.equal(res.body.includes(ADMIN_MARK), false, `${method} ${url}: утекла админка`);
    assert.equal(/"child"|"sleep"|"events"/.test(res.body), false, `${method} ${url}: утекли данные`);
  }
});

test('SSE без сессии не открывается даже как поток', async (t) => {
  const h = await makeFullApp();
  t.after(h.close);

  const res = await h.app.inject({
    method: 'GET',
    url: '/api/stream',
    headers: { accept: 'text/event-stream' },
    payloadAsStream: true,
  });

  assert.equal(res.statusCode, 401, 'EventSource шлёт accept: text/event-stream — это не навигация');
  assert.equal(/text\/event-stream/.test(String(res.headers['content-type'])), false);
});

test('битая, чужая и пустая кука не открывают ничего', async (t) => {
  const h = await makeFullApp();
  t.after(h.close);

  const badCookies = [
    '',
    'bt_session=',
    'bt_session=нет-такого-секрета',
    'bt_session=' + 'A'.repeat(43),
    'bt_session=%00%00',
    'bt_session=null; bt_session=undefined',
    // Похожая по имени кука — не та кука.
    'bt_session_x=' + h.cookie.split('=')[1],
    'xbt_session=' + h.cookie.split('=')[1],
  ];

  for (const cookie of badCookies) {
    const res = await h.app.inject({ method: 'GET', url: '/api/state', headers: { cookie } });
    assert.equal(res.statusCode, 401, `кука «${cookie}» не должна пускать`);
  }

  // Контроль: настоящая кука пускает. Иначе тест выше ничего не доказывает.
  const ok = await h.app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { cookie: h.cookie },
  });
  assert.equal(ok.statusCode, 200);
});

/* ================================================================== */
/* Открытое осталось открытым                                          */
/* ================================================================== */

test('/healthz открыт без сессии и отдаёт то же, что раньше', async (t) => {
  const h = await makeFullApp();
  t.after(h.close);

  const res = await h.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; db: boolean; worker: Record<string, unknown> };
  assert.equal(body.ok, true);
  assert.equal(body.db, true);
  assert.ok('alive' in body.worker);
});

test('вебхук Алисы открыт без сессии и работает как прежде', async (t) => {
  const h = await makeFullApp();
  t.after(h.close);

  // Никаких кук: Алиса их не умеет и не пришлёт.
  const res = await h.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('андрей заснул'),
  });
  assert.equal(res.statusCode, 200);
  assert.match((res.json() as { response: { text: string } }).response.text, /Записала/);

  // Неверный секрет по-прежнему получает 200 с нейтральным текстом, а НЕ
  // редирект на страницу сопряжения: дверь в дела Алисы не вмешивается.
  const wrong = await h.app.inject({
    method: 'POST',
    url: '/alice/00000000000000000000000000000000',
    payload: aliceBody('андрей заснул'),
  });
  assert.equal(wrong.statusCode, 200);
  assert.equal(/Записала/.test(wrong.body), false);

  // И GET-заглушка вебхука тоже осталась на месте.
  const bare = await h.app.inject({ method: 'POST', url: '/alice', payload: {} });
  assert.equal(bare.statusCode, 200);
});

test('страница сопряжения открыта, самодостаточна и не кешируется', async (t) => {
  const h = await makeFullApp();
  t.after(h.close);

  const res = await h.app.inject({ method: 'GET', url: '/pair' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.match(String(res.headers['cache-control']), /no-store/, 'застрявший код не сработает');

  // Ни одной внешней ссылки: если бы страница тянула бандл или шрифт,
  // пришлось бы открыть и их, и список открытого перестал бы быть перечнем.
  assert.equal(/<script[^>]+src=/i.test(res.body), false, 'внешних скриптов быть не должно');
  assert.equal(/<link[^>]+href=/i.test(res.body), false, 'внешних стилей быть не должно');
  assert.equal(/https?:\/\//i.test(res.body), false, 'внешних адресов быть не должно');

  assert.match(res.body, /api\/device\/code/, 'страница умеет заводить заявку');
  assert.match(res.body, /api\/device\/token/, 'и опрашивать сервер');
});

/* ================================================================== */
/* Форма отказа                                                        */
/* ================================================================== */

test('человеку — страница сопряжения, коду — честный 401', async (t) => {
  const h = await makeFullApp();
  t.after(h.close);

  // Переход по адресу в браузере.
  const navigation = await h.app.inject({
    method: 'GET',
    url: '/dash',
    headers: { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' },
  });
  assert.equal(navigation.statusCode, 303);
  assert.equal(navigation.headers.location, '/pair?next=%2Fdash');

  const tvNavigation = await h.app.inject({
    method: 'GET',
    url: '/',
    headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
  });
  assert.equal(tvNavigation.statusCode, 303);
  assert.equal(
    tvNavigation.headers.location,
    '/pair?next=%2F',
    'телевизор показывает код сопряжения, а не пустой экран',
  );

  // Запрос данных из кода.
  const xhr = await h.app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { accept: 'application/json', 'sec-fetch-mode': 'cors' },
  });
  assert.equal(xhr.statusCode, 401);
  const body = xhr.json() as { error: string; pair: string };
  assert.equal(body.error, 'unauthorized');
  assert.equal(body.pair, '/pair', 'клиенту сказано, куда идти');

  // POST-навигация не должна превращаться в повторный POST на /pair.
  const post = await h.app.inject({
    method: 'POST',
    url: '/api/events',
    headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    payload: { type: 'note' },
  });
  assert.equal(post.statusCode, 401, 'POST не навигация, даже если просит html');
});

/* ================================================================== */
/* Отзыв действует немедленно                                          */
/* ================================================================== */

test('отозванная сессия перестаёт работать немедленно', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  // Заводим второе устройство — его и отзовём.
  const victim = issueSession(h.db, { kind: 'phone', label: 'Потерянный телефон' });
  const cookie = `${SESSION_COOKIE}=${victim.token}`;

  const before = await h.anon({ method: 'GET', url: '/api/state', headers: { cookie } });
  assert.equal(before.statusCode, 200, 'до отзыва телефон работает');

  const revoke = await h.app.inject({
    method: 'POST',
    url: `/api/devices/${victim.session.id}/revoke`,
  });
  assert.equal(revoke.statusCode, 200);

  // Ни секунды отсрочки: следующий же запрос закрыт.
  for (const url of ['/api/state', '/api/events', '/api/stream', '/dash', '/']) {
    const res = await h.anon({ method: 'GET', url, headers: { cookie } });
    assert.ok(
      res.statusCode === 401 || res.statusCode === 303,
      `${url} после отзыва → ${res.statusCode}`,
    );
  }

  // И в списке устройств его больше нет.
  const list = await h.app.inject({ method: 'GET', url: '/api/devices' });
  const ids = (list.json() as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
  assert.equal(ids.includes(victim.session.id), false);
});

test('отзыв рвёт уже открытый поток SSE — на настоящем сокете', async (t) => {
  /*
   * Здесь намеренно поднимается настоящий сервер и открывается настоящее
   * соединение. Проверка через inject доказала бы только, что метод вызван;
   * доказать надо другое — что сокет отозванного устройства закрывается,
   * а не продолжает получать события ребёнка часами. Дверь его больше не
   * увидит: соединение уже установлено.
   */
  const cfg = testConfig();
  const db = testDb();
  const { app, sse } = createApp({ cfg, db, logger: false, serveStatic: false });

  const admin = issueSession(db, { kind: 'browser', label: 'Админ' });
  const victim = issueSession(db, { kind: 'tv', label: 'Телевизор' });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    sse.close();
    await app.close();
    db.close();
  });

  // 1. Телевизор открывает поток и получает первое событие.
  const stream = await fetch(`${base}/api/stream`, {
    headers: { cookie: `${SESSION_COOKIE}=${victim.token}`, accept: 'text/event-stream' },
  });
  assert.equal(stream.status, 200);
  assert.match(String(stream.headers.get('content-type')), /text\/event-stream/);

  const reader = stream.body?.getReader();
  assert.ok(reader, 'поток должен быть читаемым');

  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /retry:|event: state/);

  // 2. Пока поток открыт, админка отзывает телевизор.
  const revoke = await fetch(`${base}/api/devices/${victim.session.id}/revoke`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${admin.token}` },
  });
  assert.equal(revoke.status, 200);
  const revokeBody = (await revoke.json()) as { streamsClosed: number };
  assert.equal(revokeBody.streamsClosed, 1, 'сервер сообщает, что оборвал один поток');

  // 3. Поток обязан закончиться сам, без единого запроса со стороны клиента.
  const ended = await Promise.race([
    (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return 'ended';
      }
    })(),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 4000)),
  ]);
  assert.equal(ended, 'ended', 'отозванный телевизор обязан замолчать немедленно');

  // 4. И переподключиться он тоже не может.
  const again = await fetch(`${base}/api/stream`, {
    headers: { cookie: `${SESSION_COOKIE}=${victim.token}`, accept: 'text/event-stream' },
  });
  assert.equal(again.status, 401);
  await again.body?.cancel();

  // 5. А поток админки при этом не пострадал — отзыв точечный.
  const alive = await fetch(`${base}/api/stream`, {
    headers: { cookie: `${SESSION_COOKIE}=${admin.token}`, accept: 'text/event-stream' },
  });
  assert.equal(alive.status, 200);
  await alive.body?.cancel();
});

test('выход завершает свою сессию и гасит куку', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'POST', url: '/api/auth/logout' });
  assert.equal(res.statusCode, 200);

  const raw = res.headers['set-cookie'];
  const line = Array.isArray(raw) ? raw[0] : raw;
  assert.match(String(line), /bt_session=;/, 'кука гасится');
  assert.match(String(line), /Max-Age=0/);

  // Старый секрет больше не работает.
  const after = await h.anon({
    method: 'GET',
    url: '/api/state',
    headers: { cookie: h.cookie },
  });
  assert.equal(after.statusCode, 401);
});

/* ================================================================== */
/* Отдельные страховки                                                 */
/* ================================================================== */

test('дверь стоит и без собранной статики: голый API тоже закрыт', async (t) => {
  const h = await makeTestApp({ DASHBOARD_DIST: '/нет/такого', ADMIN_DIST: '/нет/такого' });
  t.after(() => h.close());

  for (const url of ['/', '/api/state', '/dash', '/что-угодно']) {
    const res = await h.anon({ method: 'GET', url });
    assert.ok(res.statusCode === 401 || res.statusCode === 303 || res.statusCode === 404, url);
    assert.equal(/"child"/.test(res.body), false, `${url}: данные утекли`);
  }
  assert.equal((await h.anon({ method: 'GET', url: '/healthz' })).statusCode, 200);
});

test('CORS не разрешает учётные данные: чужой сайт не прочитает дневник', async (t) => {
  const h = await makeFullApp();
  t.after(h.close);

  /*
   * Ловушка, в которую легко попасть именно после переезда на куки: кажется
   * логичным разрешить отправку сессии на «свои» origin. Но `credentials`
   * вместе с отражением Origin открывает чтение истории ребёнка любому сайту
   * в соседней вкладке, а нужен он ровно нигде: оба интерфейса ходят к API
   * с того же origin (в dev — через прокси Vite).
   */
  const preflight = await h.app.inject({
    method: 'OPTIONS',
    url: '/api/state',
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'GET',
    },
  });
  assert.equal(
    preflight.headers['access-control-allow-credentials'],
    undefined,
    'разрешив учётные данные, мы отдадим дневник любому сайту',
  );

  // И сама кука чужому origin ничего не даёт: запрос приходит без неё.
  const cross = await h.app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(cross.statusCode, 401);
});

test('ответы двери не кешируются: иначе 401 застрянет в прокси', async (t) => {
  const h = await makeFullApp();
  t.after(h.close);

  const denied = await h.app.inject({ method: 'GET', url: '/api/state' });
  assert.match(String(denied.headers['cache-control']), /no-store/);

  const redirect = await h.app.inject({
    method: 'GET',
    url: '/',
    headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
  });
  assert.match(String(redirect.headers['cache-control']), /no-store/);
});

test('сессия отмечается как виденная — иначе в списке не отличить живое от забытого', async (t) => {
  let clock = Date.parse('2026-09-15T12:00:00.000Z');
  const h = await makeTestApp({}, { now: () => clock });
  t.after(() => h.close());

  const readSeen = async (): Promise<string> => {
    const res = await h.app.inject({ method: 'GET', url: '/api/devices' });
    const rows = (res.json() as { sessions: Array<{ id: string; lastSeenAt: string }> }).sessions;
    return rows.find((s) => s.id === h.session.id)?.lastSeenAt ?? '';
  };

  const first = await readSeen();
  clock += 2 * 60_000;
  await h.app.inject({ method: 'GET', url: '/api/state' });
  const second = await readSeen();

  assert.notEqual(first, second, 'отметка «видели» обновилась');
  assert.ok(Date.parse(second) > Date.parse(first));
});

test('приложение с сессией работает ровно как прежде — дверь ничего не сломала', async (t) => {
  const h = await makeFullApp();
  t.after(h.close);
  authorize(h.app, h.db);

  const state = await h.app.inject({ method: 'GET', url: '/api/state' });
  assert.equal(state.statusCode, 200);
  assert.ok('child' in (state.json() as Record<string, unknown>));

  const spa = await h.app.inject({ method: 'GET', url: '/какой-то/маршрут' });
  assert.equal(spa.statusCode, 200);
  assert.match(spa.body, new RegExp(DASHBOARD_MARK), 'SPA-fallback на месте');

  const missingApi = await h.app.inject({ method: 'GET', url: '/api/нет-такого' });
  assert.equal(missingApi.statusCode, 404, 'честный 404 для /api/*');
  assert.match(String(missingApi.headers['content-type']), /application\/json/);

  const missingDash = await h.app.inject({ method: 'GET', url: '/dash/нет-такого' });
  assert.equal(missingDash.statusCode, 404, 'под /dash fallback не нужен');
});
