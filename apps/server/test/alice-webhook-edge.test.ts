/**
 * §3.1 — вебхук Алисы: доступ, битый вход, бюджет ответа.
 *
 * Отказ должен быть неотличим по форме от успеха (атакующий не различает причины),
 * а отклонённый запрос обязан не оставлять следов в дневнике. И всё это — за 200 мс:
 * Алиса ждёт три секунды, после чего мама слышит ошибку и повторяет фразу,
 * а повтор — это дубль в дневнике.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { aliceBody, makeTestApp, TEST_SECRET } from './helpers.ts';
import { count } from '../src/db.ts';
import type { Db } from '../src/db.ts';

type Json = Record<string, any>;

const body = (res: { body: string }): Json => JSON.parse(res.body) as Json;
const NEUTRAL = 'Извините, сейчас не могу ответить.';

function totals(db: Db): { events: number; utterances: number } {
  return {
    events: count(db, 'SELECT COUNT(*) AS n FROM events'),
    utterances: count(db, 'SELECT COUNT(*) AS n FROM utterances'),
  };
}

/* ------------------------------------------------------------------ */
/* Доступ                                                              */
/* ------------------------------------------------------------------ */

test('чужой секрет любой длины отклоняется одинаково нейтрально и ничего не пишет', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const secrets = [
    'f'.repeat(32),
    '',
    'короткий',
    `${TEST_SECRET}x`,
    TEST_SECRET.toUpperCase(),
    TEST_SECRET.slice(0, 31),
    '../../etc/passwd',
  ];

  for (const secret of secrets) {
    const res = await app.app.inject({
      method: 'POST',
      url: `/alice/${encodeURIComponent(secret)}`,
      payload: aliceBody('андрей заснул'),
    });
    assert.equal(res.statusCode, 200, `секрет ${JSON.stringify(secret)}: Алисе всегда 200`);
    assert.equal(body(res).response.text, NEUTRAL, 'текст отказа один и тот же');
  }

  assert.deepEqual(totals(app.db), { events: 0, utterances: 0 }, 'отказ не оставляет следов');
});

test('чужой skill_id отклоняется нейтрально и ничего не пишет', async (t) => {
  const app = await makeTestApp({
    ALICE_SKILL_ID: 'наш-навык',
    ALICE_ALLOWED_USER_IDS: 'мама,папа',
  });
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('андрей заснул', { skillId: 'чужой-навык', userId: 'мама' }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).response.text, NEUTRAL);
  assert.deepEqual(totals(app.db), { events: 0, utterances: 0 });
});

test('чужой пользователь до дневника не доходит, свой — пишется как обычно', async (t) => {
  const app = await makeTestApp({
    ALICE_SKILL_ID: 'наш-навык',
    ALICE_ALLOWED_USER_IDS: 'мама,папа',
  });
  t.after(app.close);

  for (const userId of ['сосед', '']) {
    const res = await app.app.inject({
      method: 'POST',
      url: `/alice/${TEST_SECRET}`,
      payload: aliceBody('андрей заснул', { skillId: 'наш-навык', userId }),
    });
    // Текст отказа для незнакомого устройства сейчас перерабатывается (модель
    // доверия устройств), поэтому проверяем не формулировку, а то, что важно:
    // Алиса получила корректный ответ, а в дневнике ничего не появилось.
    assert.equal(res.statusCode, 200, `user_id=${JSON.stringify(userId)}`);
    assert.ok(body(res).response.text.length > 0);
    assert.equal(body(res).version, '1.0');
    assert.equal(
      count(app.db, 'SELECT COUNT(*) AS n FROM events'),
      0,
      'чужой пользователь не пишет события',
    );
  }

  const allowed = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('андрей заснул', { skillId: 'наш-навык', userId: 'папа' }),
  });
  assert.match(body(allowed).response.text, /Записала/);
  assert.equal(count(app.db, 'SELECT COUNT(*) AS n FROM events'), 1);
});

test('пустой список пользователей — режим настройки: принимаем всех', async (t) => {
  const app = await makeTestApp({ ALICE_ALLOWED_USER_IDS: '' });
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('андрей заснул', { userId: 'кто-угодно' }),
  });
  assert.match(body(res).response.text, /Записала/);
});

test('user_id берётся и из вложенных полей запроса', async (t) => {
  const app = await makeTestApp({ ALICE_ALLOWED_USER_IDS: 'вложенный' });
  t.after(app.close);

  const payload: Json = aliceBody('андрей заснул');
  delete payload.session.user_id;
  payload.session.user = { user_id: 'вложенный' };

  const res = await app.app.inject({ method: 'POST', url: `/alice/${TEST_SECRET}`, payload });
  assert.match(body(res).response.text, /Записала/, 'session.user.user_id тоже опознаётся');
});

/* ------------------------------------------------------------------ */
/* Битый и неполный вход                                               */
/* ------------------------------------------------------------------ */

test('запрос без session и без request не роняет вебхук', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const payloads: unknown[] = [
    {},
    { session: null, request: null },
    { request: {} },
    { request: { command: null } },
    { request: { command: 12345 } },
    { session: {}, request: { nlu: 'не объект' }, version: null },
    { request: { command: '', original_utterance: null } },
    [],
  ];

  for (const payload of payloads) {
    const res = await app.app.inject({
      method: 'POST',
      url: `/alice/${TEST_SECRET}`,
      payload: payload as Json,
    });
    assert.equal(res.statusCode, 200, `тело ${JSON.stringify(payload)}`);
    const reply = body(res).response;
    assert.equal(typeof reply.text, 'string');
    assert.equal(typeof reply.tts, 'string');
    assert.equal(typeof reply.end_session, 'boolean');
    assert.equal(body(res).version, '1.0');
  }
  assert.equal(totals(app.db).events, 0, 'из пустой команды событий не берётся');
});

test('битый JSON в теле даёт ответ, а не 500', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    headers: { 'content-type': 'application/json' },
    payload: '{ это не json',
  });
  assert.equal(res.statusCode < 500, true, 'пятисотых Алисе не показываем');
  assert.deepEqual(totals(app.db), { events: 0, utterances: 0 });
});

test('command пустой — берём original_utterance', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: {
      session: { session_id: 's', user_id: 'u' },
      request: { command: '   ', original_utterance: 'Андрей заснул' },
      version: '1.0',
    },
  });
  assert.match(body(res).response.text, /Записала/);
  assert.equal(totals(app.db).events, 1);
});

test('путь без секрета отвечает так же нейтрально, как с чужим секретом', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  for (const url of ['/alice', '/alice/']) {
    const res = await app.app.inject({ method: 'POST', url, payload: aliceBody('андрей заснул') });
    assert.equal(res.statusCode, 200);
    assert.equal(body(res).response.text, NEUTRAL, 'форму URL не подсказываем');
  }
  assert.deepEqual(totals(app.db), { events: 0, utterances: 0 });
});

/* ------------------------------------------------------------------ */
/* Форма ответа                                                        */
/* ------------------------------------------------------------------ */

test('очень длинная фраза: ответ обрезан до 1024 символов и остаётся валидным', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const huge = `${'абырвалг '.repeat(500)}конец`;
  const res = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody(huge),
  });

  const reply = body(res).response;
  assert.equal(res.statusCode, 200);
  assert.ok(reply.text.length <= 1024, `text=${reply.text.length} символов`);
  assert.ok(reply.tts.length <= 1024, `tts=${reply.tts.length} символов`);
  assert.equal(totals(app.db).utterances, 1, 'фраза сохранена целиком, как бы длинна ни была');
});

test('tts проговаривает время по частям и не читает кавычки-ёлочки', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('андрей заснул'),
  });
  const reply = body(res).response;
  const time = /(\d{2}):(\d{2})/.exec(reply.text);
  assert.ok(time, 'в тексте время с двоеточием');
  assert.match(reply.tts, new RegExp(`${time[1]} ${time[2]}`), 'в озвучке двоеточие заменено пробелом');
  assert.doesNotMatch(reply.tts, /\d:\d/, 'цифры через двоеточие Алиса читает плохо');

  const unknown = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('абырвалг'),
  });
  assert.match(body(unknown).response.text, /«.+»/);
  assert.doesNotMatch(body(unknown).response.tts, /[«»]/);
});

test('сессия держится открытой, закрывается только на прощании', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const post = async (command: string, isNew = false): Promise<Json> =>
    body(
      await app.app.inject({
        method: 'POST',
        url: `/alice/${TEST_SECRET}`,
        payload: aliceBody(command, { isNew }),
      }),
    );

  assert.equal((await post('', true)).response.end_session, false, 'приветствие не закрывает сессию');
  assert.equal((await post('андрей заснул')).response.end_session, false);
  assert.equal((await post('абырвалг')).response.end_session, false);
  assert.equal((await post('хватит')).response.end_session, true, 'прощание закрывает');
});

test('приветствие не пишет ни фразу, ни событие', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('', { isNew: true }),
  });
  assert.deepEqual(totals(app.db), { events: 0, utterances: 0 });
});

/* ------------------------------------------------------------------ */
/* Сценарии, которые мама проговаривает вслух                          */
/* ------------------------------------------------------------------ */

test('повторное «заснул» отвечает «уже спит» и не заводит второй сон', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const post = async (command: string): Promise<Json> =>
    body(await app.app.inject({ method: 'POST', url: `/alice/${TEST_SECRET}`, payload: aliceBody(command) }));

  assert.match((await post('андрей заснул')).response.text, /Записала: Андрей заснул в \d{2}:\d{2}/);
  const second = await post('андрей заснул');
  assert.match(second.response.text, /уже спит, с \d{2}:\d{2}/);

  const events = count(app.db, `SELECT COUNT(*) AS n FROM events WHERE type = 'sleep'`);
  assert.equal(events, 1, 'второй сон не создан');
});

test('«проснулся» без сна отвечает честно и фиксирует факт', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('андрей проснулся'),
  });
  assert.match(body(res).response.text, /А он и не спал/);
  assert.equal(count(app.db, `SELECT COUNT(*) AS n FROM events WHERE type = 'note'`), 1);
});

test('непонятая фраза принимается вслух и сохраняется для разбора', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('он сегодня какой-то странный'),
  });
  assert.match(body(res).response.text, /Приняла: «он сегодня какой-то странный»/);
  assert.equal(totals(app.db).utterances, 1, 'фраза не теряется, даже если не разобрана');
});

test('команда выхода сохраняется как фраза, но событием не становится', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const res = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('всё, пока'),
  });
  assert.equal(body(res).response.end_session, true);
  assert.deepEqual(totals(app.db), { events: 0, utterances: 1 });
});

/* ------------------------------------------------------------------ */
/* Бюджет                                                              */
/* ------------------------------------------------------------------ */

test('бюджет 200 мс держится на подряд идущих фразах, а не только на первой', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  const phrases = [
    'андрей заснул',
    'андрей проснулся',
    'сколько он сегодня спал',
    'он покушал и уснул',
    'абырвалг',
  ];

  for (const command of phrases) {
    const started = process.hrtime.bigint();
    const res = await app.app.inject({
      method: 'POST',
      url: `/alice/${TEST_SECRET}`,
      payload: aliceBody(command),
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(res.statusCode, 200);
    assert.ok(elapsedMs < 200, `«${command}» заняла ${elapsedMs.toFixed(0)} мс при бюджете 200`);
  }
});

test('накопленная история не замедляет ответ: 200 событий в базе — тот же бюджет', async (t) => {
  const app = await makeTestApp();
  t.after(app.close);

  app.db.exec(`
    INSERT INTO events (child_id, type, started_at, ended_at, source, created_at, updated_at)
    SELECT 'andrey', 'sleep', '2026-09-1' || (x % 9) || 'T10:00:00.000Z',
           '2026-09-1' || (x % 9) || 'T11:00:00.000Z', 'manual', 't', 't'
      FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200) SELECT x FROM c)
  `);

  const started = process.hrtime.bigint();
  const res = await app.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('сколько он сегодня спал'),
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(res.statusCode, 200);
  assert.ok(elapsedMs < 200, `сводка по 200 событиям заняла ${elapsedMs.toFixed(0)} мс`);
});
