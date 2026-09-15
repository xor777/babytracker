/**
 * Белый список канонических фраз — пересмотр принципа после ТРЁХ инцидентов.
 *
 * Все три — одна и та же тихая потеря факта, каждый раз из-за дыры в списке
 * опасностей, который дописывали уже после происшествия:
 *
 *   1. «покушал и уснул»                        — не было правила про составные;
 *   2. «заснул полтора часа назад»              — не было правила про время;
 *   3. «что он закончил кушать когда лег спать» — «когда» не в списке связок,
 *      «кушать» не в стемах еды. ДВЕ дыры в одной фразе.
 *
 * Принцип перевёрнут: не «матчер уверен — не зовём модель», а «фраза совпала
 * с короткой канонической формой — не зовём». Незнакомое слово само по себе
 * отправляет фразу модели.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCanonical, matchFast } from '../src/fastpath.ts';
import { decideQueue } from '../src/queue-policy.ts';
import type { LlmQueuePolicy } from '../src/config.ts';
import { TEST_SECRET, aliceBody, makeTestApp } from './helpers.ts';
import { listUtterances } from '../src/utterances.ts';
import { queryEvents } from '../src/events.ts';

const NOW = new Date('2026-09-15T14:00:00.000Z');
const fastOf = (command: string) => matchFast(command, undefined, { now: NOW, tz: 'Europe/Moscow' });

function goesToModel(command: string, policy: LlmQueuePolicy = 'smart'): boolean {
  return decideQueue({ policy, threshold: 0.8, fast: fastOf(command), command }).queue;
}

function why(command: string): string {
  return decideQueue({ policy: 'smart', threshold: 0.8, fast: fastOf(command), command }).reason;
}

/* ------------------------------------------------------------------ */
/* Три инцидента                                                       */
/* ------------------------------------------------------------------ */

test('ИНЦИДЕНТ 1: «покушал и уснул» уходит модели', () => {
  assert.equal(goesToModel('покушал и уснул'), true);
  assert.equal(goesToModel('андрей покушал и уснул'), true);
});

test('ИНЦИДЕНТ 2: «заснул полтора часа назад» уходит модели', () => {
  assert.equal(goesToModel('андрей заснул полтора часа назад'), true);
  assert.equal(goesToModel('заснул полчаса назад'), true);
});

test('ИНЦИДЕНТ 3: «что он закончил кушать когда лег спать» уходит модели', () => {
  const phrase = 'что он закончил кушать когда лег спать';
  assert.equal(fastOf(phrase).kind, 'sleep_start', 'матчер по-прежнему отвечает голосом про сон');
  assert.equal(goesToModel(phrase), true, 'но окончательное решение о данных — за моделью');
});

test('связка «когда» и другие, которых в списке не было', () => {
  const phrases = [
    'уснул когда поел',
    'как только поел, сразу уснул',
    'пока ел, уснул',
    'поел, а потом уснул',
    'перед тем как уснуть поел',
    'и тут он уснул',
    'а сам уснул',
    'поел затем уснул',
    'уснул после того как поел',
  ];
  for (const phrase of phrases) {
    assert.equal(goesToModel(phrase), true, `«${phrase}» обязана уйти модели: ${why(phrase)}`);
  }
});

test('незнакомое слово само по себе отправляет фразу модели', () => {
  // Ровно тот механизм, которого не хватало все три раза: слова «кушать»,
  // «закончил», «наелся» матчеру неизвестны, и этого достаточно.
  for (const phrase of ['закончил кушать уснул', 'наелся уснул', 'докормлен уснул']) {
    const canon = checkCanonical(phrase, fastOf(phrase));
    assert.equal(canon.canonical, false, `«${phrase}» не должна считаться канонической`);
    assert.equal(goesToModel(phrase), true);
  }
});

/* ------------------------------------------------------------------ */
/* Контроль: смысл матчера не обнулён                                  */
/* ------------------------------------------------------------------ */

test('КОНТРОЛЬ: короткие канонические фразы модель НЕ тревожат', () => {
  const simple = [
    'андрей заснул',
    'проснулся',
    'покакал',
    'пописал',
    'уснул',
    'встал',
    'не спит',
    'спит',
    'положили спать',
    'андрей уже наконец заснул',
    'сколько он сегодня спал',
    'хватит',
  ];
  for (const phrase of simple) {
    assert.equal(goesToModel(phrase), false, `«${phrase}» не должна звать модель: ${why(phrase)}`);
  }
});

test('каноническая форма ограничена длиной и составом', () => {
  assert.equal(checkCanonical('андрей заснул', fastOf('андрей заснул')).canonical, true);
  // число — не каноническая форма
  assert.equal(checkCanonical('заснул 2 раза', fastOf('заснул 2 раза')).canonical, false);
  // вопрос — тоже
  assert.equal(checkCanonical('спит ли он', fastOf('спит ли он')).canonical, false);
  // длинная — тоже
  const long = 'он сегодня довольно долго тихонько мирно сопел в кроватке заснул';
  assert.equal(checkCanonical(long, fastOf(long)).canonical, false);
});

test('причина отказа объясняет, что именно помешало', () => {
  assert.match(why('закончил кушать уснул'), /незнаком/);
  assert.match(why('покушал и уснул'), /ещё событие/);
  assert.match(why('заснул полчаса назад'), /врем/);
  // вопрос матчер не понимает, и домен сна при нераспознанном виде сам по себе
  // поднимает «может быть ещё событие» — любая из причин уводит фразу к модели
  assert.equal(goesToModel('спит ли он'), true);
  assert.match(why('закончил кушать уснул'), /незнаком/);
});

/* ------------------------------------------------------------------ */
/* Подгузник: матчер закрывает его сам, иначе факт был бы потерян      */
/* ------------------------------------------------------------------ */

test('однословный подгузник записывается матчером и не зовёт модель', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const post = (command: string) =>
    h.app.inject({ method: 'POST', url: `/alice/${TEST_SECRET}`, payload: aliceBody(command) });

  const dirty = await post('покакал');
  assert.match((dirty.json() as { response: { text: string } }).response.text, /покакал/);

  const wet = await post('пописал');
  assert.match((wet.json() as { response: { text: string } }).response.text, /пописал/);

  const events = queryEvents(h.db, { type: 'diaper' });
  assert.equal(events.length, 2, 'оба подгузника записаны матчером');
  assert.deepEqual(events.map((e) => e.subtype).sort(), ['dirty', 'wet']);

  for (const u of listUtterances(h.db)) {
    assert.equal(u.status, 'skipped', 'однословный подгузник модель не требует');
  }
});

test('подгузник в составной фразе уходит модели', () => {
  assert.equal(goesToModel('покакал и уснул'), true);
  assert.equal(goesToModel('поменяли подгузник, покакал, и он опять заснул'), true);
});

/* ------------------------------------------------------------------ */
/* Политики                                                            */
/* ------------------------------------------------------------------ */

test('all зовёт модель на всё, unknown — только на непонятое', () => {
  assert.equal(goesToModel('андрей заснул', 'all'), true);
  assert.equal(goesToModel('андрей заснул', 'unknown'), false);
  assert.equal(goesToModel('абырвалг', 'unknown'), true);
});

test('жёсткие признаки опасности перебивают даже самый экономный режим', () => {
  // иначе unknown молча терял бы факты на составных фразах и на времени
  assert.equal(goesToModel('покушал и уснул', 'unknown'), true);
  assert.equal(goesToModel('заснул полчаса назад', 'unknown'), true);
  assert.equal(goesToModel('удали последнюю запись', 'unknown'), true);
});

/* ------------------------------------------------------------------ */
/* Сквозная проверка                                                   */
/* ------------------------------------------------------------------ */

test('СКВОЗНОЕ: фраза третьего инцидента попадает в очередь', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const res = await h.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('что он закончил кушать когда лег спать'),
  });

  // голосовой ответ по-прежнему мгновенный и от матчера
  assert.match((res.json() as { response: { text: string } }).response.text, /Записала|заснул/);

  const utterance = listUtterances(h.db)[0];
  assert.equal(utterance?.status, 'pending', 'фраза обязана уйти модели, иначе кормление потеряно');
  assert.equal(queryEvents(h.db, { type: 'sleep' }).length, 1, 'сон матчер записал сразу');
});
