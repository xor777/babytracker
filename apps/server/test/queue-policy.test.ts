/** §9.4: кого и когда пускаем к модели. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideQueue } from '../src/queue-policy.ts';
import { looksLikeDataCommand, matchFast } from '../src/fastpath.ts';
import type { FastResult } from '../src/types.ts';

const SURE: FastResult = { kind: 'sleep_start', confidence: 0.95, mayContainMore: false, timeUnresolved: false };
const SHAKY: FastResult = { kind: 'sleep_end', confidence: 0.5, mayContainMore: false, timeUnresolved: false };
const UNKNOWN: FastResult = { kind: 'unknown', mayContainMore: false, timeUnresolved: false };

const decide = (fast: FastResult, command: string, policy: 'smart' | 'all' | 'unknown' = 'smart') =>
  decideQueue({ policy, threshold: 0.8, fast, command });

test('командные слова из §9.4 распознаются', () => {
  const phrases = [
    'удали последнюю запись',
    'удалить сон',
    'убери предыдущую запись',
    'отмени последнее',
    'исправь, он заснул в девять',
    'поправь время',
    'ты ошиблась',
    'верни как было',
    'сотри всё за сегодня',
    'замени время на девять',
    'не так записала',
  ];
  for (const phrase of phrases) {
    assert.equal(looksLikeDataCommand(phrase), true, `не распознано как команда: «${phrase}»`);
  }
});

test('обычные фразы командами не считаются', () => {
  for (const phrase of ['андрей заснул', 'проснулся', 'сколько он спал', 'хватит', '']) {
    assert.equal(looksLikeDataCommand(phrase), false, `ложное срабатывание: «${phrase}»`);
  }
});

test('smart: уверенный fast-path модель не зовёт', () => {
  const d = decide(SURE, 'андрей заснул');
  assert.equal(d.queue, false);
  assert.match(d.reason, /уверенно/);
});

test('smart: неуверенный fast-path зовёт модель', () => {
  assert.equal(decide(SHAKY, 'вроде встал').queue, true);
});

test('smart: непонятая фраза зовёт модель', () => {
  assert.equal(decide(UNKNOWN, 'абырвалг').queue, true);
});

test('команда правки перебивает любую уверенность матчера', () => {
  const d = decide(SURE, 'убери предыдущую запись, он не засыпал');
  assert.equal(d.queue, true, 'иначе «убери запись» молча проигнорируется');
  assert.match(d.reason, /команд/);

  // и даже в самом экономном режиме
  assert.equal(decide(SURE, 'отмени последнее', 'unknown').queue, true);
});

test('policy=all зовёт модель на всё', () => {
  assert.equal(decide(SURE, 'андрей заснул', 'all').queue, true);
  assert.equal(decide(UNKNOWN, 'что-то', 'all').queue, true);
});

test('policy=unknown зовёт модель только на непонятое', () => {
  assert.equal(decide(SURE, 'андрей заснул', 'unknown').queue, false);
  assert.equal(decide(SHAKY, 'вроде встал', 'unknown').queue, false);
  assert.equal(decide(UNKNOWN, 'абырвалг', 'unknown').queue, true);
});

test('порог уверенности соблюдается на границе', () => {
  const at = decideQueue({
    policy: 'smart',
    threshold: 0.8,
    fast: { kind: 'sleep_start', confidence: 0.8, mayContainMore: false, timeUnresolved: false },
    command: 'заснул',
  });
  assert.equal(at.queue, false, '0.8 >= 0.8 — не зовём');

  const below = decideQueue({
    policy: 'smart',
    threshold: 0.8,
    fast: { kind: 'sleep_start', confidence: 0.79, mayContainMore: false, timeUnresolved: false },
    command: 'заснул',
  });
  assert.equal(below.queue, true);
});

test('реальные фразы fast-path + политика вместе', () => {
  const now = new Date('2026-09-15T14:00:00.000Z');
  const check = (command: string) =>
    decide(matchFast(command, undefined, { now, tz: 'Europe/Moscow' }), command);

  assert.equal(check('андрей заснул').queue, false, 'дешёвый путь для обычного случая');
  assert.equal(check('андрей проснулся').queue, false);
  assert.equal(check('покормили из бутылочки').queue, true, 'fast-path такое не знает');
  assert.equal(check('удали последний сон').queue, true);
  assert.equal(check('сколько он спал').queue, false, 'запрос состояния модель не требует');
});
