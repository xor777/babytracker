/**
 * §11: авторизация устройств по коду (device flow, RFC 8628).
 *
 * Проверяется поведение, а не устройство кода: что можно и чего нельзя
 * добиться, имея на руках то или это. Краевые случаи здесь и есть суть —
 * счастливый путь работает у любой реализации, а безопасность держится
 * ровно на том, что перечислено ниже.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, type TestApp } from './helpers.ts';
import {
  SESSION_COOKIE,
  USER_CODE_ALPHABET,
  formatUserCode,
  newUserCode,
  normalizeUserCode,
  sha256,
} from '../src/device-auth.ts';
import { all } from '../src/db.ts';

/* ------------------------------------------------------------------ */
/* Обвязка                                                             */
/* ------------------------------------------------------------------ */

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
}

function makeClock(start = Date.parse('2026-09-15T12:00:00.000Z')): Clock {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
    set: (ms) => {
      value = ms;
    },
  };
}

interface StartedCode {
  deviceCode: string;
  userCode: string;
  display: string;
  expiresIn: number;
  interval: number;
}

/**
 * User-Agent под тип устройства.
 *
 * Нужен потому, что тип решает СЕРВЕР по заголовку, а не клиент по полю в теле
 * (иначе любой браузер выписывал бы себе бессрочную сессию телевизора).
 * Значит и тест обязан представляться телевизором, если хочет им быть.
 */
const USER_AGENTS: Record<string, string> = {
  tv: 'Mozilla/5.0 (Linux; Android 11; BRAVIA 4K VH2) AppleWebKit/537.36 Chrome/120',
  phone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
  browser: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120',
};

/** Завести заявку так, как это делает страница сопряжения. */
async function startCode(h: TestApp, kind = 'tv'): Promise<StartedCode> {
  const res = await h.anon({
    method: 'POST',
    url: '/api/device/code',
    payload: { kind },
    headers: { 'user-agent': USER_AGENTS[kind] ?? USER_AGENTS.browser ?? '' },
  });
  assert.equal(res.statusCode, 200, `заявка не завелась: ${res.body}`);
  const body = res.json() as Record<string, string>;
  return {
    deviceCode: body.device_code as string,
    userCode: body.user_code as string,
    display: body.user_code_display as string,
    expiresIn: Number(body.expires_in),
    interval: Number(body.interval),
  };
}

/** Опрос устройством: всегда БЕЗ куки — у устройства её ещё нет. */
function poll(h: TestApp, deviceCode: string) {
  return h.anon({
    method: 'POST',
    url: '/api/device/token',
    payload: { device_code: deviceCode },
  });
}

/** Одобрение из админки — за дверью, поэтому через `app` (он ходит с сессией). */
function approveByCode(h: TestApp, userCode: string) {
  return h.app.inject({
    method: 'POST',
    url: '/api/devices/approve',
    payload: { user_code: userCode },
  });
}

function cookieOf(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers['set-cookie'];
  const line = Array.isArray(raw) ? raw[0] : raw;
  if (typeof line !== 'string') return null;
  return line;
}

/* ================================================================== */
/* Счастливый путь — чтобы было с чем сравнивать краевые              */
/* ================================================================== */

test('полный путь: код → одобрение → сессия, и по ней открывается API', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h, 'tv');
  assert.equal(code.userCode.length, 8, 'восемь значимых символов (RFC 8628 §6.1)');
  assert.equal(code.display, formatUserCode(code.userCode), 'на экран — с тире');
  assert.equal(code.interval, 5, 'умолчание интервала по RFC — 5 секунд');

  // Пока никто не одобрил — сессии нет.
  const pending = await poll(h, code.deviceCode);
  assert.equal(pending.statusCode, 400);
  assert.equal((pending.json() as { error: string }).error, 'authorization_pending');

  const approved = await approveByCode(h, code.display);
  assert.equal(approved.statusCode, 200, approved.body);

  clock.advance(6000); // выдержать интервал опроса
  const got = await poll(h, code.deviceCode);
  assert.equal(got.statusCode, 200, got.body);
  const body = got.json() as { ok: boolean; redirect: string };
  assert.equal(body.ok, true);
  assert.equal(body.redirect, '/', 'телевизор возвращается на дашборд');

  const cookie = cookieOf(got);
  assert.ok(cookie, 'сессия приходит кукой');

  // И этой кукой API действительно открывается.
  const token = /bt_session=([^;]+)/.exec(cookie)?.[1] ?? '';
  const state = await h.anon({
    method: 'GET',
    url: '/api/state',
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(state.statusCode, 200, 'с выданной сессией API работает');
});

/* ================================================================== */
/* Неодобренный код                                                    */
/* ================================================================== */

test('неодобренный код не даёт сессии, сколько его ни опрашивай', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);

  for (let i = 0; i < 5; i++) {
    clock.advance(6000);
    const res = await poll(h, code.deviceCode);
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, 'authorization_pending');
    assert.equal(cookieOf(res), null, 'куки быть не должно ни на одной попытке');
  }

  // И в базе не появилось ни одной сессии сверх тестовой.
  const rows = all<{ n: number }>(h.db, 'SELECT COUNT(*) AS n FROM device_sessions');
  assert.equal(Number(rows[0]?.n), 1, 'только сессия самого теста');
});

/* ================================================================== */
/* Два кода, а не один                                                 */
/* ================================================================== */

test('опрос по user_code не работает: короткий код не является ключом', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);
  const approved = await approveByCode(h, code.userCode);
  assert.equal(approved.statusCode, 200);

  // Заявка одобрена — но предъявляем короткий код вместо длинного.
  for (const attempt of [code.userCode, code.display, code.userCode.toLowerCase()]) {
    clock.advance(6000);
    const res = await poll(h, attempt);
    assert.notEqual(res.statusCode, 200, `короткий код не должен обмениваться: ${attempt}`);
    assert.equal(cookieOf(res), null);
  }

  // А длинный — работает, то есть заявка и правда была одобрена.
  clock.advance(6000);
  assert.equal((await poll(h, code.deviceCode)).statusCode, 200);
});

test('чужой user_code не даёт чужую сессию', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  // Две заявки одновременно: телевизор в детской и чей-то телефон.
  const tv = await startCode(h, 'tv');
  const phone = await startCode(h, 'phone');
  assert.notEqual(tv.userCode, phone.userCode);

  // Одобряем ТЕЛЕФОН.
  assert.equal((await approveByCode(h, phone.display)).statusCode, 200);

  // Телевизор, даже зная короткий код телефона, сессии не получает:
  // его собственная заявка не одобрена, а чужую он предъявить не может —
  // длинный код телефона ему неизвестен.
  clock.advance(6000);
  const tvPoll = await poll(h, tv.deviceCode);
  assert.equal(tvPoll.statusCode, 400);
  assert.equal((tvPoll.json() as { error: string }).error, 'authorization_pending');

  clock.advance(6000);
  const spoof = await poll(h, phone.userCode);
  assert.notEqual(spoof.statusCode, 200, 'знание короткого кода не даёт сессию');

  // А законный владелец длинного кода получает ровно свою сессию.
  clock.advance(6000);
  const ok = await poll(h, phone.deviceCode);
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as { redirect: string }).redirect, '/dash', 'сессия телефона');
});

/* ================================================================== */
/* Истечение                                                           */
/* ================================================================== */

test('истёкший код не обменивается на сессию и не одобряется', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({ PAIR_CODE_TTL_SEC: '120' }, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);
  assert.equal(code.expiresIn, 120);

  clock.advance(121_000);

  const res = await poll(h, code.deviceCode);
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { error: string }).error, 'expired_token');
  assert.equal(cookieOf(res), null);

  // Одобрить задним числом тоже нельзя: заявки для одобряющего больше нет.
  const approve = await approveByCode(h, code.display);
  assert.equal(approve.statusCode, 404, 'истёкший код не ждёт одобрения');

  // И в списке ожидающих его нет.
  const list = await h.app.inject({ method: 'GET', url: '/api/devices' });
  assert.equal((list.json() as { pending: unknown[] }).pending.length, 0);
});

test('одобренный, но не забранный код тоже истекает', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({ PAIR_CODE_TTL_SEC: '120' }, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);
  assert.equal((await approveByCode(h, code.display)).statusCode, 200);

  // Устройство выключили и включили через час — одобрение протухло вместе
  // с кодом. Иначе одобрение, забытое в базе, работало бы вечно.
  clock.advance(3600_000);
  const res = await poll(h, code.deviceCode);
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { error: string }).error, 'expired_token');
  assert.equal(cookieOf(res), null);
});

/* ================================================================== */
/* Одноразовость                                                       */
/* ================================================================== */

test('код одноразовый: повторный обмен не выдаёт вторую сессию', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);
  assert.equal((await approveByCode(h, code.display)).statusCode, 200);

  clock.advance(6000);
  const first = await poll(h, code.deviceCode);
  assert.equal(first.statusCode, 200);
  assert.ok(cookieOf(first));

  // Тот же длинный код, предъявленный второй раз, второй сессии не даёт.
  for (let i = 0; i < 3; i++) {
    clock.advance(6000);
    const again = await poll(h, code.deviceCode);
    assert.equal(again.statusCode, 400, 'повторный обмен обязан быть отказом');
    assert.equal((again.json() as { error: string }).error, 'expired_token');
    assert.equal(cookieOf(again), null);
  }

  const n = all<{ n: number }>(h.db, 'SELECT COUNT(*) AS n FROM device_sessions');
  assert.equal(Number(n[0]?.n), 2, 'тестовая сессия плюс ровно одна выданная');
});

test('повторное одобрение уже забранной заявки ничего не воскрешает', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);
  assert.equal((await approveByCode(h, code.display)).statusCode, 200);
  clock.advance(6000);
  assert.equal((await poll(h, code.deviceCode)).statusCode, 200);

  // Код уже обменян: по нему больше ничего не ждёт одобрения.
  assert.equal((await approveByCode(h, code.display)).statusCode, 404);

  clock.advance(6000);
  assert.equal((await poll(h, code.deviceCode)).statusCode, 400);
});

/* ================================================================== */
/* Отказ                                                               */
/* ================================================================== */

test('отклонённая заявка отвечает access_denied и не оживает', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);
  const list = await h.app.inject({ method: 'GET', url: '/api/devices' });
  const pending = (list.json() as { pending: Array<{ id: number }> }).pending;
  assert.equal(pending.length, 1);

  const deny = await h.app.inject({
    method: 'POST',
    url: `/api/devices/pending/${pending[0]?.id}/deny`,
  });
  assert.equal(deny.statusCode, 200);

  clock.advance(6000);
  const res = await poll(h, code.deviceCode);
  assert.equal((res.json() as { error: string }).error, 'access_denied');

  // И одобрить отклонённое уже нельзя.
  assert.equal((await approveByCode(h, code.display)).statusCode, 404);
});

/* ================================================================== */
/* Ограничение частоты опроса (RFC 8628 §3.5)                          */
/* ================================================================== */

test('слишком частый опрос получает slow_down, и интервал растёт накопительно', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);

  // Первый опрос — обычный.
  const first = await poll(h, code.deviceCode);
  assert.equal((first.json() as { error: string }).error, 'authorization_pending');

  // Сразу же второй, не выждав интервал.
  const second = await poll(h, code.deviceCode);
  const secondBody = second.json() as { error: string; interval: number };
  assert.equal(secondBody.error, 'slow_down');
  assert.equal(secondBody.interval, 10, 'RFC §3.5: +5 секунд');

  // Третий — тоже не выждав: прибавка накапливается, а не сбрасывается.
  const third = await poll(h, code.deviceCode);
  const thirdBody = third.json() as { error: string; interval: number };
  assert.equal(thirdBody.error, 'slow_down');
  assert.equal(thirdBody.interval, 15, 'прибавка постоянная, а не разовая');

  // Выждали новый интервал — опрос снова обычный.
  clock.advance(16_000);
  const patient = await poll(h, code.deviceCode);
  assert.equal((patient.json() as { error: string }).error, 'authorization_pending');
});

test('поток опросов упирается в грубый потолок ограничителя', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);

  let limited = false;
  for (let i = 0; i < 200; i++) {
    const res = await poll(h, code.deviceCode);
    if (res.statusCode === 429) {
      limited = true;
      assert.ok(res.headers['retry-after'], 'отказ должен говорить, когда возвращаться');
      break;
    }
  }
  assert.ok(limited, 'опрос без конца обязан упереться в ограничитель');
});

test('заведение кодов тоже ограничено: экран одобрения не завалить мусором', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  let limited = false;
  for (let i = 0; i < 40; i++) {
    const res = await h.anon({ method: 'POST', url: '/api/device/code', payload: { kind: 'tv' } });
    if (res.statusCode === 429) {
      limited = true;
      break;
    }
  }
  assert.ok(limited, 'бесконечная выдача кодов обязана упереться в ограничитель');
});

/* ================================================================== */
/* Подбор короткого кода (RFC 8628 §5.1)                               */
/* ================================================================== */

test('подбор user_code упирается в ограничитель', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  // Заявка есть, но подбирающий её кода не знает.
  const victim = await startCode(h, 'tv');

  let attempts = 0;
  let blocked = false;
  for (let i = 0; i < 50; i++) {
    let guess = newUserCode();
    // Случайно угадать 20^8 нереально, но если вдруг — портим догадку.
    if (guess === victim.userCode) guess = newUserCode();

    const res = await approveByCode(h, guess);
    if (res.statusCode === 429) {
      blocked = true;
      assert.ok(res.headers['retry-after']);
      break;
    }
    assert.equal(res.statusCode, 404, 'неверный код — просто «не найдено»');
    attempts += 1;
  }

  assert.ok(blocked, 'перебор обязан упереться в ограничитель');
  assert.equal(
    attempts,
    5,
    'ориентир RFC §5.1: при 20^8 хватает пяти попыток за окно, чтобы перебор был бессмысленным',
  );

  // И пока окно закрыто, ВЕРНЫЙ код тоже не проходит — иначе ограничитель
  // обходился бы одной удачной догадкой между неудачными.
  const real = await approveByCode(h, victim.display);
  assert.equal(real.statusCode, 429);
});

test('верная догадка возвращает ровно одну попытку, а не сбрасывает окно', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  /*
   * Тонкость, из-за которой жёсткий предел легко превращается в мягкий.
   *
   * Человеку, который ошибся при вводе и потом набрал верно, нельзя отказывать
   * из-за прошлой опечатки — значит верная попытка не должна идти в счёт.
   * Но если возвращать ВСЁ окно, получается схема «четыре неверных, одно
   * верное своё (завести заявку может кто угодно, эндпоинт открыт), снова
   * четыре» — и пяти попыток за окно превращаются в бесконечность.
   *
   * Поэтому возвращается ровно одна попытка.
   */
  const first = await startCode(h);
  for (let i = 0; i < 4; i++) {
    assert.equal((await approveByCode(h, newUserCode())).statusCode, 404);
  }
  assert.equal(
    (await approveByCode(h, first.display)).statusCode,
    200,
    'опечатка не должна мешать набрать верный код',
  );

  /*
   * Счёт: четыре неверных израсходовали четыре попытки, верная забрала пятую
   * и вернула её же обратно. В запасе осталась ровно одна — а не всё окно,
   * как было бы при полном сбросе.
   */
  const second = await startCode(h);
  assert.equal((await approveByCode(h, newUserCode())).statusCode, 404, 'последняя попытка');
  assert.equal(
    (await approveByCode(h, second.display)).statusCode,
    429,
    'окно исчерпано — верный код тоже ждёт, иначе предел обходился бы по кругу',
  );
});

/* ================================================================== */
/* Одобрить можно ТОЛЬКО набрав код                                    */
/* ================================================================== */

/**
 * Дыра, которую здесь закрыли, была настоящей и стоила всей аккуратности
 * с ограничителем выше.
 *
 * Рядом с `/api/devices/approve` (пять попыток на 15 минут, ключ — сессия)
 * жил `POST /api/devices/pending/:id/approve`, который одобрял ту же заявку
 * по `id`. А `id` — это `INTEGER PRIMARY KEY AUTOINCREMENT`, то есть
 * маленькое последовательное число, и никакого счёта попыток на том
 * эндпоинте не было вовсе.
 *
 * Иными словами: перебирать 20^8 было незачем — хватало перебрать 1, 2, 3.
 */
test('одобрения по id заявки не существует: перебор маленьких чисел ничего не впускает', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const victim = await startCode(h, 'tv');

  // Полный перебор всех правдоподобных id — с запасом, ибо счётчик начинается
  // с единицы и заявка в базе на этот момент одна.
  for (let id = 1; id <= 50; id++) {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/devices/pending/${id}/approve`,
      payload: {},
    });
    assert.ok(
      res.statusCode === 404 || res.statusCode === 405,
      `id=${id}: такого эндпоинта быть не должно, а он ответил ${res.statusCode}`,
    );
  }

  // И устройство по-прежнему НЕ впущено: ни одна из полусотни попыток
  // не превратилась в сессию.
  const still = await poll(h, victim.deviceCode);
  assert.equal(still.statusCode, 400);
  assert.equal(
    (still.json() as { error: string }).error,
    'authorization_pending',
    'заявка как ждала одобрения, так и ждёт',
  );

  // Единственная дорога осталась одна — и она работает.
  assert.equal((await approveByCode(h, victim.display)).statusCode, 200);
});

/**
 * Главный тест всей затеи, сформулированный как страх заказчика:
 * «чтобы жена случайно не одобрила никому».
 *
 * Утверждается не «эндпоинт отвечает 200», а сильное свойство:
 * ИМЕЯ ПОЛНЫЙ ДОСТУП К АДМИНКЕ, но НЕ ЗНАЯ кода с экрана устройства,
 * впустить это устройство нельзя ничем.
 *
 * Поэтому перебираются все мыслимые дороги, а не одна: снятая ручка
 * одобрения по id, отказ, отзыв, одобрение чужим кодом и кодом соседней
 * заявки. Пока ни одна из них не выдаёт сессию, случайное нажатие остаётся
 * невозможным — нажимать просто не на что.
 */
test('НЕ ЗНАЯ кода, впустить устройство нельзя ничем — даже из полностью открытой админки', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  // Заявка, кода которой «мы не видели»: её экран в другой комнате.
  const victim = await startCode(h, 'tv');
  // И вторая, своя — её код мы знаем. Ровно тот случай, которого боится
  // заказчик: чужая заявка приходит в ту же минуту, когда одобряешь свою.
  const mine = await startCode(h, 'phone');

  const id = (
    await h.app.inject({ method: 'GET', url: '/api/devices' })
  ).json() as { pending: Array<{ id: number }> };
  const ids = id.pending.map((p) => p.id);
  assert.equal(ids.length, 2);

  // 1. Снятая ручка «одобрить заявку номер N» — по каждому реальному id.
  for (const rowId of ids) {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/devices/pending/${rowId}/approve`,
      payload: {},
    });
    assert.ok(res.statusCode === 404 || res.statusCode === 405, `id=${rowId}: ${res.statusCode}`);
  }

  // 2. Одобрение кодом СОСЕДНЕЙ заявки не одобряет чужую: код относится
  //    ровно к одному устройству.
  assert.equal((await approveByCode(h, mine.display)).statusCode, 200);

  // 3. Чужая заявка по-прежнему ждёт — хотя рядом только что одобрили другую.
  clock.advance(6000);
  const victimPoll = await poll(h, victim.deviceCode);
  assert.equal(victimPoll.statusCode, 400);
  assert.equal(
    (victimPoll.json() as { error: string }).error,
    'authorization_pending',
    'одобрение своего устройства не должно задевать чужую заявку',
  );

  // 4. И сессию получило ровно то устройство, чей код набрали.
  clock.advance(6000);
  assert.equal((await poll(h, mine.deviceCode)).statusCode, 200);
});

test('код ждущей заявки нельзя добыть из API: его неоткуда списать, не глядя на экран', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  /*
   * Проверка ровно того, ради чего код убран из списка.
   *
   * Набор кода защищает лишь пока код НЕЛЬЗЯ ПОЛУЧИТЬ ИНАЧЕ, чем посмотрев
   * на экран устройства. Утечка кода в любой ответ, доступный вошедшему,
   * превращает «наберите код» обратно в кнопку «Одобрить»: списал из ответа,
   * вставил, впустил — не видя ни устройства, ни его экрана.
   *
   * Поэтому сканируются все ответы, которые вошедший может получить, —
   * целиком, как текст, в обоих написаниях кода.
   */
  const victim = await startCode(h, 'tv');
  const mine = await startCode(h, 'phone');

  const responses = [
    await h.app.inject({ method: 'GET', url: '/api/devices' }),
    await h.app.inject({ method: 'GET', url: '/api/auth/session' }),
    // Ответ на УСПЕШНОЕ одобрение своей заявки — он тоже описывает заявку.
    await approveByCode(h, mine.display),
  ];

  for (const res of responses) {
    assert.equal(
      res.body.includes(victim.userCode),
      false,
      `код чужой заявки утёк в ответ ${res.statusCode}: ${res.body}`,
    );
    assert.equal(res.body.includes(victim.display), false, 'и в написании с тире тоже');
  }
});

test('отклонить по id по-прежнему можно: ошибочный отказ безвреден, в отличие от одобрения', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const code = await startCode(h, 'tv');
  const list = await h.app.inject({ method: 'GET', url: '/api/devices' });
  const id = (list.json() as { pending: Array<{ id: number }> }).pending[0]?.id;
  assert.ok(typeof id === 'number');

  assert.equal(
    (await h.app.inject({ method: 'POST', url: `/api/devices/pending/${id}/deny`, payload: {} }))
      .statusCode,
    200,
    'отказ остаётся в одно нажатие — устройство просто попросит заново',
  );

  const after = await poll(h, code.deviceCode);
  assert.equal((after.json() as { error: string }).error, 'access_denied');
});

test('недобранный код — опечатка, а не попытка: окно за неё не тратится', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const code = await startCode(h, 'tv');

  /*
   * Десять обрывков подряд — вдвое больше, чем всё окно подбора. Если бы они
   * тратили попытки, верный код ниже упёрся бы в 429.
   *
   * Подбору эта поблажка не даёт ничего: код неверной длины не совпадает ни
   * с одной заявкой в принципе, так что перебирающему такие попытки не нужны,
   * а все восьмисимвольные по-прежнему считаются до единой (тест выше).
   */
  for (let i = 0; i < 10; i++) {
    const res = await approveByCode(h, 'BCD');
    assert.equal(res.statusCode, 400, 'слишком короткий код — не «не найдено», а «проверьте ввод»');
    assert.equal((res.json() as { error: string }).error, 'bad_code');
  }

  assert.equal(
    (await approveByCode(h, code.display)).statusCode,
    200,
    'опечатки не должны съедать право набрать верный код',
  );
});

test('«не найден» и «истёк» отвечают одинаково — иначе подбор получает подсказку', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  // Заявка, которая протухнет: такой код БЫЛ.
  const expired = await startCode(h, 'tv');
  clock.advance(11 * 60_000);

  const onExpired = await approveByCode(h, expired.display);
  // Код, которого не было никогда.
  const onUnknown = await approveByCode(h, newUserCode());

  assert.equal(onExpired.statusCode, 404);
  assert.equal(onUnknown.statusCode, 404);
  assert.deepEqual(
    onExpired.json(),
    onUnknown.json(),
    'ответы обязаны совпадать дословно: «истёк» означало бы «такой код был»',
  );
});

/* ================================================================== */
/* Сам код: алфавит и нормализация (RFC 8628 §6.1)                     */
/* ================================================================== */

test('алфавит короткого кода не содержит взаимно похожих символов', async () => {
  assert.equal(USER_CODE_ALPHABET.length, 20, 'base-20 из RFC §6.1');

  /*
   * Требование «без похожих символов (0/O, 1/I/l)» выполнено не вычёркиванием
   * половины пар, а тем, что ни одной пары в наборе не осталось целиком.
   *
   * Цифр нет вовсе, гласных нет тоже — вместе с гласными ушли O и I.
   * Значит и 0/O, и 1/I спутать не с чем: второго участника пары в наборе
   * просто не существует. L в наборе есть, и это безопасно ровно по той же
   * причине: код показывается заглавными, а ни 1, ни I рядом с ним не
   * появятся. Набор проверяем попарно, а не списком «плохих букв», —
   * похожесть это свойство пары, а не символа.
   */
  const CONFUSABLE_PAIRS = [
    ['0', 'O'],
    ['1', 'I'],
    ['1', 'L'],
    ['I', 'L'],
    ['5', 'S'],
    ['8', 'B'],
    ['2', 'Z'],
    ['6', 'G'],
  ];
  for (const [a, b] of CONFUSABLE_PAIRS) {
    const both = USER_CODE_ALPHABET.includes(a as string) && USER_CODE_ALPHABET.includes(b as string);
    assert.equal(both, false, `пара «${a}»/«${b}» не должна быть в наборе целиком`);
  }

  for (const vowel of 'AEIOUY') {
    assert.equal(USER_CODE_ALPHABET.includes(vowel), false, `гласная «${vowel}» даёт слова`);
  }
  assert.equal(/[0-9]/.test(USER_CODE_ALPHABET), false, 'цифр в наборе нет');

  // И сгенерированные коды тоже: проверка не по конструкции, а по факту.
  for (let i = 0; i < 500; i++) {
    const code = newUserCode();
    assert.equal(code.length, 8);
    for (const ch of code) {
      assert.ok(USER_CODE_ALPHABET.includes(ch), `символ «${ch}» вне алфавита`);
    }
  }
});

test('код распределён равномерно — не вырожден на нескольких символах', () => {
  // Дешёвая проверка на грубую ошибку в генераторе (например, на сдвиг
  // распределения из-за остатка от деления): за 4000 символов должны
  // встретиться все двадцать.
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) for (const ch of newUserCode()) seen.add(ch);
  assert.equal(seen.size, USER_CODE_ALPHABET.length, 'использован весь алфавит');
});

test('нормализация ввода: регистр, тире, лишние символы (RFC §6.1)', () => {
  assert.equal(normalizeUserCode('wdjb-mjht'), 'WDJBMJHT', 'регистр и тире');
  assert.equal(normalizeUserCode('WDJB MJHT'), 'WDJBMJHT', 'пробел не должен ломать верный код');
  assert.equal(normalizeUserCode(' WDJB—MJHT '), 'WDJBMJHT', 'длинное тире и пробелы по краям');
  assert.equal(normalizeUserCode('WDJB_MJHT!'), 'WDJBMJHT', 'мусор отбрасывается');
  // Символы вне алфавита просто исчезают, и код становится коротким —
  // то есть заведомо не совпадёт, а не совпадёт с чужим.
  assert.equal(normalizeUserCode('0O1I'), '', 'ни 0/O, ни 1/I в алфавите нет');
  assert.equal(normalizeUserCode('WDJB0MJHT'), 'WDJBMJHT', 'цифра внутри кода не ломает его');
});

test('код принимается и с тире, и без, и в любом регистре', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  for (const shape of [
    (c: string) => c,
    (c: string) => formatUserCode(c),
    (c: string) => c.toLowerCase(),
    (c: string) => `  ${formatUserCode(c).toLowerCase()}  `,
  ]) {
    const code = await startCode(h);
    const res = await approveByCode(h, shape(code.userCode));
    assert.equal(res.statusCode, 200, `форма «${shape(code.userCode)}» должна приниматься`);
  }
});

/* ================================================================== */
/* Хранение                                                            */
/* ================================================================== */

test('в базе не лежит ни один секрет открытым текстом', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const code = await startCode(h);
  assert.equal((await approveByCode(h, code.display)).statusCode, 200);

  const rows = all<{ device_code_hash: string; user_code: string }>(
    h.db,
    'SELECT device_code_hash, user_code FROM device_codes',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.device_code_hash, sha256(code.deviceCode), 'длинный код — только хешем');
  assert.notEqual(rows[0]?.device_code_hash, code.deviceCode);
  // Короткий код лежит как есть, и это осознанно: его показывают одобряющему,
  // чтобы он сверил код с экраном телевизора (RFC §3.3.1).
  assert.equal(rows[0]?.user_code, code.userCode);
});

test('секрет сессии в базе тоже только хешем', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const token = h.cookie.split('=')[1] ?? '';
  const rows = all<{ token_hash: string }>(h.db, 'SELECT token_hash FROM device_sessions');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.token_hash, sha256(token));
  assert.notEqual(rows[0]?.token_hash, token);

  // Вся таблица целиком не содержит секрета ни в одном поле.
  const dump = JSON.stringify(all(h.db, 'SELECT * FROM device_sessions'));
  assert.equal(dump.includes(token), false, 'секрет сессии не должен попадать в базу');
});

test('кука сессии: HttpOnly, Secure, SameSite=Lax', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);
  assert.equal((await approveByCode(h, code.display)).statusCode, 200);
  clock.advance(6000);
  const res = await poll(h, code.deviceCode);

  const cookie = cookieOf(res) ?? '';
  /*
   * Префикс `__Host-` — обещание браузеру и требование к нему: такую куку
   * нельзя поставить ни с соседнего поддомена, ни с другим Path, ни без
   * Secure. Без него сосед по домену мог бы подбросить `bt_session=…;
   * Path=/dash`, и браузер отправил бы ЕЁ вперёд настоящей.
   */
  assert.match(cookie, /^__Host-bt_session=/, 'префикс закрывает фиксацию сессии');
  assert.match(cookie, /HttpOnly/, 'скрипт на странице не должен читать сессию');
  assert.match(cookie, /SameSite=Lax/, 'чужой сайт не должен ходить от нашего имени');
  assert.match(cookie, /Secure/, 'по http секрет уходить не должен');
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=\d+/, 'без срока кука умрёт с окном браузера — телевизору нельзя');
});

test('AUTH_COOKIE_SECURE=false снимает Secure — и только он', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({ AUTH_COOKIE_SECURE: 'false' }, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);
  assert.equal((await approveByCode(h, code.display)).statusCode, 200);
  clock.advance(6000);
  const cookie = cookieOf(await poll(h, code.deviceCode)) ?? '';

  assert.equal(/Secure/.test(cookie), false, 'локальная разработка без TLS');
  // Префикс `__Host-` требует Secure — без него браузер такую куку выбросит,
  // и вход на localhost перестал бы работать вовсе. Поэтому имя обычное.
  assert.match(cookie, /^bt_session=/, 'без Secure префикс невозможен');
  assert.match(cookie, /HttpOnly/, 'остальные флаги остаются на месте');
  assert.match(cookie, /SameSite=Lax/);
});

/* ================================================================== */
/* Сроки жизни сессий                                                  */
/* ================================================================== */

test('сессия телевизора бессрочна, сессия телефона — со скользящим сроком', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({ SESSION_TTL_DAYS: '30' }, { now: clock.now });
  t.after(() => h.close());

  const tv = await startCode(h, 'tv');
  assert.equal((await approveByCode(h, tv.display)).statusCode, 200);
  clock.advance(6000);
  assert.equal((await poll(h, tv.deviceCode)).statusCode, 200);

  const phone = await startCode(h, 'phone');
  assert.equal((await approveByCode(h, phone.display)).statusCode, 200);
  clock.advance(6000);
  assert.equal((await poll(h, phone.deviceCode)).statusCode, 200);

  const rows = all<{ kind: string; expires_at: string | null }>(
    h.db,
    'SELECT kind, expires_at FROM device_sessions',
  );
  const tvRow = rows.find((r) => r.kind === 'tv');
  const phoneRow = rows.find((r) => r.kind === 'phone');

  assert.equal(
    tvRow?.expires_at,
    null,
    'телевизор висит на стене сутками: протухшая сессия — это код сопряжения вместо дневника',
  );
  assert.ok(phoneRow?.expires_at, 'телефон теряют и продают — у него срок есть');
  const left = Date.parse(phoneRow?.expires_at ?? '') - clock.now();
  assert.ok(Math.abs(left - 30 * 86_400_000) < 60_000, 'срок телефона — из SESSION_TTL_DAYS');
});

test('срок телефона скользит от последнего обращения, а не от входа', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({ SESSION_TTL_DAYS: '30' }, { now: clock.now });
  t.after(() => h.close());

  const phone = await startCode(h, 'phone');
  assert.equal((await approveByCode(h, phone.display)).statusCode, 200);
  clock.advance(6000);
  const got = await poll(h, phone.deviceCode);
  const token = /bt_session=([^;]+)/.exec(cookieOf(got) ?? '')?.[1] ?? '';

  const readExpiry = (): number => {
    const row = all<{ expires_at: string }>(
      h.db,
      "SELECT expires_at FROM device_sessions WHERE kind = 'phone'",
    )[0];
    return Date.parse(row?.expires_at ?? '');
  };
  const before = readExpiry();

  // Телефоном пользуются через двадцать дней — срок обязан отодвинуться.
  clock.advance(20 * 86_400_000);
  const res = await h.anon({
    method: 'GET',
    url: '/api/state',
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(res.statusCode, 200, 'через 20 дней из 30 сессия ещё жива');

  const after = readExpiry();
  assert.ok(after > before, 'срок скользит: активным телефоном пользуются, не переподключая');

  // А телефон, забытый на все 30 дней, перестаёт быть ключом.
  clock.advance(31 * 86_400_000);
  const dead = await h.anon({
    method: 'GET',
    url: '/api/state',
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(dead.statusCode, 401, 'забытая сессия истекает сама');
});

test('бессрочную сессию нельзя выписать себе самому, назвавшись телевизором', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  /*
   * У телевизора сессия БЕССРОЧНАЯ (§11.5) — это и делало поле `kind` в теле
   * запроса лазейкой: обычный браузер, отправив `{"kind":"tv"}`, выписывал
   * себе вечный ключ, а девяностодневная страховка становилась добровольной.
   * Теперь «телевизор» может сказать только заголовок User-Agent.
   */
  const res = await h.anon({
    method: 'POST',
    url: '/api/device/code',
    payload: { kind: 'tv' },
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120' },
  });
  assert.equal(res.statusCode, 200);
  const code = (res.json() as Record<string, string>).user_code_display as string;

  assert.equal((await approveByCode(h, code)).statusCode, 200);

  const list = await h.app.inject({ method: 'GET', url: '/api/devices' });
  const pending = (list.json() as { pending: Array<{ kind: string }> }).pending;
  assert.equal(pending.length, 0, 'заявку уже одобрили');

  const row = all<{ kind: string }>(h.db, "SELECT kind FROM device_codes WHERE status = 'approved'")[0];
  assert.equal(row?.kind, 'browser', 'подсказка «tv» от браузера не принимается');

  // И у выданной по ней сессии срок есть.
  const deviceCode = (res.json() as Record<string, string>).device_code as string;
  clock.advance(6000);
  assert.equal((await poll(h, deviceCode)).statusCode, 200);
  const session = all<{ kind: string; expires_at: string | null }>(
    h.db,
    "SELECT kind, expires_at FROM device_sessions WHERE kind = 'browser'",
  )[0];
  assert.ok(session?.expires_at, 'сессия браузера обязана иметь срок');
});

test('телевизор по заголовку получает свой тип и бессрочную сессию', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const res = await h.anon({
    method: 'POST',
    url: '/api/device/code',
    payload: { kind: 'phone' },
    headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 11; BRAVIA 4K) Chrome/120' },
  });
  const body = res.json() as Record<string, string>;
  assert.equal((await approveByCode(h, body.user_code_display as string)).statusCode, 200);
  clock.advance(6000);
  assert.equal((await poll(h, body.device_code as string)).statusCode, 200);

  const session = all<{ kind: string; expires_at: string | null }>(
    h.db,
    "SELECT kind, expires_at FROM device_sessions WHERE kind = 'tv'",
  )[0];
  assert.equal(session?.expires_at, null, 'телевизор бессрочен, заголовок сильнее подсказки');
});

test('число ждущих заявок ограничено — экран одобрения не превратить в простыню', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  /*
   * Этот предел, в отличие от ограничителя частоты, нельзя обойти подделкой
   * адреса: он считает по самой таблице. Ограничитель же ключуется по
   * X-Forwarded-For, а он за доверенным прокси приходит от клиента.
   */
  let refused = 0;
  for (let i = 0; i < 40; i++) {
    const res = await h.anon({
      method: 'POST',
      url: '/api/device/code',
      payload: { kind: 'phone' },
      // Каждый раз новый «адрес» — ровно то, что сделал бы заваливающий.
      headers: { 'x-forwarded-for': `203.0.113.${i}` },
    });
    if (res.statusCode === 429) refused += 1;
  }

  assert.ok(refused > 0, 'бесконечная выдача заявок обязана упереться в предел');
  const pending = all<{ n: number }>(
    h.db,
    "SELECT COUNT(*) AS n FROM device_codes WHERE status = 'pending'",
  );
  assert.ok(Number(pending[0]?.n) <= 20, `ждущих заявок не больше предела: ${pending[0]?.n}`);
});

test('послушный клиент не наказывается: допуск к интервалу опроса', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);
  await poll(h, code.deviceCode);

  // Клиенту сказали «5 секунд», он пришёл на 4.9 — сеть и таймеры не обязаны
  // попадать в миллисекунду. Это выполнение договора, а не нарушение.
  clock.advance(4900);
  const res = await poll(h, code.deviceCode);
  assert.equal(
    (res.json() as { error: string }).error,
    'authorization_pending',
    'разброс в сотню миллисекунд не повод навсегда поднимать интервал',
  );

  // А вот приход сразу же — нарушение.
  const rude = await poll(h, code.deviceCode);
  assert.equal((rude.json() as { error: string }).error, 'slow_down');
});

test('мёртвый код отвечает «истёк», а не «помедленнее»', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({ PAIR_CODE_TTL_SEC: '120' }, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h);
  await poll(h, code.deviceCode);
  clock.advance(121_000);

  // Опрос сразу после предыдущего: раньше это давало slow_down, и клиент
  // послушно ждал у заведомо закрытой двери вместо того, чтобы взять новый код.
  const res = await poll(h, code.deviceCode);
  assert.equal((res.json() as { error: string }).error, 'expired_token');
});

/* ================================================================== */
/* Экран одобрения                                                     */
/* ================================================================== */

test('список ждущих показывает тип и время — но НЕ код: иначе одобрять можно не глядя', async (t) => {
  const clock = makeClock();
  const h = await makeTestApp({}, { now: clock.now });
  t.after(() => h.close());

  const code = await startCode(h, 'tv');
  const res = await h.app.inject({ method: 'GET', url: '/api/devices' });
  assert.equal(res.statusCode, 200);

  const body = res.json() as {
    pending: Array<Record<string, unknown>>;
    sessions: Array<Record<string, unknown>>;
  };
  assert.equal(body.pending.length, 1);
  const item = body.pending[0] as Record<string, unknown>;

  // Заявка видна: человек, стоящий перед телевизором, должен понимать, что
  // она дошла. Этого достаточно — одобряют не отсюда.
  assert.equal(item.kind, 'tv');
  assert.ok(typeof item.requestedAt === 'string', 'время запроса');
  assert.ok(typeof item.secondsLeft === 'number');

  /*
   * ГЛАВНОЕ. Кода нет ни под каким именем и ни в каком написании.
   *
   * Одобрение требует набрать код с экрана устройства, и весь смысл этого
   * требования в том, что одобряющий обязан был этот экран ВИДЕТЬ. Код,
   * отданный в списке, разрушает свойство целиком: его списывают отсюда и
   * одобряют чужое устройство вслепую. Проверяем и поле, и подстроку —
   * с тире и без, потому что утечь оно может в любом виде.
   */
  const pendingDump = JSON.stringify(body.pending);
  assert.equal(item.userCode, undefined, 'поля userCode в ответе нет');
  assert.equal(pendingDump.includes(code.display), false, 'кода нет и подстрокой (XXXX-XXXX)');
  assert.equal(pendingDump.includes(code.userCode), false, 'кода нет и без тире');

  // Длинного секрета в ответе нет ни под каким именем.
  assert.equal(JSON.stringify(body).includes(code.deviceCode), false);

  // Список устройств не отдаёт ни хешей, ни user-agent — это не нужно
  // тому, кто «знает всех по именам», а утечь может.
  const dump = JSON.stringify(body.sessions);
  assert.equal(dump.includes('token_hash'), false);
  assert.equal(dump.includes('user_agent'), false);
});

test('устройство само себя в списке узнаёт — иначе отзовёшь не тот телефон', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'GET', url: '/api/devices' });
  const sessions = (res.json() as { sessions: Array<{ id: string; current: boolean }> }).sessions;
  const self = sessions.find((s) => s.id === h.session.id);
  assert.equal(self?.current, true, 'текущая сессия помечена');
});
