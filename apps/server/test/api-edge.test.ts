/**
 * REST §3 и §9.6 — невалидный ввод и границы.
 *
 * Дашборд и админка — не единственные клиенты: `/api/*` открыт всему, что умеет
 * слать HTTP. Проверяем, что мусорный запрос получает честный 400, а не
 * записывает мусор в дневник и не роняет сервер.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers.ts';
import { EVENTS_LIMIT_MAX, insertEvent } from '../src/events.ts';

type Json = Record<string, any>;

const body = (res: { body: string }): Json => JSON.parse(res.body) as Json;

/* ------------------------------------------------------------------ */
/* Границы limit и days                                                */
/* ------------------------------------------------------------------ */

test('limit: 1 и 1000 принимаются, 0, отрицательный и 1001 — нет', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  for (const limit of ['1', String(EVENTS_LIMIT_MAX)]) {
    const res = await app.app.inject({ method: 'GET', url: `/api/events?limit=${limit}` });
    assert.equal(res.statusCode, 200, `limit=${limit} должен приниматься`);
  }

  for (const limit of ['0', '-5', String(EVENTS_LIMIT_MAX + 1), 'abc', '1.5', '', '1e3000']) {
    const res = await app.app.inject({ method: 'GET', url: `/api/events?limit=${limit}` });
    assert.equal(res.statusCode, 400, `limit=${limit} должен отклоняться`);
    assert.equal(body(res).error, 'bad_request');
  }
});

test('limit действительно ограничивает выдачу, а не только проходит валидацию', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);
  for (let i = 0; i < 5; i++) {
    insertEvent(app.db, {
      type: 'note',
      source: 'manual',
      started_at: `2026-09-15T10:0${i}:00.000Z`,
    });
  }

  const res = await app.app.inject({ method: 'GET', url: '/api/events?limit=2' });
  assert.equal(body(res).events.length, 2);
  assert.equal(
    body(res).events[0].started_at,
    '2026-09-15T10:04:00.000Z',
    'отдаём самые свежие, а не первые попавшиеся',
  );
});

test('days: 1 и 90 принимаются, 0 и 91 — нет, и суток отдаётся ровно столько', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  for (const [url, field] of [
    ['/api/sleep/daily', 'days'],
    ['/api/stats/daily', 'days'],
  ] as Array<[string, string]>) {
    assert.equal((await app.app.inject({ method: 'GET', url: `${url}?days=0` })).statusCode, 400);
    assert.equal((await app.app.inject({ method: 'GET', url: `${url}?days=91` })).statusCode, 400);
    assert.equal((await app.app.inject({ method: 'GET', url: `${url}?days=-1` })).statusCode, 400);
    assert.equal((await app.app.inject({ method: 'GET', url: `${url}?days=день` })).statusCode, 400);

    const one = await app.app.inject({ method: 'GET', url: `${url}?days=1` });
    assert.equal(body(one)[field].length, 1);
    const max = await app.app.inject({ method: 'GET', url: `${url}?days=90` });
    assert.equal(body(max)[field].length, 90);
  }
});

test('utterances: limit сверх 200 отклоняется', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);
  assert.equal((await app.app.inject({ method: 'GET', url: '/api/utterances?limit=200' })).statusCode, 200);
  assert.equal((await app.app.inject({ method: 'GET', url: '/api/utterances?limit=201' })).statusCode, 400);
});

test('change-sets: limit сверх 200 отклоняется', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);
  assert.equal((await app.app.inject({ method: 'GET', url: '/api/change-sets?limit=200' })).statusCode, 200);
  assert.equal((await app.app.inject({ method: 'GET', url: '/api/change-sets?limit=201' })).statusCode, 400);
  assert.equal((await app.app.inject({ method: 'GET', url: '/api/change-sets?limit=0' })).statusCode, 400);
});

/* ------------------------------------------------------------------ */
/* Фильтры                                                             */
/* ------------------------------------------------------------------ */

test('неизвестный тип события отклоняется со списком допустимых', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({ method: 'GET', url: '/api/events?type=банан' });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.stringify(body(res)).includes('sleep'), true, 'в ошибке перечислены типы');
});

test('битые даты в from/to отклоняются, а не молча игнорируются', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  for (const value of ['мусор', '2026-13-45', 'вчера', '15.09.2026 или около того']) {
    const res = await app.app.inject({
      method: 'GET',
      url: `/api/events?from=${encodeURIComponent(value)}`,
    });
    assert.equal(res.statusCode, 400, `from=${value}`);
  }
});

test('окно from > to даёт пустой список, а не ошибку', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);
  insertEvent(app.db, { type: 'note', source: 'manual', started_at: '2026-09-15T10:00:00.000Z' });

  const res = await app.app.inject({
    method: 'GET',
    url: '/api/events?from=2026-09-16T00:00:00Z&to=2026-09-14T00:00:00Z',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(res).events, []);
});

test('include_deleted принимает только явные значения', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  for (const value of ['true', 'false', '1', '0', 'yes', 'no']) {
    const res = await app.app.inject({ method: 'GET', url: `/api/events?include_deleted=${value}` });
    assert.equal(res.statusCode, 200, `include_deleted=${value}`);
  }
  const bad = await app.app.inject({ method: 'GET', url: '/api/events?include_deleted=maybe' });
  assert.equal(bad.statusCode, 400);
});

/* ------------------------------------------------------------------ */
/* POST /api/events                                                    */
/* ------------------------------------------------------------------ */

test('POST без типа, с чужим типом и с чужими типами полей отклоняется', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const bad: unknown[] = [
    {},
    { type: 'банан' },
    { type: null },
    { type: 'feed', value_num: 'много' },
    { type: 'feed', value_unit: 'вёдер' },
    { type: 'feed', confidence: 2 },
    { type: 'feed', confidence: -0.5 },
    { type: 'note', note: 'x'.repeat(4001) },
    { type: 'note', subtype: 'y'.repeat(201) },
    { type: 'note', child_id: '' },
    { type: 'note', started_at: 'вчера вечером' },
    { type: 'sleep', ended_at: 'мусор' },
    [],
    42,
  ];

  for (const payload of bad) {
    const res = await app.app.inject({ method: 'POST', url: '/api/events', payload: payload as Json });
    assert.equal(
      res.statusCode >= 400 && res.statusCode < 500,
      true,
      `должно быть отклонено: ${JSON.stringify(payload)} (получено ${res.statusCode})`,
    );
  }
  const check = await app.app.inject({ method: 'GET', url: '/api/events' });
  assert.deepEqual(body(check).events, [], 'ни одно мусорное тело не создало события');
});

test('бесконечность и битый JSON отбиваются на входе', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);
  const json = { 'content-type': 'application/json' };

  // 1e400 в JSON парсится в Infinity — такого в REAL не сохранить
  const infinite = await app.app.inject({
    method: 'POST',
    url: '/api/events',
    headers: json,
    payload: '{"type":"feed","value_num":1e400}',
  });
  assert.equal(infinite.statusCode, 400);
  assert.match(JSON.stringify(body(infinite)), /finite/);

  const broken = await app.app.inject({
    method: 'POST',
    url: '/api/events',
    headers: json,
    payload: '{ это не json',
  });
  assert.equal(broken.statusCode, 400, 'битое тело — 400, а не падение процесса');

  const check = await app.app.inject({ method: 'GET', url: '/api/events' });
  assert.deepEqual(body(check).events, []);
});

test('POST перебивает source на manual, что бы ни прислали (§3.7)', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { type: 'feed', subtype: 'bottle', source: 'alice-llm', id: 777, confidence: 1 },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(body(res).event.source, 'manual');
  assert.notEqual(body(res).event.id, 777, 'id выдаёт база, а не клиент');
});

test('POST события, которое кончается раньше, чем началось, отклоняется как конфликт', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: {
      type: 'sleep',
      started_at: '2026-09-15T12:00:00Z',
      ended_at: '2026-09-15T10:00:00Z',
    },
  });
  assert.equal(res.statusCode, 409);
  assert.match(body(res).message, /ended_at раньше started_at/);
});

test('POST второго открытого сна закрывает первый, а не плодит второй', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  await app.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { type: 'sleep', started_at: '2026-09-15T10:00:00Z' },
  });
  const second = await app.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { type: 'sleep', started_at: '2026-09-15T12:00:00Z' },
  });

  assert.equal(second.statusCode, 201);
  assert.equal(body(second).closedPrevious?.ended_at, '2026-09-15T12:00:00.000Z');

  const list = await app.app.inject({ method: 'GET', url: '/api/events?type=sleep' });
  const open = body(list).events.filter((e: Json) => e.ended_at === null);
  assert.equal(open.length, 1, 'открытым остаётся ровно один сон');
});

test('единицы и подтипы §10.2 принимаются, текст в note не искажается', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const note = 'грудь left, 15 минут — «ёжик» 😴';
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { type: 'measure', subtype: 'head', value_num: 36.5, value_unit: 'cm', note },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(body(res).event.note, note, 'юникод доезжает без потерь');
  assert.equal(body(res).event.value_num, 36.5);
});

test('очень большое, но конечное число сохраняется и читается обратно', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { type: 'feed', subtype: 'bottle', value_num: 1e308, value_unit: 'ml' },
  });
  assert.equal(res.statusCode, 201);

  const list = await app.app.inject({ method: 'GET', url: '/api/events' });
  assert.equal(body(list).events[0].value_num, 1e308, 'число не превратилось в null или 0');
});

/* ------------------------------------------------------------------ */
/* PATCH / DELETE                                                      */
/* ------------------------------------------------------------------ */

test('PATCH: неизвестный id — 404, мусорный id — 400, пустое тело — 400', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  assert.equal((await app.app.inject({ method: 'PATCH', url: '/api/events/999999', payload: { note: 'x' } })).statusCode, 404);
  for (const id of ['abc', '0', '-1', '%20']) {
    const res = await app.app.inject({ method: 'PATCH', url: `/api/events/${id}`, payload: { note: 'x' } });
    assert.equal(res.statusCode, 400, `id=${id}`);
  }

  const created = await app.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'note' } });
  const id = body(created).event.id;
  assert.equal((await app.app.inject({ method: 'PATCH', url: `/api/events/${id}`, payload: {} })).statusCode, 400);
  assert.equal(
    (await app.app.inject({ method: 'PATCH', url: `/api/events/${id}`, payload: { started_at: 'мусор' } })).statusCode,
    400,
  );
  assert.equal(
    (await app.app.inject({ method: 'PATCH', url: `/api/events/${id}`, payload: { type: 'банан' } })).statusCode,
    400,
  );
});

// Найдено этой проверкой и уже исправлено владельцем api.ts: parseInt превращал
// «1abc» и «1.5» в 1, и запрос с битым id молча правил чужое событие.
test('id в пути не обрезается до числа: «1abc» не должен править событие 1', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);
  const created = await app.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'note', note: 'цел' } });
  const id = body(created).event.id;
  assert.equal(id, 1);

  for (const bad of ['1.5', '1abc', '1e0', '+1']) {
    const res = await app.app.inject({
      method: 'PATCH',
      url: `/api/events/${encodeURIComponent(bad)}`,
      payload: { note: `правка через ${bad}` },
    });
    assert.equal(res.statusCode, 400, `id=${bad} должен отклоняться`);
  }

  const check = await app.app.inject({ method: 'GET', url: '/api/events' });
  assert.equal(body(check).events[0].note, 'цел', 'событие не должно было измениться');
});

test('правка и повторное удаление удалённого события дают 404, а не тихий успех', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const created = await app.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'note', note: 'жив' } });
  const id = body(created).event.id;

  assert.equal((await app.app.inject({ method: 'DELETE', url: `/api/events/${id}` })).statusCode, 200);
  assert.equal((await app.app.inject({ method: 'PATCH', url: `/api/events/${id}`, payload: { note: 'поздно' } })).statusCode, 404);
  assert.equal((await app.app.inject({ method: 'DELETE', url: `/api/events/${id}` })).statusCode, 404);

  const deleted = await app.app.inject({ method: 'GET', url: '/api/events?include_deleted=true' });
  assert.equal(body(deleted).events[0].note, 'жив', 'текст не затёрт удалением');
});

test('DELETE отдаёт id набора, которым удаление отменяется', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const created = await app.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'note', note: 'вернуть' } });
  const id = body(created).event.id;
  const deleted = await app.app.inject({ method: 'DELETE', url: `/api/events/${id}` });
  const revertWith = body(deleted).revertWith;
  assert.equal(typeof revertWith, 'string');

  const reverted = await app.app.inject({ method: 'POST', url: `/api/change-sets/${revertWith}/revert` });
  assert.equal(reverted.statusCode, 200);

  const list = await app.app.inject({ method: 'GET', url: '/api/events' });
  assert.equal(body(list).events.length, 1, 'событие вернулось в ленту');
});

test('откат несуществующего набора — 404 с пояснением, а не 500', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({ method: 'POST', url: '/api/change-sets/нет-такого/revert' });
  assert.equal(res.statusCode, 404);
  assert.equal(body(res).error, 'revert_failed');
  assert.match(body(res).message, /не найден/);

  const missing = await app.app.inject({ method: 'GET', url: '/api/change-sets/нет-такого' });
  assert.equal(missing.statusCode, 404);
});

/* ------------------------------------------------------------------ */
/* Прочее                                                              */
/* ------------------------------------------------------------------ */

test('неизвестный /api/* — честный JSON-404, а не страница дашборда', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  for (const url of ['/api/нет-такого', '/api/events/1/подробности', '/api/']) {
    const res = await app.app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, url);
    assert.equal(body(res).error, 'not_found');
  }
});

test('/healthz жив на пустой базе и сообщает состояние воркера', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).ok, true);
  assert.equal(body(res).db, true);
  assert.equal(typeof body(res).worker.queueDepth, 'number');
});

test('/api/state на пустой базе не выдумывает сон', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({ method: 'GET', url: '/api/state' });
  const state = body(res);
  assert.equal(state.sleep.status, 'awake');
  assert.equal(state.sleep.since, null);
  assert.equal(state.sleep.currentDurationMin, 0);
  assert.equal(state.sleep.lastSleep, null);
  assert.equal(state.today.sleepTotalMin, 0);
  assert.equal(state.pending, 0);
  assert.equal(typeof state.child.ageDays, 'number');
});

/* ------------------------------------------------------------------ */
/* Параметры пути: строгий разбор id                                   */
/*                                                                      */
/* Дополнение к todo выше. Number.parseInt принимал «1abc» как 1, из-за */
/* чего PATCH /api/events/1abc правил событие 1, а DELETE /api/events/  */
/* 2xyz удалял второе. Проверка стала строгой — фиксируем её на всех    */
/* маршрутах с параметрами, а не только на двух найденных.             */
/* ------------------------------------------------------------------ */

/** Значения, которые Number.parseInt молча приводит к числу. */
const COERCIBLE_IDS = ['1abc', '1.5', '1e0', '+1', '1 ', '1%00', '01', '1,2', '0x1'];
/** Просто невалидные. */
const INVALID_IDS = ['abc', '0', '-1', '', ' ', '%20', 'null', 'undefined', 'NaN', 'Infinity'];

test('PATCH /api/events/:id: «почти число» отклоняется и чужое событие цело', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const created = await app.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { type: 'note', note: 'исходная заметка' },
  });
  assert.equal(body(created).event.id, 1);

  for (const bad of COERCIBLE_IDS) {
    const res = await app.app.inject({
      method: 'PATCH',
      url: `/api/events/${encodeURIComponent(bad)}`,
      payload: { note: `правка через «${bad}»` },
    });
    assert.equal(res.statusCode, 400, `id=«${bad}» обязан быть отклонён`);
    assert.equal(body(res).error, 'bad_request', `id=«${bad}»: 400, а не 404`);
    assert.match(body(res).issues ?? '', /целым положительным/, `id=«${bad}»: внятный текст`);
  }

  const check = await app.app.inject({ method: 'GET', url: '/api/events' });
  assert.equal(body(check).events[0].note, 'исходная заметка', 'событие не должно было измениться');
});

test('DELETE /api/events/:id: «почти число» отклоняется и событие не удаляется', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  await app.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'note', note: 'первое' } });
  await app.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'note', note: 'второе' } });

  for (const bad of [...COERCIBLE_IDS, ...INVALID_IDS]) {
    const res = await app.app.inject({
      method: 'DELETE',
      url: `/api/events/${encodeURIComponent(bad)}`,
    });
    assert.ok(
      res.statusCode === 400 || res.statusCode === 404,
      `id=«${bad}»: ожидался 400 (или 404 для пустого пути), получено ${res.statusCode}`,
    );
    if (res.statusCode === 400) assert.equal(body(res).error, 'bad_request');
  }

  const left = await app.app.inject({ method: 'GET', url: '/api/events' });
  assert.equal(body(left).events.length, 2, 'ни одно событие не должно было пропасть');
});

test('корректный id по-прежнему работает', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const created = await app.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'note' } });
  const id = body(created).event.id;

  const patched = await app.app.inject({
    method: 'PATCH',
    url: `/api/events/${id}`,
    payload: { note: 'поправлено' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(body(patched).event.note, 'поправлено');

  assert.equal(
    (await app.app.inject({ method: 'DELETE', url: `/api/events/${id}` })).statusCode,
    200,
  );
});

test('несуществующий, но валидный id даёт 404, а не 400', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  assert.equal(
    (await app.app.inject({ method: 'PATCH', url: '/api/events/999999', payload: { note: 'x' } }))
      .statusCode,
    404,
    'разница между «неверный формат» и «нет такого» должна быть видна',
  );
  assert.equal(
    (await app.app.inject({ method: 'DELETE', url: '/api/events/999999' })).statusCode,
    404,
  );
});

test('id набора изменений: непригодное — 400, просто отсутствующее — 404', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  // У непрозрачного id нет приведения типов, поэтому формат ему не навязываем:
  // «не найдено» не должно маскироваться под «неверный ввод».
  for (const notFound of ['..', 'a b', '<script>', 'нет-такого', '%2e%2e', "'; DROP TABLE"]) {
    const url = `/api/change-sets/${encodeURIComponent(notFound)}`;
    const res = await app.app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, `id=«${notFound}»: честное «не найдено»`);

    const revert = await app.app.inject({ method: 'POST', url: `${url}/revert` });
    assert.equal(revert.statusCode, 404, `revert id=«${notFound}»: тоже «не найдено»`);
  }

  // Литеральный «%00» — это просто печатная строка, её судьба тоже 404:
  // важно, что она уходит параметром запроса и ничего не ломает.
  assert.equal(
    (await app.app.inject({ method: 'GET', url: '/api/change-sets/%2500' })).statusCode,
    404,
  );

  // А вот то, что идентификатором быть не может, — честный 400.
  const NUL = String.fromCharCode(0);
  const UNIT_SEP = String.fromCharCode(31);
  for (const bad of [' ', NUL, `a${UNIT_SEP}b`]) {
    const url = `/api/change-sets/${encodeURIComponent(bad)}`;
    const res = await app.app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 400, `id=${JSON.stringify(bad)} обязан быть отклонён`);
    assert.equal(body(res).error, 'bad_request');
  }

  // Параметр длиннее 100 символов роутер Fastify не сопоставляет вовсе,
  // и запрос падает в общий 404 по /api/* — до обработчика он не доходит.
  const tooLong = await app.app.inject({
    method: 'GET',
    url: `/api/change-sets/${'x'.repeat(150)}`,
  });
  assert.equal(tooLong.statusCode, 404, 'слишком длинный параметр отсекает сам роутер');

  const missing = await app.app.inject({
    method: 'GET',
    url: '/api/change-sets/00000000-0000-0000-0000-000000000000',
  });
  assert.equal(missing.statusCode, 404, 'валидный по форме, но отсутствующий — 404');

  // и таблица на месте: мусорный id уходит параметром, а не в текст запроса
  assert.equal(
    (await app.app.inject({ method: 'GET', url: '/api/change-sets' })).statusCode,
    200,
  );
});

test('GET /api/change-sets/:id находит набор и за пределами последних 200', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  // первый набор — он же самый старый
  const first = await app.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'note', note: 'самый старый' } });
  assert.equal(first.statusCode, 201);
  const oldest = body(
    await app.app.inject({ method: 'GET', url: '/api/change-sets?limit=1' }),
  ).changeSets[0].id as string;

  // заваливаем историю: наборов становится сильно больше двухсот
  for (let i = 0; i < 205; i++) {
    await app.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'note', note: `шум ${i}` } });
  }

  const res = await app.app.inject({ method: 'GET', url: `/api/change-sets/${oldest}` });
  assert.equal(res.statusCode, 200, 'старый набор обязан находиться, а не теряться за лимитом');
  assert.equal(body(res).changeSet.id, oldest);
  assert.equal(body(res).revisions.length, 1);
  assert.equal(body(res).changeSet.revisions, 1);
  assert.deepEqual(body(res).changeSet.events, [1]);

  // и откатывается он тоже
  const reverted = await app.app.inject({ method: 'POST', url: `/api/change-sets/${oldest}/revert` });
  assert.equal(reverted.statusCode, 200);
});
