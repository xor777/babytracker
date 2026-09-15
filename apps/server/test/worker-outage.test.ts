/**
 * Надёжность доставки фразы до модели (§5, §9.4).
 *
 * С политикой `all` модель зовут на КАЖДУЮ фразу, поэтому единственная
 * настоящая защита дневника — очередь. Здесь проверяется, что она ведёт себя
 * как очередь, а не как решето, и при этом не превращается в вечный двигатель:
 *
 *   1. пока claude недоступен, фразы ЖДУТ и не гасятся;
 *   2. ожидание не стоит НИ ОДНОГО вызова модели;
 *   3. ожившая очередь разгребается в хронологическом порядке;
 *   4. рестарт сервера очередь не теряет и счётчик попыток не обнуляет;
 *   5. настоящая ошибка разбора конечна: три попытки — и `failed`, после
 *      которого автоматика к фразе не возвращается НИКОГДА;
 *   6. фраза, пролежавшая в очереди час, разбирается по времени, когда её
 *      сказали, а не по времени разбора.
 *
 * Счётчик запусков настоящий: заглушка CLI дописывает строку в файл на каждый
 * свой запуск, отдельно для пробы `--version` и отдельно для разбора. Проверять
 * «сколько раз дёрнули функцию» здесь бессмысленно — вопрос ровно в том,
 * сколько раз реально стартовал процесс модели.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestApp } from './helpers.ts';
import {
  PROBE_BACKOFF_MAX_MS,
  REPROBE_MS,
  createWorker,
  probeIntervalMs,
} from '../src/worker.ts';
import { insertUtterance, getUtterance, claimNextPending } from '../src/utterances.ts';
import { run } from '../src/db.ts';
import type { Db } from '../src/db.ts';

/* ------------------------------------------------------------------ */
/* Заглушка CLI со счётчиком запусков                                  */
/* ------------------------------------------------------------------ */

interface FakeCli {
  /** Путь к «исполняемому файлу» claude. */
  bin: string;
  /** Сломать авторизацию: `--version` работает, разбор падает 401. */
  breakAuth: () => void;
  /** Починить авторизацию. */
  fixAuth: () => void;
  /** Убрать сам файл CLI (аналог «claude снесли с сервера»). */
  remove: () => void;
  /** Вернуть файл CLI на место. */
  restore: () => void;
  /** Сколько раз реально запускался разбор (= вызовов модели). */
  runs: () => number;
  /** Сколько раз запускалась проба `--version` (вызовом модели не является). */
  probes: () => number;
  /** id фраз в порядке, в котором их отдавали модели. */
  order: () => number[];
  /** Промпт последнего разбора целиком. */
  lastPrompt: () => string;
}

function fakeCli(t: { after: (fn: () => void) => void }): FakeCli {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-outage-'));
  const bin = path.join(dir, 'claude');
  const hidden = path.join(dir, 'claude.hidden');
  const log = path.join(dir, 'calls.log');
  const promptFile = path.join(dir, 'prompt.txt');
  const brokenFlag = path.join(dir, 'broken');

  // Промпт приходит вторым аргументом (`-p <prompt>`); из него достаём
  // utterance_id — по нему видно и факт разбора, и его очерёдность.
  fs.writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "probe" >> "${log}"
  echo "9.9.9 (fake)"
  exit 0
fi
if [ -f "${brokenFlag}" ]; then
  echo "run-auth-failed" >> "${log}"
  echo '{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 OAuth access token has expired."}'
  exit 1
fi
printf '%s' "$2" > "${promptFile}"
printf '%s' "$2" | grep -o 'utterance_id = [0-9]*' | head -1 >> "${log}"
echo '{"type":"result","is_error":false,"result":"разобрано"}'
exit 0
`,
    { mode: 0o755 },
  );

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const lines = (): string[] =>
    fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.trim().length > 0)
      : [];

  return {
    bin,
    breakAuth: () => fs.writeFileSync(brokenFlag, '1'),
    fixAuth: () => fs.rmSync(brokenFlag, { force: true }),
    remove: () => fs.renameSync(bin, hidden),
    restore: () => fs.renameSync(hidden, bin),
    runs: () => lines().filter((l) => !l.startsWith('probe')).length,
    probes: () => lines().filter((l) => l.startsWith('probe')).length,
    order: () =>
      lines()
        .filter((l) => l.startsWith('utterance_id'))
        .map((l) => Number.parseInt(l.replace(/\D+/g, ''), 10)),
    lastPrompt: () => (fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : ''),
  };
}

/** Сдвигает момент прихода фразы в прошлое: очередь стояла. */
function backdate(db: Db, id: number, minutesAgo: number): void {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  run(db, `UPDATE utterances SET received_at = ? WHERE id = ?`, [at, id]);
}

function say(db: Db, text: string): number {
  return insertUtterance(db, { rawText: text, fastResult: { kind: 'unknown' } }).id;
}

/* ------------------------------------------------------------------ */
/* CLI лёг посреди очереди                                             */
/* ------------------------------------------------------------------ */

test('CLI лёг посреди очереди: разобранное остаётся, остальное ЖДЁТ и не стоит вызовов', async (t) => {
  const cli = fakeCli(t);
  const h = await makeTestApp({ CLAUDE_BIN: cli.bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  const first = say(h.db, 'он покушал сто двадцать');
  const second = say(h.db, 'потом заснул');
  const third = say(h.db, 'проснулся в девять');

  await worker.tick(); // первую разобрали нормально
  assert.equal(getUtterance(h.db, first)?.status, 'done');
  assert.equal(cli.runs(), 1);

  cli.breakAuth(); // токен протух ровно посередине очереди
  await worker.tick();

  assert.equal(cli.runs(), 2, 'вторую фразу попробовали — и наткнулись на 401');
  assert.equal(worker.status().claudeAvailable, false, 'CLI помечен недоступным');

  const afterFailure = getUtterance(h.db, second);
  assert.equal(afterFailure?.status, 'pending', 'фраза осталась в очереди, а не сгорела');
  assert.equal(afterFailure?.attempts, 1, 'попытка списана — страховка от вечного круга');

  // Дальше очередь не трогается вообще: ни одного запуска разбора.
  const runsAtOutage = cli.runs();
  for (let i = 0; i < 20; i++) await worker.tick();

  assert.equal(cli.runs(), runsAtOutage, 'простой не стоит НИ ОДНОГО вызова модели');
  assert.equal(getUtterance(h.db, second)?.attempts, 1, 'попытки второй фразы не жгутся');
  assert.equal(getUtterance(h.db, third)?.attempts, 0, 'до третьей вообще не дошли');
  assert.equal(getUtterance(h.db, third)?.status, 'pending');
  assert.equal(worker.status().queueDepth, 2, 'в очереди честные две фразы');
  assert.ok(worker.status().oldestPendingAt, 'видно, с какого момента очередь стоит');
});

test('CLI снесли с сервера: попытки не жгутся вовсе, потому что процесс не стартует', async (t) => {
  const cli = fakeCli(t);
  const h = await makeTestApp({ CLAUDE_BIN: cli.bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  // reprobeMs = 0: тест не может ждать настоящие пять минут, а проверить надо
  // именно автоматическое восстановление, а не ручной вызов пробы.
  const worker = createWorker(h.ctx, { reprobeMs: 0 });
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  const first = say(h.db, 'покормили в час');
  const second = say(h.db, 'поменяли подгузник');

  cli.remove();
  for (let i = 0; i < 5; i++) await worker.tick();

  assert.equal(cli.runs(), 0, 'разбор не запускался ни разу');
  assert.equal(getUtterance(h.db, first)?.status, 'pending');
  assert.equal(
    getUtterance(h.db, first)?.attempts,
    1,
    'одна попытка на обнаружение пропажи — дальше очередь стоит',
  );
  assert.equal(getUtterance(h.db, second)?.attempts, 0);

  cli.restore();
  await worker.tick(); // проба увидит вернувшийся CLI
  await worker.tick();
  await worker.tick();

  assert.equal(getUtterance(h.db, first)?.status, 'done', 'после возвращения CLI разобрали');
  assert.equal(getUtterance(h.db, second)?.status, 'done');
});

/* ------------------------------------------------------------------ */
/* Разгребание после простоя                                           */
/* ------------------------------------------------------------------ */

test('CLI ожил: очередь разгребается в хронологическом порядке, ровно по разу на фразу', async (t) => {
  const cli = fakeCli(t);
  const h = await makeTestApp({ CLAUDE_BIN: cli.bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx, { reprobeMs: 0 });
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  cli.remove(); // claude снесли с сервера
  await worker.tick();

  // Пока CLI лежит, копится поток фраз — как ночью с новорождённым.
  const ids: [number, number, number, number] = [
    say(h.db, 'заснул'),
    say(h.db, 'проснулся'),
    say(h.db, 'покушал сто'),
    say(h.db, 'поменяли подгузник'),
  ];
  // Разносим по времени, чтобы порядок был именно хронологическим, а не «как повезло».
  ids.forEach((id, i) => backdate(h.db, id, 40 - i * 5));

  const runsDuringOutage = cli.runs();
  for (let i = 0; i < 15; i++) await worker.tick();
  assert.equal(cli.runs(), runsDuringOutage, 'накопление очереди не стоит вызовов');

  cli.restore();
  for (let i = 0; i < 10; i++) await worker.tick();

  const order = cli.order();
  assert.deepEqual(order, ids, 'разобрано в порядке прихода фраз, без перестановок');
  for (const id of ids) {
    assert.equal(getUtterance(h.db, id)?.status, 'done', `фраза ${id} разобрана`);
  }
  // Головная фраза оплатила обнаружение пропажи одной попыткой, остальные — нет.
  assert.ok((getUtterance(h.db, ids[0])?.attempts ?? 0) <= 2);
  for (const id of ids.slice(1)) {
    assert.equal(getUtterance(h.db, id)?.attempts, 1, 'на остальных простой не сказался');
  }

  // Разгребли — и остановились. Само себя это не переоткрывает.
  const runsAfter = cli.runs();
  for (let i = 0; i < 10; i++) await worker.tick();
  assert.equal(cli.runs(), runsAfter, 'пустая очередь не порождает новых вызовов');
});

test('живой CLI: число запусков модели равно числу фраз, ни больше ни меньше', async (t) => {
  const cli = fakeCli(t);
  const h = await makeTestApp({ CLAUDE_BIN: cli.bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  for (let i = 0; i < 5; i++) say(h.db, `фраза номер ${i}`);
  for (let i = 0; i < 20; i++) await worker.tick();

  assert.equal(cli.runs(), 5, 'пять фраз — пять вызовов модели');
});

/* ------------------------------------------------------------------ */
/* Рестарт сервера                                                     */
/* ------------------------------------------------------------------ */

test('рестарт сервера с непустой очередью: ничего не потеряно, счётчик попыток не обнулён', async (t) => {
  const cli = fakeCli(t);
  const h = await makeTestApp({ CLAUDE_BIN: cli.bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const ids: [number, number, number] = [
    say(h.db, 'заснул в девять'),
    say(h.db, 'проснулся'),
    say(h.db, 'покушал'),
  ];
  const head = ids[0];

  // Фраза, которую сервер успел взять в работу и не довёл (падение посреди разбора),
  // плюс уже потраченная на ней попытка.
  const claimed = claimNextPending(h.db);
  assert.equal(claimed?.id, head);
  assert.equal(getUtterance(h.db, head)?.status, 'processing');
  assert.equal(getUtterance(h.db, head)?.attempts, 1);

  // «Рестарт»: новый воркер поверх той же базы.
  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  assert.equal(
    getUtterance(h.db, head)?.status,
    'pending',
    'зависшая в processing вернулась в очередь',
  );
  assert.equal(
    getUtterance(h.db, head)?.attempts,
    1,
    'счётчик попыток пережил рестарт: обнулять его — значит открыть вечный круг',
  );

  for (let i = 0; i < 10; i++) await worker.tick();

  assert.deepEqual(cli.order(), ids, 'после рестарта разобрано всё и по порядку');
  assert.equal(cli.runs(), 3, 'рестарт не добавил лишних вызовов');
});

/* ------------------------------------------------------------------ */
/* Конечность: настоящая ошибка разбора                                */
/* ------------------------------------------------------------------ */

test('настоящая ошибка три раза подряд: failed, и автоматика к фразе больше не возвращается', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'claude');
  // CLI жив (--version работает), но разбор падает не по авторизации и не по лимиту.
  fs.writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (fake)"; exit 0; fi
echo "run" >> "${log}"
echo "internal error: разбор сломался" >&2
exit 2
`,
    { mode: 0o755 },
  );
  const runs = (): number =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;

  const h = await makeTestApp({ CLAUDE_BIN: bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  const id = say(h.db, 'фраза, на которой разбор падает');

  for (let i = 0; i < 30; i++) await worker.tick();

  const row = getUtterance(h.db, id);
  assert.equal(row?.status, 'failed', 'три настоящие ошибки — терминальный failed');
  assert.equal(row?.attempts, 3);
  assert.equal(runs(), 3, 'ровно три вызова модели, а не бесконечный круг');
  assert.match(row?.llm_error ?? '', /разбор сломался/);

  // Ни рестарт, ни ожившая очередь не возвращают failed в работу сами.
  const worker2 = createWorker(h.ctx);
  t.after(() => worker2.stop());
  worker2.start();
  await worker2.ready();
  for (let i = 0; i < 10; i++) await worker2.tick();

  assert.equal(getUtterance(h.db, id)?.status, 'failed', 'рестарт failed не воскрешает');
  assert.equal(runs(), 3, 'и не добавляет вызовов');
  assert.equal(worker2.status().queueDepth, 0, 'очередь пуста: фраза не крутится в ней');
});

test('проба врёт («--version» жив, разбор падает 401): круг конечен и пауза растёт', async (t) => {
  const cli = fakeCli(t);
  const h = await makeTestApp({ CLAUDE_BIN: cli.bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  // reprobeMs = 0 выключает паузу целиком: остаётся ХУДШИЙ случай, когда
  // воркер проверяет CLI на каждом тике. Даже в нём круг обязан кончиться.
  const worker = createWorker(h.ctx, { reprobeMs: 0 });
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  cli.breakAuth();
  const ids = [say(h.db, 'заснул'), say(h.db, 'покушал')];

  for (let i = 0; i < 100; i++) await worker.tick();

  for (const id of ids) {
    const row = getUtterance(h.db, id);
    assert.equal(row?.status, 'failed', 'фраза пришла в терминальный статус, а не крутится');
    assert.equal(row?.attempts, 3, 'ровно три попытки, счётчик живёт в базе');
    // failed — статус, ВИДИМЫЙ человеку в админке (в отличие от прежнего skipped).
    assert.match(row?.llm_error ?? '', /authenticate/i, 'причина сохранена');
  }
  assert.equal(cli.runs(), 6, 'сто тиков стоили ровно 3 попытки × 2 фразы, а не ста вызовов');
  assert.equal(worker.status().queueDepth, 0, 'очередь пуста: ничего не крутится по кругу');
});

test('пауза между проверками CLI растёт только на ложных «ожил»', () => {
  // Проба падает (CLI честно нет) — проверяем часто, это ничего не стоит.
  assert.equal(probeIntervalMs(REPROBE_MS, 0), REPROBE_MS);
  // Проба прошла, а разбор упал — удваиваем: 10 мин, 20, 40...
  assert.equal(probeIntervalMs(REPROBE_MS, 1), 2 * REPROBE_MS);
  assert.equal(probeIntervalMs(REPROBE_MS, 3), 8 * REPROBE_MS);
  // ...и упираемся в потолок: реже раза в час проверять незачем.
  assert.equal(probeIntervalMs(REPROBE_MS, 10), PROBE_BACKOFF_MAX_MS);
  assert.equal(probeIntervalMs(REPROBE_MS, 1000), PROBE_BACKOFF_MAX_MS);
});

test('ЛИМИТ подписки: ожидание окна не стоит ни одного нового запуска', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-rl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (fake)"; exit 0; fi
echo "run" >> "${log}"
echo 'Claude usage limit reached. Your limit will reset at 3pm.' >&2
exit 1
`,
    { mode: 0o755 },
  );
  const runs = (): number =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;

  const h = await makeTestApp({ CLAUDE_BIN: bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  const id = say(h.db, 'удали последний сон');
  await worker.tick();

  assert.equal(runs(), 1, 'один запуск — им и узнали про лимит');
  assert.equal(getUtterance(h.db, id)?.status, 'pending', 'фраза ждёт окна');
  assert.equal(getUtterance(h.db, id)?.attempts, 0, 'попытка не израсходована (поведение §9.4)');

  for (let i = 0; i < 25; i++) await worker.tick();
  assert.equal(runs(), 1, 'пока окно закрыто, в CLI не стучимся вовсе');
  assert.equal(getUtterance(h.db, id)?.attempts, 0);
  assert.equal(worker.status().rateLimited, true);
});

/* ------------------------------------------------------------------ */
/* Время: фраза, пролежавшая в очереди                                 */
/* ------------------------------------------------------------------ */

test('фраза, пролежавшая час, разбирается по времени, КОГДА ЕЁ СКАЗАЛИ', async (t) => {
  const cli = fakeCli(t);
  const h = await makeTestApp({ CLAUDE_BIN: cli.bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  const id = say(h.db, 'он только что покушал');
  backdate(h.db, id, 60);
  const saidAt = getUtterance(h.db, id)?.received_at ?? '';

  await worker.tick();

  const prompt = cli.lastPrompt();
  assert.ok(prompt.length > 0, 'промпт доехал до CLI');
  assert.match(prompt, /ФРАЗА СКАЗАНА/, 'в промпте есть момент прихода фразы');
  assert.ok(
    prompt.includes(saidAt),
    `в промпте должен стоять момент фразы ${saidAt}, а не момент разбора`,
  );
  assert.match(prompt, /точка отсчёта/i, 'сказано, что считать надо от него');
  assert.match(prompt, /РАЗБОР ЗАПОЗДАЛ на 1 ч/, 'модели прямо сказано, что разбор запоздал');
  assert.match(
    prompt,
    /времена по этой фразе — от МОМЕНТА ФРАЗЫ/,
    'и что времена берутся от момента фразы, а не от текущего',
  );
});

test('свежая фраза: блока про опоздание нет, промпт не разрастается на ровном месте', async (t) => {
  const cli = fakeCli(t);
  const h = await makeTestApp({ CLAUDE_BIN: cli.bin, WORKER_ENABLED: 'true' });
  t.after(() => h.close());

  const worker = createWorker(h.ctx);
  t.after(() => worker.stop());
  worker.start();
  await worker.ready();

  say(h.db, 'андрей заснул');
  await worker.tick();

  const prompt = cli.lastPrompt();
  assert.match(prompt, /ФРАЗА СКАЗАНА/);
  assert.doesNotMatch(prompt, /РАЗБОР ЗАПОЗДАЛ/, 'обычный разбор о задержке не читает');
});
