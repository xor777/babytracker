/**
 * §10.3 — `mayContainMore`.
 *
 * Это защита от ТИХОЙ ПОТЕРИ ДАННЫХ, а не косметика: без неё «Андрей покушал
 * и уснул» распознаётся как уверенный sleep_start (0.95), политика smart решает
 * не звать модель, и кормление исчезает молча — мама уверена, что записала.
 * Поэтому здесь проверяется и то, что признак срабатывает, и то, что он
 * доходит до решения об очереди.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMayContainMore,
  countNumbers,
  countSignificantWords,
  detectDomains,
  matchFast,
  normalize,
} from '../src/fastpath.ts';
import { decideQueue } from '../src/queue-policy.ts';
import { TEST_SECRET, aliceBody, makeTestApp } from './helpers.ts';
import { listUtterances } from '../src/utterances.ts';
import { ACK } from '../src/alice.ts';

const NOW = new Date('2026-09-15T14:00:00.000Z');
const match = (command: string) => matchFast(command, undefined, { now: NOW, tz: 'Europe/Moscow' });

function assertMore(command: string, expected: boolean): void {
  const res = match(command);
  assert.equal(
    res.mayContainMore,
    expected,
    `mayContainMore для «${command}» ожидался ${expected}, получено ${res.mayContainMore} (kind=${res.kind})`,
  );
}

/* ------------------------------------------------------------------ */
/* Обязательные случаи из §10.3                                        */
/* ------------------------------------------------------------------ */

test('составные фразы из контракта уходят модели', () => {
  assertMore('покушал и уснул', true);
  assertMore('Андрей покушал и уснул', true);
  assertMore('поменяли подгузник, покакал, и он опять заснул', true);
  assertMore('проснулся, поели грудью минут пятнадцать', true);
});

test('КОНТРОЛЬ: простые фразы модели НЕ уходят', () => {
  assertMore('андрей заснул', false);
  assertMore('андрей проснулся', false);
  assertMore('заснул', false);
  assertMore('проснулся', false);
  assertMore('уснул', false);
  assertMore('встал', false);
});

/* ------------------------------------------------------------------ */
/* Признаки по отдельности                                             */
/* ------------------------------------------------------------------ */

test('признак 1: союз или перечисление', () => {
  assertMore('заснул и поел', true);
  assertMore('поел а потом заснул', true);
  assertMore('заснул потом проснулся', true);
  assertMore('покормили затем уложили', true);
  assertMore('заснул после купания', true);
  assertMore('поспал плюс поел', true);
});

test('признак 1: запятая ловится, хотя нормализация её съедает', () => {
  assert.equal(normalize('заснул, проснулся').includes(','), false, 'запятой в нормализованной нет');
  assertMore('заснул, проснулся', true);
  assertMore('подгузник, сон', true);
});

test('признак 2: ключевое слово из другого домена', () => {
  assertMore('заснул после бутылочки', true);
  assertMore('уснул с грудью', true);
  assertMore('проснулся мокрый', true);
  assertMore('поспал взвесили', true);
  assertMore('уснул срыгнул', true);
  assertMore('уснул после купания', true);
  assertMore('дали витамин уснул', true);
});

test('признак 3: больше одного числа', () => {
  assertMore('поспал 30 минут 2 раза', true);
  assertMore('в 3 часа 15 минут', true);
  // одно число — само по себе не повод
  assertMore('поспал 30', false);
});

test('признак 4: длинная фраза', () => {
  assertMore('он сегодня утром довольно долго тихонько мирно сопел кроватке', true);
  // ровно шесть значимых слов — ещё не повод
  assert.ok(countSignificantWords(normalize('он сегодня утром довольно долго тихонько сопел')) <= 6);
});

test('слова-пустышки не раздувают длину фразы', () => {
  assert.equal(countSignificantWords(normalize('андрей сегодня уже он в на с заснул')), 1);
  assert.equal(countSignificantWords(normalize('заснул')), 1);
});

/* ------------------------------------------------------------------ */
/* Вспомогательные функции                                             */
/* ------------------------------------------------------------------ */

test('домены определяются по началу слова', () => {
  assert.deepEqual([...detectDomains(normalize('покормили из бутылочки'))].sort(), ['feed']);
  assert.deepEqual([...detectDomains(normalize('поменяли подгузник'))].sort(), ['diaper']);
  assert.deepEqual([...detectDomains(normalize('взвесили'))].sort(), ['measure']);
  assert.deepEqual([...detectDomains(normalize('срыгнул'))].sort(), ['symptom']);
  assert.deepEqual([...detectDomains(normalize('купали'))].sort(), ['activity']);
  assert.deepEqual([...detectDomains(normalize('сцедила'))].sort(), ['pump']);
  assert.deepEqual([...detectDomains(normalize('дали витамин'))].sort(), ['meds']);
  assert.ok(detectDomains(normalize('покушал и уснул')).has('feed'));
  assert.ok(detectDomains(normalize('покушал и уснул')).has('sleep'));
});

test('числа считаются и цифрами, и словами', () => {
  assert.equal(countNumbers(normalize('120 мл')), 1);
  assert.equal(countNumbers(normalize('минут пятнадцать')), 1);
  assert.equal(countNumbers(normalize('два раза по 30 минут')), 2);
  assert.equal(countNumbers(normalize('заснул')), 0);
  assert.equal(countNumbers(normalize('положили спать')), 0, '«положили» не число');
  assert.equal(countNumbers(normalize('стоп')), 0, '«стоп» не число');
});

test('computeMayContainMore учитывает уже распознанный домен', () => {
  // «спит» — домен sleep, он же распознан: не повод звать модель
  assert.equal(
    computeMayContainMore({ raw: 'спит', normalized: 'спит', recognizedDomain: 'sleep' }),
    false,
  );
  // тот же текст, но ничего не распознали — домен «другой», значит зовём
  assert.equal(
    computeMayContainMore({ raw: 'спит', normalized: 'спит', recognizedDomain: null }),
    true,
  );
});

test('пустая фраза не считается составной', () => {
  assertMore('', false);
  assertMore('   ', false);
});

test('выход и запрос состояния модели не адресуются', () => {
  assert.equal(match('хватит').mayContainMore, false);
  assert.equal(match('сколько он сегодня спал').mayContainMore, false);
  assert.equal(match('статус').mayContainMore, false);
});

/* ------------------------------------------------------------------ */
/* Связь с политикой очереди                                           */
/* ------------------------------------------------------------------ */

test('mayContainMore перебивает ЛЮБУЮ политику и уверенность', () => {
  const fast = match('покушал и уснул');
  assert.equal(fast.kind, 'sleep_start');
  assert.equal(fast.mayContainMore, true);
  assert.ok('confidence' in fast && fast.confidence >= 0.9, 'матчер уверен — и всё равно зовём');

  for (const policy of ['smart', 'all', 'unknown'] as const) {
    const decision = decideQueue({ policy, threshold: 0.8, fast, command: 'покушал и уснул' });
    assert.equal(decision.queue, true, `политика ${policy} не должна экономить на составной фразе`);
    // при policy=all причина другая, но фраза всё равно уходит модели
    if (policy !== 'all') assert.match(decision.reason, /ещё событие/);
  }
});

test('простая фраза по-прежнему экономит вызов модели', () => {
  const fast = match('андрей заснул');
  const decision = decideQueue({ policy: 'smart', threshold: 0.8, fast, command: 'андрей заснул' });
  assert.equal(decision.queue, false);
});

/* ------------------------------------------------------------------ */
/* Сквозная проверка через вебхук                                      */
/* ------------------------------------------------------------------ */

test('СКВОЗНОЕ: составная фраза попадает в очередь, простая — нет', async (t) => {
  const h = await makeTestApp({ LLM_QUEUE_POLICY: 'smart' });
  t.after(() => h.close());

  const post = (command: string) =>
    h.app.inject({ method: 'POST', url: `/alice/${TEST_SECRET}`, payload: aliceBody(command) });

  const simple = await post('андрей заснул');
  assert.equal((simple.json() as { response: { text: string } }).response.text, ACK);

  const compound = await post('андрей покушал и уснул');
  // голосовой ответ остаётся мгновенным и по тому, что понял fast-path
  assert.match(
    (compound.json() as { response: { text: string } }).response.text,
    new RegExp(`^${ACK}$`),
    'мама получает нормальный ответ, а не «сейчас разберу»',
  );

  const queue = listUtterances(h.db);
  const byText = new Map(queue.map((u) => [u.raw_text, u]));

  assert.equal(byText.get('андрей заснул')?.status, 'skipped', 'простая фраза модель не тревожит');
  assert.equal(
    byText.get('андрей покушал и уснул')?.status,
    'pending',
    'составная фраза ОБЯЗАНА уйти модели, иначе кормление потеряется молча',
  );
});

test('СКВОЗНОЕ: кормление из составной фразы не теряется бесследно', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  await h.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('поменяли подгузник, покакал, и он опять заснул'),
  });

  const utterance = listUtterances(h.db)[0];
  assert.equal(utterance?.status, 'pending');
  const fast = JSON.parse(utterance?.fast_result ?? '{}') as { mayContainMore?: boolean };
  assert.equal(fast.mayContainMore, true, 'признак сохраняется в очереди и виден в дашборде');
});
