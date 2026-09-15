/**
 * §5 и обязательное требование «сервер работает без claude».
 * Вместо настоящего CLI подсовываем маленькие скрипты-заглушки: тесты должны быть
 * детерминированными и не ходить в сеть.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestApp } from './helpers.ts';
import {
  createWorker,
  looksRateLimited,
  parseClaudeJson,
  parseRateLimitReset,
} from '../src/worker.ts';
import { insertUtterance, listUtterances } from '../src/utterances.ts';
import { queryEvents } from '../src/events.ts';

/** Создаёт исполняемую заглушку claude. */
function fakeClaude(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-claude-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const VERSION_OK = `case "$1" in --version) echo "9.9.9 (fake)"; exit 0;; esac`;

test('claude не установлен: фраза ЖДЁТ в очереди, событие fast-path остаётся', async (t) => {
  const h = await makeTestApp({ CLAUDE_BIN: '/nonexistent/claude', WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  assert.equal(worker.status().claudeAvailable, false);
  assert.match(worker.status().claudeProblem ?? '', /не найден/);

  insertUtterance(h.db, { rawText: 'андрей заснул', fastResult: { kind: 'sleep_start' } });
  await worker.tick();
  await worker.tick();
  await worker.tick();

  const row = listUtterances(h.db)[0];
  // Раньше здесь стоял терминальный skipped, и фраза исчезала из разбора
  // навсегда — молча, потому что skipped с понятным матчеру kind админка
  // не показывает вовсе. Теперь недоступность CLI фразу не хоронит.
  assert.equal(row?.status, 'pending', 'фраза должна ждать возвращения CLI, а не гаснуть');
  assert.equal(row?.attempts, 0, 'попытки не жжём: разбирать нечем, фраза ни при чём');
  assert.equal(worker.status().queueDepth, 1, 'очередь видна снаружи');
  assert.ok(worker.status().oldestPendingAt, 'видно, с какого момента она стоит');
});

test('claude установлен, но не авторизован: фраза возвращается в очередь, CLI помечен мёртвым', async (t) => {
  const bin = fakeClaude(
    'claude',
    `${VERSION_OK}
echo '{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 OAuth access token has expired."}'
exit 1`,
  );

  const h = await makeTestApp({ CLAUDE_BIN: bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  assert.equal(worker.status().claudeAvailable, true, '--version отработал, CLI считается живым');

  insertUtterance(h.db, { rawText: 'покормили 120 мл', fastResult: { kind: 'unknown' } });
  await worker.tick();

  const row = listUtterances(h.db)[0];
  // Протухший токен фразу больше не хоронит: она остаётся в очереди.
  // Попытка при этом списана — иначе «--version проходит, разбор падает 401»
  // крутилось бы вечно (см. комментарий в worker.ts).
  assert.equal(row?.status, 'pending', 'проблема авторизации фразу не хоронит');
  assert.equal(row?.attempts, 1, 'попытка списана — это страховка от вечного круга');
  assert.match(row?.llm_error ?? '', /authenticate/i, 'причина видна в ленте');
  assert.equal(worker.status().claudeAvailable, false);
  assert.match(worker.status().claudeProblem ?? '', /authenticate/i);

  // Пока CLI считается мёртвым, очередь не разбирается вовсе: ни попыток, ни запусков.
  await worker.tick();
  await worker.tick();
  assert.equal(listUtterances(h.db)[0]?.attempts, 1, 'простой не расходует попытки');
  assert.equal(listUtterances(h.db)[0]?.status, 'pending');
});

test('успешный разбор: статус done и llm_result сохранён', async (t) => {
  const bin = fakeClaude(
    'claude',
    `${VERSION_OK}
echo '{"type":"result","subtype":"success","is_error":false,"result":"Ничего не изменил: событие уже записано матчером","total_cost_usd":0.01}'
exit 0`,
  );

  const h = await makeTestApp({ CLAUDE_BIN: bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  insertUtterance(h.db, { rawText: 'андрей заснул', fastResult: { kind: 'sleep_start' } });
  await worker.tick();

  const row = listUtterances(h.db)[0];
  assert.equal(row?.status, 'done');
  assert.equal(row?.attempts, 1);
  assert.match(row?.llm_result ?? '', /Ничего не изменил/);
});

test('обычный сбой повторяется до трёх раз, потом failed', async (t) => {
  const bin = fakeClaude('claude', `${VERSION_OK}\necho "что-то сломалось" >&2\nexit 2`);

  const h = await makeTestApp({ CLAUDE_BIN: bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  insertUtterance(h.db, { rawText: 'что-то невнятное', fastResult: { kind: 'unknown' } });

  await worker.tick();
  assert.equal(listUtterances(h.db)[0]?.status, 'pending', 'после 1-й неудачи ждём повтора');
  await worker.tick();
  assert.equal(listUtterances(h.db)[0]?.status, 'pending', 'после 2-й тоже');
  await worker.tick();

  const row = listUtterances(h.db)[0];
  assert.equal(row?.status, 'failed', 'после 3-й попытки — failed');
  assert.equal(row?.attempts, 3);

  await worker.tick();
  assert.equal(listUtterances(h.db)[0]?.attempts, 3, 'исчерпанную запись больше не берём');
});

test('таймаут: процесс убивается, сервер жив', async (t) => {
  const bin = fakeClaude('claude', `${VERSION_OK}\nsleep 30\nexit 0`);

  const h = await makeTestApp({ CLAUDE_BIN: bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  // Ждать настоящие 60 с в тестах нельзя, поэтому проверяем тот же механизм
  // принудительного убийства зависшего процесса — через остановку воркера.
  const worker = createWorker(h.ctx);
  worker.start();
  await worker.ready();

  insertUtterance(h.db, { rawText: 'долгая фраза', fastResult: { kind: 'unknown' } });
  const tick = worker.tick();
  await worker.stop(); // убивает текущий процесс
  await tick;

  const row = listUtterances(h.db)[0];
  assert.ok(row, 'запись на месте');
  assert.notEqual(row?.status, 'processing', 'зависших processing после остановки нет');
});

test('WORKER_ENABLED=false: очередь не разбирается, сервер работает', async (t) => {
  const h = await makeTestApp({ WORKER_ENABLED: 'false' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  assert.equal(worker.status().enabled, false);
  assert.equal(worker.status().alive, false);
});

test('фразы, ждущие мёртвого claude, не мешают fast-path писать события', async (t) => {
  const h = await makeTestApp({ CLAUDE_BIN: '/nonexistent/claude', WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  await h.app.inject({
    method: 'POST',
    url: '/alice/0123456789abcdef0123456789abcdef',
    payload: {
      session: { session_id: 's', skill_id: 'k', user_id: 'u' },
      request: { command: 'андрей заснул', nlu: {} },
      version: '1.0',
    },
  });

  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 1, 'сон записан несмотря на мёртвый LLM');

  await worker.tick();
  assert.equal(
    listUtterances(h.db)[0]?.status,
    'pending',
    'фраза ждёт разбора — сервер обязан работать без claude, но не терять фразы',
  );
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 1, 'событие никуда не делось');
});

test('parseClaudeJson разбирает ответы CLI', () => {
  assert.deepEqual(parseClaudeJson('{"is_error":false,"result":"ок"}'), {
    value: { is_error: false, result: 'ок' },
    isError: false,
    error: undefined,
  });

  const failed = parseClaudeJson('{"is_error":true,"result":"плохо"}');
  assert.equal(failed.isError, true);
  assert.equal(failed.error, 'плохо');

  assert.equal(parseClaudeJson('').isError, true);
  assert.equal(parseClaudeJson('просто текст').isError, false, 'не-JSON не считаем ошибкой');
});


/* ------------------------------------------------------------------ */
/* §9.4: лимиты подписки                                               */
/* ------------------------------------------------------------------ */

test('лимит опознаётся по нескольким независимым признакам', () => {
  const samples = [
    'Claude usage limit reached. Your limit will reset at 3pm.',
    'API Error: 429 Too Many Requests',
    '{"type":"result","is_error":true,"status":429}',
    'rate_limit_error: quota exceeded',
    'You have hit your rate limit, try again later',
    'Превышен лимит запросов',
  ];
  for (const text of samples) {
    assert.equal(looksRateLimited(text), true, `не распознано как лимит: ${text}`);
  }

  for (const text of [
    'Failed to authenticate. API Error: 401 OAuth access token has expired.',
    'command not found',
    '{"is_error":false,"result":"ок"}',
  ]) {
    assert.equal(looksRateLimited(text), false, `ложное срабатывание: ${text}`);
  }
});

test('время сброса окна вытаскивается из разных форматов', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');

  assert.equal(
    parseRateLimitReset('{"resetsAt":1789480800}', now),
    1789480800 * 1000,
    'unix-секунды',
  );
  assert.equal(
    parseRateLimitReset('limit reached, reset_at: "2026-09-15T15:30:00Z"', now),
    Date.parse('2026-09-15T15:30:00Z'),
    'ISO-время',
  );
  assert.equal(
    parseRateLimitReset('retry-after: 120', now),
    now.getTime() + 120_000,
    'retry-after в секундах',
  );
  assert.equal(parseRateLimitReset('usage limit reached', now), null, 'времени нет — null');
  assert.equal(
    parseRateLimitReset('reset_at: "2020-01-01T00:00:00Z"', now),
    null,
    'прошедшее время игнорируем',
  );
});

test('ЛИМИТ: фраза остаётся pending, попытка НЕ сгорает, воркер встаёт на паузу', async (t) => {
  const bin = fakeClaude(
    'claude',
    `${VERSION_OK}
echo 'Claude usage limit reached. Your limit will reset at 3pm.' >&2
exit 1`,
  );

  const h = await makeTestApp({ CLAUDE_BIN: bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  insertUtterance(h.db, { rawText: 'удали последний сон', fastResult: { kind: 'unknown' } });

  await worker.tick();

  const row = listUtterances(h.db)[0];
  assert.equal(row?.status, 'pending', 'фраза не сгорела — ждёт открытия окна');
  assert.equal(row?.attempts, 0, 'попытка не израсходована');
  assert.match(row?.llm_error ?? '', /лимит/i);

  const status = worker.status();
  assert.equal(status.rateLimited, true, 'воркер в состоянии лимита');
  assert.ok(status.rateLimitedUntil, 'известно, когда пробовать снова');
  assert.equal(status.claudeAvailable, true, 'это НЕ поломка CLI — флаг отдельный');

  // пока пауза, очередь не трогаем вовсе
  await worker.tick();
  await worker.tick();
  assert.equal(listUtterances(h.db)[0]?.attempts, 0, 'паузa не расходует попытки');
  assert.equal(listUtterances(h.db)[0]?.status, 'pending');
});

test('ЛИМИТ: три окна подряд не хоронят фразу (в отличие от обычных ошибок)', async (t) => {
  const bin = fakeClaude('claude', `${VERSION_OK}\necho 'API Error: 429' >&2\nexit 1`);
  const h = await makeTestApp({ CLAUDE_BIN: bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  insertUtterance(h.db, { rawText: 'убери запись', fastResult: { kind: 'unknown' } });

  // имитируем три окна: каждый раз снимаем паузу принудительным tick после сброса
  for (let i = 0; i < 3; i++) {
    // сбрасываем паузу, обнулив её через новый воркер на той же базе
    const w = createWorker(h.ctx);
    w.start();
    await w.ready();
    await w.tick();
    await w.stop();
  }

  const row = listUtterances(h.db)[0];
  assert.equal(row?.status, 'pending', 'после трёх лимитов фраза всё ещё в очереди');
  assert.equal(row?.attempts, 0);
});

test('переменные поштучной оплаты не попадают в дочерний процесс', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-env-'));
  const out = path.join(dir, 'env.txt');
  const bin = fakeClaude(
    'claude',
    `${VERSION_OK}
echo "KEY=[\${ANTHROPIC_API_KEY:-}] TOKEN=[\${ANTHROPIC_AUTH_TOKEN:-}] BEDROCK=[\${CLAUDE_CODE_USE_BEDROCK:-}] SECRET=[\${ALICE_WEBHOOK_SECRET:-}]" > ${out}
echo '{"is_error":false,"result":"ок"}'
exit 0`,
  );

  process.env.ANTHROPIC_API_KEY = 'sk-должен-быть-вычищен';
  process.env.ANTHROPIC_AUTH_TOKEN = 'тоже-вычищен';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  t.after(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const h = await makeTestApp({ CLAUDE_BIN: bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  insertUtterance(h.db, { rawText: 'что-то', fastResult: { kind: 'unknown' } });
  await worker.tick();

  const seen = fs.readFileSync(out, 'utf8');
  assert.match(seen, /KEY=\[\]/, 'ANTHROPIC_API_KEY не должен доехать до claude');
  assert.match(seen, /TOKEN=\[\]/, 'ANTHROPIC_AUTH_TOKEN не должен доехать');
  assert.match(seen, /BEDROCK=\[\]/, 'CLAUDE_CODE_USE_BEDROCK не должен доехать');
  assert.match(seen, /SECRET=\[\]/, 'секрет вебхука тем более');
});

test('воркер стартует немедленно по сигналу, не дожидаясь тика', async (t) => {
  const bin = fakeClaude(
    'claude',
    `${VERSION_OK}\necho '{"is_error":false,"result":"разобрано"}'\nexit 0`,
  );
  const h = await makeTestApp({ CLAUDE_BIN: bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  insertUtterance(h.db, { rawText: 'непонятная фраза', fastResult: { kind: 'unknown' } });
  worker.notify();

  // ждём заметно меньше секунды — если бы работал только таймер, не успели бы
  const deadline = Date.now() + 700;
  let status = '';
  while (Date.now() < deadline) {
    status = listUtterances(h.db)[0]?.status ?? '';
    if (status === 'done') break;
    await new Promise<void>((r) => setTimeout(r, 25));
  }

  assert.equal(status, 'done', 'сигнал должен запустить разбор сразу');
});
