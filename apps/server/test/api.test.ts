/** §3.2–3.8: REST-эндпоинты и SPA-fallback. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_SECRET, aliceBody, makeTestApp, testConfig, testDb } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { insertEvent, softDeleteEvent } from '../src/events.ts';
import { insertUtterance } from '../src/utterances.ts';
import { newChangeSetId, type JournalContext } from '../src/journal.ts';

test('GET /healthz', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'GET', url: '/healthz' });
  const body = res.json() as { ok: boolean; db: boolean; worker: Record<string, unknown> };

  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.db, true);
  assert.ok('alive' in body.worker);
  assert.ok('lastRunAt' in body.worker);
  assert.ok('queueDepth' in body.worker);
});

test('GET /api/state отдаёт форму из §3.2', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'GET', url: '/api/state' });
  const body = res.json() as Record<string, never>;

  assert.equal(res.statusCode, 200);
  for (const key of ['now', 'child', 'sleep', 'today', 'pending']) {
    assert.ok(key in body, `нет поля ${key}`);
  }
  const sleep = body.sleep as unknown as Record<string, unknown>;
  for (const key of ['status', 'since', 'currentDurationMin', 'lastSleep']) {
    assert.ok(key in sleep, `нет поля sleep.${key}`);
  }
  const today = body.today as unknown as Record<string, unknown>;
  for (const key of ['date', 'sleepTotalMin', 'sleepSessions', 'longestSleepMin']) {
    assert.ok(key in today, `нет поля today.${key}`);
  }
});

test('GET /api/events: фильтры, лимит и валидация', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  insertEvent(h.db, {
    type: 'sleep',
    started_at: '2026-09-15T10:00:00.000Z',
    ended_at: '2026-09-15T11:00:00.000Z',
    source: 'manual',
  });
  insertEvent(h.db, {
    type: 'feed',
    started_at: '2026-09-15T12:00:00.000Z',
    ended_at: '2026-09-15T12:20:00.000Z',
    source: 'manual',
  });

  const all = await h.app.inject({ method: 'GET', url: '/api/events' });
  assert.equal((all.json() as { events: unknown[] }).events.length, 2);

  const onlySleep = await h.app.inject({ method: 'GET', url: '/api/events?type=sleep' });
  assert.equal((onlySleep.json() as { events: unknown[] }).events.length, 1);

  const limited = await h.app.inject({ method: 'GET', url: '/api/events?limit=1' });
  assert.equal((limited.json() as { events: unknown[] }).events.length, 1);

  const bad = await h.app.inject({ method: 'GET', url: '/api/events?type=нечто' });
  assert.equal(bad.statusCode, 400);

  const badDate = await h.app.inject({ method: 'GET', url: '/api/events?from=вчера' });
  assert.equal(badDate.statusCode, 400);
});

test('POST /api/events создаёт событие с source=manual', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: {
      type: 'feed',
      subtype: 'bottle',
      started_at: '2026-09-15T12:00:00.000Z',
      value_num: 120,
      value_unit: 'ml',
      source: 'alice-fast', // должно быть перебито на manual
    },
  });

  assert.equal(res.statusCode, 201);
  const { event } = res.json() as { event: Record<string, unknown> };
  assert.equal(event.source, 'manual');
  assert.equal(event.value_num, 120);

  const bad = await h.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { type: 'нечто' },
  });
  assert.equal(bad.statusCode, 400);
});

test('GET /api/sleep/daily отдаёт нужное число суток', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'GET', url: '/api/sleep/daily?days=3' });
  const { days } = res.json() as { days: Array<Record<string, unknown>> };

  assert.equal(days.length, 3);
  for (const key of ['date', 'totalMin', 'sessions', 'nightMin', 'napMin']) {
    assert.ok(key in (days[0] ?? {}), `нет поля ${key}`);
  }

  const def = await h.app.inject({ method: 'GET', url: '/api/sleep/daily' });
  assert.equal((def.json() as { days: unknown[] }).days.length, 14);
});

test('GET /api/utterances отдаёт ленту с распарсенным fast_result', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  insertUtterance(h.db, {
    rawText: 'андрей заснул',
    fastResult: { kind: 'sleep_start', confidence: 0.95 },
  });

  const res = await h.app.inject({ method: 'GET', url: '/api/utterances?limit=5' });
  const { utterances } = res.json() as {
    utterances: Array<{ raw_text: string; status: string; fast_result: { kind: string } }>;
  };

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0]?.raw_text, 'андрей заснул');
  assert.equal(utterances[0]?.status, 'pending');
  assert.equal(utterances[0]?.fast_result.kind, 'sleep_start', 'fast_result отдаётся объектом');
});

test('несуществующий /api/* даёт честный 404 JSON, а не index.html', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'GET', url: '/api/net-takogo' });
  assert.equal(res.statusCode, 404);
  assert.match(res.headers['content-type'] as string, /application\/json/);
  assert.equal((res.json() as { error: string }).error, 'not_found');
});

test('без каталога dist сервер работает, отдавая 404 на маршруты дашборда', async (t) => {
  const h = await makeTestApp({ DASHBOARD_DIST: '/nonexistent/dashboard/dist' });
  t.after(() => h.close());

  const health = await h.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200, 'API живо без собранного дашборда');

  const spa = await h.app.inject({ method: 'GET', url: '/some/spa/route' });
  assert.equal(spa.statusCode, 404);
});

test('SSE отдаёт корректные заголовки и первое событие state', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({
    method: 'GET',
    url: '/api/stream',
    payloadAsStream: true,
  });

  assert.match(String(res.headers['content-type']), /text\/event-stream/);

  const chunk = await new Promise<string>((resolve, reject) => {
    let acc = '';
    const stream = res.stream();
    const timer = setTimeout(() => reject(new Error('SSE молчит')), 3000);
    stream.on('data', (buf: Buffer) => {
      acc += buf.toString('utf8');
      if (acc.includes('event: state')) {
        clearTimeout(timer);
        stream.destroy();
        resolve(acc);
      }
    });
    stream.on('error', () => {
      /* поток закрыт нами же */
    });
  });

  assert.match(chunk, /retry: \d+/);
  assert.match(chunk, /event: state/);
  assert.match(chunk, /"child"/);
});


/* ------------------------------------------------------------------ */
/* §9.6                                                                */
/* ------------------------------------------------------------------ */

test('GET /api/events?include_deleted=true показывает мягко удалённое', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const { event } = insertEvent(h.db, {
    type: 'sleep',
    started_at: '2026-09-15T10:00:00.000Z',
    ended_at: '2026-09-15T11:00:00.000Z',
    source: 'manual',
  });
  const journal: JournalContext = { changeSetId: newChangeSetId(), actor: 'api' };
  softDeleteEvent(h.db, event.id, journal);

  const hidden = await h.app.inject({ method: 'GET', url: '/api/events' });
  assert.equal((hidden.json() as { events: unknown[] }).events.length, 0);

  const shown = await h.app.inject({ method: 'GET', url: '/api/events?include_deleted=true' });
  const events = (shown.json() as { events: Array<{ id: number; deleted_at: string | null }> })
    .events;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.id, event.id);
  assert.ok(events[0]?.deleted_at, 'видно, что запись удалена');

  const bad = await h.app.inject({ method: 'GET', url: '/api/events?include_deleted=ага' });
  assert.equal(bad.statusCode, 400);
});

test('GET /api/change-sets отдаёт историю изменений', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  // ручная запись через API создаёт свой набор изменений
  await h.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { type: 'diaper', subtype: 'wet' },
  });

  const res = await h.app.inject({ method: 'GET', url: '/api/change-sets' });
  const { changeSets } = res.json() as {
    changeSets: Array<{ id: string; summary: string | null; revisions: number; events: number[] }>;
  };

  assert.equal(res.statusCode, 200);
  assert.equal(changeSets.length, 1);
  assert.equal(changeSets[0]?.revisions, 1);
  assert.equal(changeSets[0]?.events.length, 1);
  assert.match(changeSets[0]?.summary ?? '', /API/);
});

test('POST /api/change-sets/:id/revert возвращает данные как было', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const created = await h.app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { type: 'feed', subtype: 'bottle', value_num: 120, value_unit: 'ml' },
  });
  assert.equal(created.statusCode, 201);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/events' })).json<{ events: unknown[] }>().events.length, 1);

  const { changeSets } = (
    await h.app.inject({ method: 'GET', url: '/api/change-sets' })
  ).json() as { changeSets: Array<{ id: string }> };
  const id = changeSets[0]?.id ?? '';

  const reverted = await h.app.inject({ method: 'POST', url: `/api/change-sets/${id}/revert` });
  assert.equal(reverted.statusCode, 200);
  const body = reverted.json() as { reverted: string; revertChangeSetId: string };
  assert.equal(body.reverted, id);
  assert.ok(body.revertChangeSetId);

  const after = (await h.app.inject({ method: 'GET', url: '/api/events' })).json() as {
    events: unknown[];
  };
  assert.equal(after.events.length, 0, 'созданное событие спрятано');

  const physical = (
    await h.app.inject({ method: 'GET', url: '/api/events?include_deleted=true' })
  ).json() as { events: unknown[] };
  assert.equal(physical.events.length, 1, 'но физически строка на месте');
});

test('откат несуществующего набора даёт 404 с пояснением', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'POST', url: '/api/change-sets/нет-такого/revert' });
  assert.equal(res.statusCode, 404);
  assert.match((res.json() as { message: string }).message, /не найден/);
});

test('GET /api/change-sets/:id показывает сами ревизии', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await h.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'note', note: 'x' } });
  const { changeSets } = (
    await h.app.inject({ method: 'GET', url: '/api/change-sets' })
  ).json() as { changeSets: Array<{ id: string }> };

  const res = await h.app.inject({ method: 'GET', url: `/api/change-sets/${changeSets[0]?.id}` });
  const body = res.json() as { revisions: Array<{ op: string; after_json: string }> };
  assert.equal(res.statusCode, 200);
  assert.equal(body.revisions[0]?.op, 'insert');
  assert.ok(body.revisions[0]?.after_json);
});

test('/healthz показывает состояние лимита отдельно от доступности CLI', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const worker = (await h.app.inject({ method: 'GET', url: '/healthz' })).json<{
    worker: Record<string, unknown>;
  }>().worker;

  for (const key of ['claudeAvailable', 'rateLimited', 'rateLimitedUntil', 'rateLimitReason']) {
    assert.ok(key in worker, `нет поля worker.${key}`);
  }
});


/* ------------------------------------------------------------------ */
/* §10.4: админ-API                                                    */
/* ------------------------------------------------------------------ */

test('GET /api/events отдаёт исходный текст фразы рядом с событием', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await h.app.inject({
    method: 'POST',
    url: '/alice/0123456789abcdef0123456789abcdef',
    payload: {
      session: { session_id: 's', skill_id: 'k', user_id: 'u' },
      request: { command: 'андрей заснул', nlu: {} },
      version: '1.0',
    },
  });

  const res = await h.app.inject({ method: 'GET', url: '/api/events' });
  const events = (res.json() as { events: Array<Record<string, unknown>> }).events;

  assert.equal(events.length, 1);
  assert.equal(events[0]?.utterance_text, 'андрей заснул', 'без исходной фразы не поймать ошибку разбора');
  // все поля события на месте
  for (const key of ['id', 'type', 'started_at', 'source', 'deleted_at']) {
    assert.ok(key in (events[0] ?? {}), `нет поля ${key}`);
  }

  // событие, созданное вручную, живёт без фразы и не ломает джойн
  await h.app.inject({ method: 'POST', url: '/api/events', payload: { type: 'diaper', subtype: 'wet' } });
  const both = (await h.app.inject({ method: 'GET', url: '/api/events' })).json() as {
    events: Array<{ utterance_text: string | null }>;
  };
  assert.equal(both.events.length, 2);
  assert.ok(both.events.some((e) => e.utterance_text === null));
});

test('PATCH /api/events/:id правит событие через журнал', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const { event } = insertEvent(h.db, {
    type: 'feed',
    subtype: 'bottle',
    started_at: '2026-09-15T10:00:00.000Z',
    source: 'alice-llm',
  });

  const res = await h.app.inject({
    method: 'PATCH',
    url: `/api/events/${event.id}`,
    payload: { subtype: 'breast', value_num: 15, value_unit: 'min', note: 'левая грудь' },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as { event: Record<string, unknown>; changeSetId: string };
  assert.equal(body.event.subtype, 'breast');
  assert.equal(body.event.value_num, 15);
  assert.equal(body.event.note, 'левая грудь');
  assert.ok(body.changeSetId);

  // ручная правка обратима ровно как правка модели
  const revert = await h.app.inject({
    method: 'POST',
    url: `/api/change-sets/${body.changeSetId}/revert`,
  });
  assert.equal(revert.statusCode, 200);
  const after = (await h.app.inject({ method: 'GET', url: '/api/events' })).json() as {
    events: Array<{ subtype: string; note: string | null }>;
  };
  assert.equal(after.events[0]?.subtype, 'bottle', 'правка откатилась');
  assert.equal(after.events[0]?.note, null);
});

test('PATCH: несуществующий id, мусорный id и пустое тело', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  assert.equal(
    (await h.app.inject({ method: 'PATCH', url: '/api/events/999999', payload: { note: 'x' } }))
      .statusCode,
    404,
  );
  assert.equal(
    (await h.app.inject({ method: 'PATCH', url: '/api/events/абв', payload: { note: 'x' } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await h.app.inject({ method: 'PATCH', url: '/api/events/1', payload: { type: 'нечто' } }))
      .statusCode,
    400,
  );
});

test('DELETE /api/events/:id — мягкое удаление с возможностью вернуть', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const { event } = insertEvent(h.db, {
    type: 'sleep',
    started_at: '2026-09-15T10:00:00.000Z',
    ended_at: '2026-09-15T11:00:00.000Z',
    source: 'manual',
  });

  const res = await h.app.inject({ method: 'DELETE', url: `/api/events/${event.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { event: { deleted_at: string }; revertWith: string };
  assert.ok(body.event.deleted_at);

  assert.equal(
    ((await h.app.inject({ method: 'GET', url: '/api/events' })).json() as { events: unknown[] })
      .events.length,
    0,
  );
  assert.equal(
    (
      (
        await h.app.inject({ method: 'GET', url: '/api/events?include_deleted=true' })
      ).json() as { events: unknown[] }
    ).events.length,
    1,
    'физически строка на месте',
  );

  await h.app.inject({ method: 'POST', url: `/api/change-sets/${body.revertWith}/revert` });
  assert.equal(
    ((await h.app.inject({ method: 'GET', url: '/api/events' })).json() as { events: unknown[] })
      .events.length,
    1,
    'удаление откатилось',
  );

  assert.equal(
    (await h.app.inject({ method: 'DELETE', url: '/api/events/999999' })).statusCode,
    404,
  );
});

test('GET /api/stats/daily считает кормления, подгузники, сон и нормы', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const today = new Date().toISOString().slice(0, 10);
  const at = (hh: string) => `${today}T${hh}:00:00.000Z`;

  insertEvent(h.db, { type: 'feed', subtype: 'bottle', started_at: at('06'), value_num: 120, value_unit: 'ml', source: 'manual' });
  insertEvent(h.db, { type: 'feed', subtype: 'breast', started_at: at('07'), value_num: 15, value_unit: 'min', source: 'manual' });
  insertEvent(h.db, { type: 'diaper', subtype: 'wet', started_at: at('06'), source: 'manual' });
  insertEvent(h.db, { type: 'diaper', subtype: 'wet', started_at: at('08'), source: 'manual' });
  insertEvent(h.db, { type: 'diaper', subtype: 'dirty', started_at: at('09'), source: 'manual' });
  insertEvent(h.db, { type: 'measure', subtype: 'weight', started_at: at('10'), value_num: 7.2, value_unit: 'kg', source: 'manual' });
  insertEvent(h.db, { type: 'measure', subtype: 'head', started_at: at('10'), value_num: 43, value_unit: 'cm', source: 'manual' });

  const res = await h.app.inject({ method: 'GET', url: '/api/stats/daily?days=1' });
  assert.equal(res.statusCode, 200);
  const day = (res.json() as { days: Array<Record<string, never>> }).days[0] as unknown as {
    feeds: { total: number; bottle: number; breast: number; volumeMl: number | null };
    diapers: { wet: number; dirty: number; total: number };
    measures: { weightG: number | null; headCm: number | null; heightCm: number | null };
    norms: { feeds: { min: number; max: number }; wetDiapers: { min: number } };
    ageDays: number;
  };

  assert.equal(day.feeds.total, 2);
  assert.equal(day.feeds.bottle, 1);
  assert.equal(day.feeds.breast, 1);
  assert.equal(day.feeds.volumeMl, 120, 'минуты груди в миллилитры не суммируются');
  assert.equal(day.diapers.wet, 2);
  assert.equal(day.diapers.dirty, 1);
  assert.equal(day.measures.weightG, 7200, 'кг приведены к граммам');
  assert.equal(day.measures.headCm, 43, 'окружность головы (§10.2)');
  assert.equal(day.measures.heightCm, null, 'не измеряли — null, а не ноль');
  assert.equal(day.norms.feeds.min, 8);
  assert.equal(day.norms.feeds.max, 12);
  assert.equal(day.norms.wetDiapers.min, 6, 'ребёнку сильно больше 5 дней');
});

test('объём не выдумывается: без чисел volumeMl = null, а не 0', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const today = new Date().toISOString().slice(0, 10);
  insertEvent(h.db, { type: 'feed', subtype: 'breast', started_at: `${today}T06:00:00.000Z`, source: 'manual' });

  const day = (
    (await h.app.inject({ method: 'GET', url: '/api/stats/daily?days=1' })).json() as {
      days: Array<{ feeds: { total: number; volumeMl: number | null } }>;
    }
  ).days[0];

  assert.equal(day?.feeds.total, 1);
  assert.equal(day?.feeds.volumeMl, null, 'ноль означал бы «покормили нулём мл» — это ложь в данных');
});

test('новые типы §10.2 принимаются API', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  for (const payload of [
    { type: 'pump', value_num: 80, value_unit: 'ml' },
    { type: 'symptom', subtype: 'spit_up' },
    { type: 'activity', subtype: 'bath', value_num: 20, value_unit: 'min' },
    { type: 'measure', subtype: 'head', value_num: 43, value_unit: 'cm' },
  ]) {
    const res = await h.app.inject({ method: 'POST', url: '/api/events', payload });
    assert.equal(res.statusCode, 201, `тип ${payload.type} должен приниматься`);
  }
});


/* ------------------------------------------------------------------ */
/* Раздача статики: телевизор по «/», админка по «/dash»                */
/* ------------------------------------------------------------------ */

test('раздача /dash не перехватывает api, alice и healthz', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-static-'));
  const tv = path.join(dir, 'tv');
  const admin = path.join(dir, 'admin', 'assets');
  fs.mkdirSync(tv, { recursive: true });
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(tv, 'index.html'), '<html>ТЕЛЕВИЗОР</html>');
  fs.writeFileSync(path.join(dir, 'admin', 'index.html'), '<html>АДМИНКА</html>');
  fs.writeFileSync(path.join(admin, 'app-abc123.js'), 'console.log("admin bundle")');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cfg = testConfig({ DASHBOARD_DIST: tv, ADMIN_DIST: path.join(dir, 'admin') });
  const db = testDb();
  const { app, sse } = createApp({ cfg, db, logger: false });
  await app.ready();
  t.after(async () => {
    sse.close();
    await app.close();
    db.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });

  const root = await get('/');
  assert.equal(root.statusCode, 200);
  assert.match(root.body, /ТЕЛЕВИЗОР/, '«/» — дашборд телевизора');

  for (const url of ['/dash', '/dash/']) {
    const res = await get(url);
    assert.equal(res.statusCode, 200, `${url} должен отдавать админку`);
    assert.match(res.body, /АДМИНКА/, `${url} — админка, а не дашборд`);
    assert.match(String(res.headers['content-type']), /text\/html/);
  }

  const asset = await get('/dash/assets/app-abc123.js');
  assert.equal(asset.statusCode, 200);
  assert.match(asset.body, /admin bundle/);

  // API, вебхук и healthz статика перехватывать не должна
  assert.equal((await get('/api/state')).statusCode, 200);
  assert.match(String((await get('/api/state')).headers['content-type']), /application\/json/);
  assert.equal((await get('/healthz')).statusCode, 200);

  const missingApi = await get('/api/net-takogo');
  assert.equal(missingApi.statusCode, 404);
  assert.match(String(missingApi.headers['content-type']), /application\/json/, 'не HTML');

  const alice = await app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('андрей заснул'),
  });
  assert.equal(alice.statusCode, 200);
  assert.match((alice.json() as { response: { text: string } }).response.text, /Записала/);

  // SPA-fallback телевизора не съедает /dash
  const unknownDash = await get('/dash/чего-нет');
  assert.equal(unknownDash.statusCode, 404, 'у админки хэш-роутинг, fallback не нужен');
  assert.equal(
    unknownDash.body.includes('ТЕЛЕВИЗОР'),
    false,
    'под /dash дашборд телевизора показывать нельзя',
  );

  // а маршруты самого телевизора fallback по-прежнему обслуживает
  const spa = await get('/какой-то/путь');
  assert.equal(spa.statusCode, 200);
  assert.match(spa.body, /ТЕЛЕВИЗОР/);
});

test('нет apps/admin/dist — сервер работает, /dash отдаёт 404', async (t) => {
  const h = await makeTestApp({ ADMIN_DIST: '/nonexistent/admin/dist' });
  t.after(() => h.close());

  assert.equal((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/state' })).statusCode, 200);
  assert.equal((await h.app.inject({ method: 'GET', url: '/dash' })).statusCode, 404);
});

/* ------------------------------------------------------------------ */
/* Админка это PWA: заголовки — часть работоспособности                */
/*                                                                      */
/* Оба отказа ниже происходят МОЛЧА, без ошибок в консоли:              */
/*  - манифест с чужим Content-Type браузер игнорирует, и установка     */
/*    на домашний экран просто не предлагается;                         */
/*  - service worker с длинным кешированием застревает вместе со всей   */
/*    старой версией приложения, и обновления перестают доходить.       */
/* ------------------------------------------------------------------ */

interface PwaFixture {
  dir: string;
  app: Awaited<ReturnType<typeof makeTestApp>>['app'];
  close: () => Promise<void>;
}

/** Собранная админка в том виде, в каком её кладёт vite-plugin-pwa. */
async function makePwaApp(files: Record<string, string>): Promise<PwaFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pwa-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const cfg = testConfig({ ADMIN_DIST: dir, DASHBOARD_DIST: path.join(dir, 'нет-такого') });
  const db = testDb();
  const { app, sse } = createApp({ cfg, db, logger: false });
  await app.ready();

  return {
    dir,
    app,
    close: async () => {
      sse.close();
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const PWA_FILES = {
  'index.html': '<!doctype html><html><head><link rel="manifest" href="/dash/manifest.webmanifest"></head></html>',
  'manifest.webmanifest': '{"name":"BabyTracker","scope":"/dash/","start_url":"/dash/"}',
  'sw.js': 'self.addEventListener("install", () => {});',
  'registerSW.js': 'console.log("register");',
  'pwa-192.png': 'PNG',
  'assets/index-B7xK9a.js': 'console.log("bundle");',
  'assets/index-C2mQ4z.css': ':root{--x:1}',
};

test('манифест PWA отдаётся с типом application/manifest+json', async (t) => {
  const h = await makePwaApp(PWA_FILES);
  t.after(h.close);

  const res = await h.app.inject({ method: 'GET', url: '/dash/manifest.webmanifest' });
  assert.equal(res.statusCode, 200);
  assert.match(
    String(res.headers['content-type']),
    /^application\/manifest\+json/,
    'с другим типом браузер молча не предложит установку на домашний экран',
  );
  assert.equal(JSON.parse(res.body).scope, '/dash/', 'содержимое отдаётся как есть');
});

test('service worker не кешируется надолго и работает в области /dash/', async (t) => {
  const h = await makePwaApp(PWA_FILES);
  t.after(h.close);

  const res = await h.app.inject({ method: 'GET', url: '/dash/sw.js' });
  assert.equal(res.statusCode, 200);

  const cache = String(res.headers['cache-control']);
  assert.match(cache, /no-cache/, 'закешированный воркер перестаёт получать обновления');
  assert.equal(/max-age=[1-9]/.test(cache), false, `длительное кеширование воркера: ${cache}`);

  // тип должен быть исполняемым JS, иначе регистрация воркера падает
  assert.match(String(res.headers['content-type']), /javascript/);

  // область: ровно /dash/, не шире — воркеру админки нечего делать на «/»
  assert.equal(res.headers['service-worker-allowed'], '/dash/');
});

test('оболочка приложения перепроверяется, хешированные ассеты кешируются навсегда', async (t) => {
  const h = await makePwaApp(PWA_FILES);
  t.after(h.close);

  // index.html и по /dash, и по /dash/ — иначе застрянет старая версия
  for (const url of ['/dash', '/dash/']) {
    const res = await h.app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['cache-control']), /no-cache/, `${url}: оболочка не кешируется`);
  }

  // имя с хешем содержимого -> можно кешировать навсегда
  for (const url of ['/dash/assets/index-B7xK9a.js', '/dash/assets/index-C2mQ4z.css']) {
    const res = await h.app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['cache-control']), /max-age=31536000/, url);
    assert.match(String(res.headers['cache-control']), /immutable/, url);
  }

  // файлы верхнего уровня имя не меняют -> перепроверять
  for (const url of ['/dash/registerSW.js', '/dash/pwa-192.png']) {
    const res = await h.app.inject({ method: 'GET', url });
    assert.match(String(res.headers['cache-control']), /no-cache/, url);
  }
});

test('манифеста и воркера ещё нет — сервер работает, отдаёт 404 на них', async (t) => {
  // ровно текущее состояние: админка собрана, PWA-файлы появятся позже
  const h = await makePwaApp({
    'index.html': '<html>админка без PWA</html>',
    'assets/index-B7xK9a.js': 'console.log("bundle");',
  });
  t.after(h.close);

  assert.equal((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/state' })).statusCode, 200);
  assert.equal((await h.app.inject({ method: 'GET', url: '/dash' })).statusCode, 200);
  assert.equal(
    (await h.app.inject({ method: 'GET', url: '/dash/assets/index-B7xK9a.js' })).statusCode,
    200,
  );

  for (const url of ['/dash/manifest.webmanifest', '/dash/sw.js']) {
    assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 404, url);
  }
});

test('заголовки PWA не мешают остальным маршрутам', async (t) => {
  const h = await makePwaApp(PWA_FILES);
  t.after(h.close);

  const state = await h.app.inject({ method: 'GET', url: '/api/state' });
  assert.equal(state.statusCode, 200);
  assert.match(String(state.headers['content-type']), /application\/json/);

  const missing = await h.app.inject({ method: 'GET', url: '/api/чего-нет' });
  assert.equal(missing.statusCode, 404);
  assert.match(String(missing.headers['content-type']), /application\/json/);

  assert.equal((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);

  const alice = await h.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('андрей заснул'),
  });
  assert.equal(alice.statusCode, 200);
});

test('404 на манифест остаётся JSON-ошибкой, а не притворяется манифестом', async (t) => {
  const h = await makePwaApp({ 'index.html': '<html>админка</html>' });
  t.after(h.close);

  const res = await h.app.inject({ method: 'GET', url: '/dash/manifest.webmanifest' });
  assert.equal(res.statusCode, 404);
  assert.match(
    String(res.headers['content-type']),
    /application\/json/,
    'тело — ошибка, и тип должен быть честным',
  );
  assert.equal((res.json() as { error: string }).error, 'not_found');
});

/* ------------------------------------------------------------------ */
/* Переразбор фразы: кнопка «разобрать заново»                         */
/* ------------------------------------------------------------------ */

test('POST /api/utterances/:id/reparse возвращает фразу в очередь', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  // фраза, которую матчер счёл разобранной и модели не отдал
  const inserted = insertUtterance(h.db, {
    rawText: 'что он закончил кушать когда лег спать',
    fastResult: { kind: 'sleep_start', confidence: 0.95 },
    status: 'skipped',
    llmError: 'не отправлено модели: fast-path уверенно разобрал',
  });

  const res = await h.app.inject({
    method: 'POST',
    url: `/api/utterances/${inserted.id}/reparse`,
  });

  assert.equal(res.statusCode, 202);
  const { utterance } = res.json() as {
    utterance: { id: number; status: string; attempts: number; reparse_count: number; llm_error: string | null };
  };

  assert.equal(utterance.id, inserted.id);
  assert.equal(utterance.status, 'pending', 'фраза обязана вернуться в очередь');
  assert.equal(utterance.attempts, 0, 'человек просит заново — попытки обнуляются');
  assert.equal(utterance.reparse_count, 1);
  assert.equal(utterance.llm_error, null, 'прошлое объяснение снято');
});

test('переразбор работает независимо от политики и повторяется', async (t) => {
  // даже в самом экономном режиме кнопка обязана работать
  const h = await makeTestApp({ LLM_QUEUE_POLICY: 'unknown' });
  t.after(() => h.close());

  const inserted = insertUtterance(h.db, {
    rawText: 'андрей заснул',
    fastResult: { kind: 'sleep_start', confidence: 0.95 },
    status: 'skipped',
  });

  for (const expected of [1, 2, 3]) {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/utterances/${inserted.id}/reparse`,
    });
    assert.equal(res.statusCode, 202);
    assert.equal(
      (res.json() as { utterance: { reparse_count: number } }).utterance.reparse_count,
      expected,
    );
  }
});

test('переразбор: неверный и несуществующий id', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  for (const bad of ['1abc', '0', '-1', 'абв']) {
    const res = await h.app.inject({ method: 'POST', url: `/api/utterances/${bad}/reparse` });
    assert.equal(res.statusCode, 400, `id=${bad}`);
  }
  assert.equal(
    (await h.app.inject({ method: 'POST', url: '/api/utterances/999999/reparse' })).statusCode,
    404,
  );
});

test('переразбор виден в ленте фраз', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const inserted = insertUtterance(h.db, { rawText: 'что-то невнятное', status: 'failed' });
  await h.app.inject({ method: 'POST', url: `/api/utterances/${inserted.id}/reparse` });

  const { utterances } = (
    await h.app.inject({ method: 'GET', url: '/api/utterances' })
  ).json() as { utterances: Array<{ status: string; reparse_count: number }> };

  assert.equal(utterances[0]?.status, 'pending');
  assert.equal(utterances[0]?.reparse_count, 1, 'админка видит, что фразу переразбирали');
});
