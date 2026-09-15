/** §4 контракта: плотное покрытие детерминированного матчера. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFast, normalize, resolveYandexDateTime } from '../src/fastpath.ts';
import type { AliceNlu } from '../src/types.ts';

const TZ = 'Europe/Moscow';
/** 2026-09-15 17:32 по Москве. */
const NOW = new Date('2026-09-15T14:32:00.000Z');

const match = (command: string, nlu?: AliceNlu) => matchFast(command, nlu, { now: NOW, tz: TZ });

/* ------------------------------------------------------------------ */

test('нормализация: регистр, ё, пунктуация, лишние пробелы', () => {
  assert.equal(normalize('  Андрей   ЗАСНУЛ!!! '), 'андрей заснул');
  assert.equal(normalize('Ещё НЕ проснулся...'), 'еще не проснулся');
  assert.equal(normalize('Бай-бай'), 'бай бай');
  assert.equal(normalize(''), '');
  assert.equal(normalize('   '), '');
  assert.equal(normalize('?!.,'), '');
});

test('«ё» и «е» дают один результат', () => {
  assert.deepEqual(match('он ещё не проснулся'), match('он еще не проснулся'));
  assert.equal(match('подъём').kind, 'sleep_end');
  assert.equal(match('подъем').kind, 'sleep_end');
});

/* ------------------------------------------------------------------ */

test('sleep_start: все синонимы засыпания', () => {
  const phrases = [
    'андрей заснул',
    'заснула',
    'он уснул',
    'уснула наконец',
    'андрей спит',
    'засыпает',
    'уложили',
    'уложил андрея',
    'положили спать',
    'пошёл спать',
    'спать пошел',
    'лёг спать',
    'спатки',
    'отрубился',
    'вырубился',
    'задрых',
    'дрыхнет',
    'баиньки',
    'бай-бай',
  ];
  for (const phrase of phrases) {
    const res = match(phrase);
    assert.equal(res.kind, 'sleep_start', `ожидался sleep_start для «${phrase}», получено ${res.kind}`);
    assert.ok('confidence' in res && res.confidence > 0.5, `низкая уверенность для «${phrase}»`);
  }
});

test('sleep_end: все синонимы пробуждения', () => {
  const phrases = [
    'андрей проснулся',
    'проснулась',
    'просыпается',
    'встал',
    'встала',
    'разбудили',
    'андрей не спит',
    'уже не спит',
    'глаза открыл',
    'открыл глаза',
    'пробудился',
    'подъем',
  ];
  for (const phrase of phrases) {
    const res = match(phrase);
    assert.equal(res.kind, 'sleep_end', `ожидался sleep_end для «${phrase}», получено ${res.kind}`);
  }
});

test('регистр не влияет на разбор', () => {
  assert.equal(match('АНДРЕЙ ЗАСНУЛ').kind, 'sleep_start');
  assert.equal(match('Андрей Проснулся').kind, 'sleep_end');
  assert.equal(match('сТоП').kind, 'exit');
});

/* ------------------------------------------------------------------ */

test('отрицания уходят в unknown, а не угадываются', () => {
  const phrases = [
    'не заснул',
    'андрей не заснул',
    'ещё не проснулся',
    'еще не проснулся',
    'он так и не уснул',
    'не проснулся',
    'нет он не уснул',
  ];
  for (const phrase of phrases) {
    assert.equal(
      match(phrase).kind,
      'unknown',
      `отрицание «${phrase}» должно давать unknown`,
    );
  }
});

test('«не спит» — это пробуждение, а не отрицание (§4)', () => {
  assert.equal(match('андрей не спит').kind, 'sleep_end');
  assert.equal(match('он больше не спит').kind, 'sleep_end');
});

/* ------------------------------------------------------------------ */

test('query_state: вопросы о состоянии', () => {
  const phrases = [
    'сколько он сегодня спал',
    'сколько спал',
    'сколько проспал',
    'как спал',
    'как он спит',
    'что там',
    'статус',
    'как дела',
    'отчёт',
    'сводка',
    'сколько сегодня',
  ];
  for (const phrase of phrases) {
    const res = match(phrase);
    assert.equal(res.kind, 'query_state', `ожидался query_state для «${phrase}», получено ${res.kind}`);
  }
});

/* ------------------------------------------------------------------ */

test('exit: команды выхода', () => {
  for (const phrase of ['хватит', 'стоп', 'выход', 'пока', 'отмена', 'закончили', 'до свидания', 'всё хватит']) {
    assert.equal(match(phrase).kind, 'exit', `ожидался exit для «${phrase}»`);
  }
});

test('«пока» внутри содержательной фразы не считается выходом', () => {
  assert.equal(match('пока спит').kind, 'sleep_start');
});

/* ------------------------------------------------------------------ */

test('мусор и пустая строка -> unknown', () => {
  for (const phrase of ['', '   ', '?!', 'ага', 'кхм', 'алиса', 'абырвалг', 'погода в москве']) {
    assert.equal(match(phrase).kind, 'unknown', `ожидался unknown для «${phrase}»`);
  }
});

test('matchFast — чистая функция: повторный вызов даёт тот же результат', () => {
  const a = match('андрей заснул');
  const b = match('андрей заснул');
  assert.deepEqual(a, b);
});

/* ------------------------------------------------------------------ */
/* YANDEX.DATETIME                                                     */
/* ------------------------------------------------------------------ */

function dtNlu(value: Record<string, unknown>): AliceNlu {
  return { tokens: [], entities: [{ type: 'YANDEX.DATETIME', value }], intents: {} };
}

test('YANDEX.DATETIME: относительное время «полчаса назад»', () => {
  const res = match('заснул полчаса назад', dtNlu({ minute: -30, minute_is_relative: true }));
  assert.equal(res.kind, 'sleep_start');
  assert.ok('at' in res && res.at);
  assert.equal(res.at, '2026-09-15T14:02:00.000Z');
});

test('YANDEX.DATETIME: абсолютный час «в три» (ночью, уже прошёл)', () => {
  const res = match('проснулся в три', dtNlu({ hour: 3, hour_is_relative: false }));
  assert.equal(res.kind, 'sleep_end');
  // 03:00 по Москве = 00:00 UTC того же дня
  assert.equal('at' in res ? res.at : null, '2026-09-15T00:00:00.000Z');
});

test('YANDEX.DATETIME: час в будущем трактуется как прошедшие сутки', () => {
  const res = match('заснул в 20 часов', dtNlu({ hour: 20, hour_is_relative: false }));
  // 20:00 МСК сегодня = 17:00Z, это позже «сейчас» (14:32Z) -> вчера
  assert.equal('at' in res ? res.at : null, '2026-09-14T17:00:00.000Z');
});

test('YANDEX.DATETIME: часы и минуты вместе', () => {
  const res = match(
    'заснул в 16:05',
    dtNlu({ hour: 16, hour_is_relative: false, minute: 5, minute_is_relative: false }),
  );
  assert.equal('at' in res ? res.at : null, '2026-09-15T13:05:00.000Z');
});

test('YANDEX.DATETIME: относительный день «вчера»', () => {
  const res = match(
    'заснул вчера в 21',
    dtNlu({ day: -1, day_is_relative: true, hour: 21, hour_is_relative: false }),
  );
  assert.equal('at' in res ? res.at : null, '2026-09-14T18:00:00.000Z');
});

test('YANDEX.DATETIME: пустое значение игнорируется', () => {
  const res = match('андрей заснул', dtNlu({}));
  assert.equal(res.kind, 'sleep_start');
  assert.ok(!('at' in res && res.at));
});

test('без сущностей поле at не появляется', () => {
  const res = match('андрей заснул');
  assert.equal('at' in res && res.at !== undefined, false);
});

test('resolveYandexDateTime: относительные часы', () => {
  assert.equal(
    resolveYandexDateTime({ hour: -2, hour_is_relative: true }, NOW, TZ),
    '2026-09-15T12:32:00.000Z',
  );
});

test('некорректный nlu не ломает матчер', () => {
  assert.equal(matchFast('заснул', undefined, { now: NOW, tz: TZ }).kind, 'sleep_start');
  assert.equal(
    matchFast('заснул', { entities: null as never }, { now: NOW, tz: TZ }).kind,
    'sleep_start',
  );
  assert.equal(
    matchFast('заснул', { entities: [{ type: 'YANDEX.DATETIME' }] }, { now: NOW, tz: TZ }).kind,
    'sleep_start',
  );
});
