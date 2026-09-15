/** §3.1: вебхук Алисы — доступ, тексты ответов, бюджет 200 мс. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TEST_SECRET, aliceBody, makeTestApp } from './helpers.ts';
import { secretsEqual } from '../src/alice.ts';
import { maskUrl } from '../src/app.ts';
import { queryEvents } from '../src/events.ts';
import { listUtterances } from '../src/utterances.ts';

const URL_OK = `/alice/${TEST_SECRET}`;

async function post(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  url: string,
  payload: unknown,
) {
  return app.inject({ method: 'POST', url, payload: payload as object });
}

test('неверный секрет отклонён нейтральным ответом, событий не создаётся', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, '/alice/ffffffffffffffffffffffffffffffff', aliceBody('андрей заснул'));

  assert.equal(res.statusCode, 200, 'Алисе всегда 200, иначе она покажет ошибку');
  const body = res.json() as { response: { text: string; end_session: boolean }; version: string };
  assert.equal(body.version, '1.0');
  assert.ok(body.response.text.length > 0);
  assert.ok(!body.response.text.includes('заснул'), 'нейтральный текст не раскрывает причину');
  assert.equal(queryEvents(h.db, {}).length, 0, 'чужой запрос ничего не записал');
});

test('секрет неверной длины тоже отклонён', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  for (const bad of ['', 'short', `${TEST_SECRET}extra`, TEST_SECRET.slice(0, 31)]) {
    const res = await post(h.app, `/alice/${bad}`, aliceBody('андрей заснул'));
    assert.equal(res.statusCode, 200);
  }
  assert.equal(queryEvents(h.db, {}).length, 0);
});

test('сравнение секретов не зависит от длины и не бросает', () => {
  assert.equal(secretsEqual(TEST_SECRET, TEST_SECRET), true);
  assert.equal(secretsEqual(TEST_SECRET, 'x'), false);
  assert.equal(secretsEqual('', ''), true);
  assert.equal(secretsEqual(TEST_SECRET, ''), false);
});

test('чужой skill_id отклонён', async (t) => {
  const h = await makeTestApp({ ALICE_SKILL_ID: 'my-skill' });
  t.after(() => h.close());

  const alien = await post(h.app, URL_OK, aliceBody('андрей заснул', { skillId: 'other-skill' }));
  assert.equal(alien.statusCode, 200);
  assert.equal(queryEvents(h.db, {}).length, 0, 'чужой навык ничего не записал');

  const own = await post(h.app, URL_OK, aliceBody('андрей заснул', { skillId: 'my-skill' }));
  assert.equal(own.statusCode, 200);
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 1);
});

test('чужой user_id отклонён, свой принят', async (t) => {
  const h = await makeTestApp({ ALICE_ALLOWED_USER_IDS: 'user-a, user-b' });
  t.after(() => h.close());

  await post(h.app, URL_OK, aliceBody('андрей заснул', { userId: 'user-zzz' }));
  assert.equal(queryEvents(h.db, {}).length, 0);

  await post(h.app, URL_OK, aliceBody('андрей заснул', { userId: 'user-b' }));
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 1);
});

test('приветствие на новой сессии с пустой командой, сессия не закрывается', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, URL_OK, aliceBody('', { isNew: true }));
  const body = res.json() as { response: { text: string; tts: string; end_session: boolean } };

  assert.equal(res.statusCode, 200);
  assert.equal(body.response.end_session, false);
  assert.match(body.response.text, /Андрей/);
  assert.equal(listUtterances(h.db).length, 0, 'приветствие не засоряет очередь');
});

test('полный сценарий: заснул -> проснулся -> сводка', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const started = await post(h.app, URL_OK, aliceBody('андрей заснул'));
  const startedBody = started.json() as { response: { text: string; end_session: boolean } };
  assert.match(startedBody.response.text, /^Записала: Андрей заснул в \d{2}:\d{2}$/);
  assert.equal(startedBody.response.end_session, false);

  // повторное «заснул» не создаёт второй открытый сон
  const again = await post(h.app, URL_OK, aliceBody('андрей заснул'));
  const againBody = again.json() as { response: { text: string } };
  assert.match(againBody.response.text, /уже спит, с \d{2}:\d{2}/);
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 1);

  const woke = await post(h.app, URL_OK, aliceBody('андрей проснулся'));
  const wokeBody = woke.json() as { response: { text: string } };
  assert.match(wokeBody.response.text, /^Андрей проснулся\. Спал /);

  const summary = await post(h.app, URL_OK, aliceBody('сколько он сегодня спал'));
  const summaryBody = summary.json() as { response: { text: string } };
  assert.match(summaryBody.response.text, /Сегодня всего/);
});

test('«проснулся» без открытого сна отвечает и не падает', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, URL_OK, aliceBody('андрей проснулся'));
  const body = res.json() as { response: { text: string } };

  assert.equal(res.statusCode, 200);
  assert.equal(body.response.text, 'А он и не спал. Записала, что проснулся');
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 0);
  assert.equal(queryEvents(h.db, { type: 'note' }).length, 1);
});

test('мусорная фраза принимается и уходит в очередь на разбор', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, URL_OK, aliceBody('абырвалг колбаса'));
  const body = res.json() as { response: { text: string; end_session: boolean } };

  assert.match(body.response.text, /^Приняла: «абырвалг колбаса»\. Сейчас разберу$/);
  assert.equal(body.response.end_session, false);

  const queue = listUtterances(h.db);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.status, 'pending');
  assert.equal(queue[0]?.raw_text, 'абырвалг колбаса');
});

test('команда выхода закрывает сессию и не идёт в LLM', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, URL_OK, aliceBody('хватит'));
  const body = res.json() as { response: { text: string; end_session: boolean } };

  assert.equal(body.response.end_session, true);
  assert.equal(listUtterances(h.db)[0]?.status, 'skipped');
});

test('ответ укладывается в бюджет 200 мс', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  // прогрев: первый вызов включает разбор роутов и JIT
  await post(h.app, URL_OK, aliceBody('андрей заснул'));

  const samples: number[] = [];
  const phrases = ['андрей проснулся', 'андрей заснул', 'сколько он спал', 'абырвалг', 'встал'];
  for (const phrase of phrases) {
    const t0 = process.hrtime.bigint();
    const res = await post(h.app, URL_OK, aliceBody(phrase));
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(res.statusCode, 200);
    samples.push(elapsedMs);
  }

  const worst = Math.max(...samples);
  assert.ok(worst < 200, `худший ответ ${worst.toFixed(1)} мс, бюджет 200 мс`);
});

test('text и tts не длиннее 1024 символов', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await post(h.app, URL_OK, aliceBody('я'.repeat(5000)));
  const body = res.json() as { response: { text: string; tts: string } };

  assert.ok(body.response.text.length <= 1024, `text: ${body.response.text.length}`);
  assert.ok(body.response.tts.length <= 1024, `tts: ${body.response.tts.length}`);
});

test('битое тело запроса не роняет вебхук', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  for (const payload of [{}, { session: null }, { request: { command: null } }, []]) {
    const res = await post(h.app, URL_OK, payload);
    assert.equal(res.statusCode, 200, `payload: ${JSON.stringify(payload)}`);
    assert.equal((res.json() as { version: string }).version, '1.0');
  }

  const broken = await h.app.inject({
    method: 'POST',
    url: URL_OK,
    headers: { 'content-type': 'application/json' },
    payload: '{ не json',
  });
  assert.equal(broken.statusCode, 200, 'даже сломанный JSON получает 200 с нейтральным текстом');
});

test('секрет вебхука маскируется в логах', () => {
  assert.equal(maskUrl(`/alice/${TEST_SECRET}`), '/alice/***');
  assert.equal(maskUrl(`/alice/${TEST_SECRET}?x=1`), '/alice/***?x=1');
  assert.equal(maskUrl('/api/state'), '/api/state');
});
