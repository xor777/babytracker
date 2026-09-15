/**
 * Возврат фраз в разбор пачкой (§9.4) и видимость очереди в /healthz.
 *
 * Зачем сверх кнопки «разобрать заново» на одной фразе: терминальные статусы
 * копятся пачками — CLI падал час, политику переключили на `all`, а вчерашние
 * фразы остались погашенными прежней. Возвращать такое по одной кнопке на
 * фразу — работа, которую человек не сделает, и дневник останется дырявым.
 *
 * Ограничитель здесь такой же важный, как сама возможность: массовый возврат
 * обязан быть ДЕЙСТВИЕМ ЧЕЛОВЕКА с явным отбором и потолком, а не фоновым
 * сканом, который сам решит разобрать сотню фраз и сожжёт окно подписки.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers.ts';
import { insertUtterance, getUtterance, claimNextPending } from '../src/utterances.ts';
import { createWorker } from '../src/worker.ts';
import { run } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import type { UtteranceStatus } from '../src/types.ts';

function say(db: Db, text: string, status: UtteranceStatus, error?: string): number {
  return insertUtterance(db, {
    rawText: text,
    fastResult: { kind: 'sleep_start' },
    status,
    llmError: error ?? null,
  }).id;
}

function backdate(db: Db, id: number, minutesAgo: number): void {
  run(db, `UPDATE utterances SET received_at = ? WHERE id = ?`, [
    new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    id,
  ]);
}

test('пачкой: skipped возвращаются в очередь, done не трогается', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const skipped1 = say(h.db, 'что он лег спать', 'skipped', 'не отправлено модели: политика smart');
  const skipped2 = say(h.db, 'что он закончил кушать когда лег спать', 'skipped');
  const done = say(h.db, 'проснулся', 'done');

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/utterances/reparse',
    payload: { statuses: ['skipped'] },
  });

  assert.equal(res.statusCode, 202);
  const body = res.json<{ requeued: number; utterances: { id: number }[] }>();
  assert.equal(body.requeued, 2);
  assert.deepEqual(
    body.utterances.map((u) => u.id),
    [skipped1, skipped2],
    'порядок хронологический — так их и разберут',
  );

  for (const id of [skipped1, skipped2]) {
    const row = getUtterance(h.db, id);
    assert.equal(row?.status, 'pending', 'фраза снова в очереди');
    assert.equal(row?.attempts, 0, 'попытки обнулены: это просьба человека, а не повтор системы');
    assert.equal(row?.reparse_count, 1, 'модель узнает, что события по фразе уже могли быть');
    assert.equal(row?.llm_error, null, 'прежняя причина стёрта');
  }

  assert.equal(getUtterance(h.db, done)?.status, 'done', 'разобранное переразбирать не просили');
});

test('пачкой: failed возвращаются тем же путём, что и skipped', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const failed = say(h.db, 'фраза, на которой разбор падал', 'failed', 'код выхода 2');
  run(h.db, `UPDATE utterances SET attempts = 3 WHERE id = ?`, [failed]);

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/utterances/reparse',
    payload: { statuses: ['failed'] },
  });

  assert.equal(res.statusCode, 202);
  const row = getUtterance(h.db, failed);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.attempts, 0, 'исчерпанные попытки возвращены — иначе фразу не взять в работу');
});

test('без отбора ничего не возвращается: «верни всё» случайно не сделаешь', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const skipped = say(h.db, 'заснул', 'skipped');

  const empty = await h.app.inject({ method: 'POST', url: '/api/utterances/reparse', payload: {} });
  assert.equal(empty.statusCode, 400, 'пустое тело — это ошибка, а не «все фразы»');

  const noBody = await h.app.inject({ method: 'POST', url: '/api/utterances/reparse' });
  assert.equal(noBody.statusCode, 400);

  assert.equal(getUtterance(h.db, skipped)?.status, 'skipped', 'ничего не тронуто');
});

test('потолок: сколько бы ни лежало, за раз возвращается не больше запрошенного', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const ids: number[] = [];
  for (let i = 0; i < 10; i++) {
    const id = say(h.db, `фраза ${i}`, 'skipped');
    backdate(h.db, id, 100 - i);
    ids.push(id);
  }

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/utterances/reparse',
    payload: { statuses: ['skipped'], limit: 3 },
  });

  assert.equal(res.statusCode, 202);
  assert.equal(res.json<{ requeued: number }>().requeued, 3, 'ровно три, а не все десять');
  // Возвращаются самые старые — очередь честно хронологическая.
  assert.deepEqual(
    ids.slice(0, 3).map((id) => getUtterance(h.db, id)?.status),
    ['pending', 'pending', 'pending'],
  );
  assert.equal(
    getUtterance(h.db, ids[3] ?? -1)?.status,
    'skipped',
    'остальные ждут следующей просьбы',
  );
});

test('слишком большой limit отвергается, а не молча обрезается', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());
  say(h.db, 'заснул', 'skipped');

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/utterances/reparse',
    payload: { statuses: ['skipped'], limit: 100_000 },
  });
  assert.equal(res.statusCode, 400);
});

test('отбор по id и по времени', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const old = say(h.db, 'позавчерашняя', 'skipped');
  backdate(h.db, old, 60 * 48);
  const fresh = say(h.db, 'сегодняшняя', 'skipped');
  backdate(h.db, fresh, 30);

  const byId = await h.app.inject({
    method: 'POST',
    url: '/api/utterances/reparse',
    payload: { ids: [old, 999_999] },
  });
  assert.equal(byId.statusCode, 202);
  assert.equal(byId.json<{ requeued: number }>().requeued, 1, 'несуществующий id просто не в счёт');
  assert.equal(getUtterance(h.db, old)?.status, 'pending');
  assert.equal(getUtterance(h.db, fresh)?.status, 'skipped');

  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const byTime = await h.app.inject({
    method: 'POST',
    url: '/api/utterances/reparse',
    payload: { statuses: ['skipped'], since },
  });
  assert.equal(byTime.json<{ requeued: number }>().requeued, 1, 'только то, что свежее указанного');
  assert.equal(getUtterance(h.db, fresh)?.status, 'pending');
});

test('done пачкой не возвращается: переписывать разобранное можно только по одной фразе', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());
  const done = say(h.db, 'проснулся', 'done');

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/utterances/reparse',
    payload: { statuses: ['done'] },
  });
  assert.equal(res.statusCode, 400, 'статус done в массовый отбор не допускается');
  assert.equal(getUtterance(h.db, done)?.status, 'done');

  // По одной — пожалуйста: человек видит конкретную фразу и решает по ней.
  const single = await h.app.inject({
    method: 'POST',
    url: `/api/utterances/${done}/reparse`,
  });
  assert.equal(single.statusCode, 202);
  assert.equal(getUtterance(h.db, done)?.status, 'pending');
});

test('фразу, уже ждущую или разбираемую прямо сейчас, массовый возврат не трогает', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const waiting = say(h.db, 'ждёт в очереди', 'pending');
  const failed = say(h.db, 'упавшая', 'failed');
  const claimed = claimNextPending(h.db); // взята в работу воркером прямо сейчас
  assert.equal(claimed?.id, waiting);

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/utterances/reparse',
    payload: { ids: [waiting, failed], statuses: ['failed'] },
  });

  assert.equal(res.json<{ requeued: number }>().requeued, 1, 'вернули только упавшую');
  const row = getUtterance(h.db, waiting);
  assert.equal(row?.status, 'processing', 'разбираемую фразу из-под воркера не выдёргиваем');
  assert.equal(row?.attempts, 1, 'и её счётчик попыток не обнуляем — это открыло бы вечный круг');
});

test('/healthz показывает не только глубину очереди, но и её возраст', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  // Воркер не запускаем: статус очереди он читает из базы и без тиков.
  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  h.setWorkerStatus(() => worker.status());

  const empty = await h.app.inject({ method: 'GET', url: '/healthz' });
  const emptyWorker = empty.json<{ worker: Record<string, unknown> }>().worker;
  assert.equal(emptyWorker.queueDepth, 0);
  assert.equal(emptyWorker.oldestPendingAt, null, 'пустая очередь возраста не имеет');
  assert.equal(emptyWorker.queueLagSec, 0);

  const id = say(h.db, 'заснул', 'pending');
  backdate(h.db, id, 90);

  const res = await h.app.inject({ method: 'GET', url: '/healthz' });
  const waiting = res.json<{ worker: Record<string, unknown> }>().worker;
  assert.equal(waiting.queueDepth, 1);
  assert.ok(typeof waiting.oldestPendingAt === 'string', 'видно, с какого момента фраза ждёт');
  // Глубина очереди без возраста обманчива: «1 фраза» звучит безобидно,
  // «1 фраза, ждёт полтора часа» — это уже авария, которую надо чинить.
  assert.ok(
    (waiting.queueLagSec as number) >= 89 * 60,
    `очередь стоит ${String(waiting.queueLagSec)} с — это и должно быть видно`,
  );
});
