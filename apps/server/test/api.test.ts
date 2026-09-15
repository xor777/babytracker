/** §3.2–3.8: REST-эндпоинты и SPA-fallback. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers.ts';
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
