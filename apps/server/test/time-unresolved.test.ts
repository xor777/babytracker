/**
 * §10.3 — неразрешённое время.
 *
 * Найдено на проде: «андрей заснул полтора часа назад» при пустом `nlu.entities`
 * записывалось на «сейчас» с confidence 0.95 и поэтому НЕ уходило модели.
 * Родитель видел правдоподобное, но неверное время, и ни в интерфейсе, ни в логе
 * не было ни одного признака ошибки. Тот же класс тихой порчи данных, что и
 * потерянное кормление в `mayContainMore`, но другая ветка.
 *
 * Правило: назвали время, а разобрать не смогли — матчер не вправе заявлять
 * высокую уверенность и обязан отдать фразу модели.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTimeReference, isTimeUnresolved, matchFast, normalize } from '../src/fastpath.ts';
import { decideQueue } from '../src/queue-policy.ts';
import type { AliceNlu } from '../src/types.ts';
import { TEST_SECRET, aliceBody, makeTestApp } from './helpers.ts';
import { listUtterances } from '../src/utterances.ts';
import { queryEvents } from '../src/events.ts';
import { ACK } from '../src/alice.ts';

const TZ = 'Europe/Moscow';
/** 2026-09-15 17:00 по Москве. */
const NOW = new Date('2026-09-15T14:00:00.000Z');

const EMPTY_NLU: AliceNlu = { tokens: [], entities: [], intents: {} };

const match = (command: string, nlu: AliceNlu = EMPTY_NLU) =>
  matchFast(command, nlu, { now: NOW, tz: TZ });

function dtNlu(value: Record<string, unknown>): AliceNlu {
  return { tokens: [], entities: [{ type: 'YANDEX.DATETIME', value }], intents: {} };
}

/** Фразы, где время названо словами. NLU на них может не выделить сущность. */
const PHRASES_WITH_TIME = [
  'андрей заснул полтора часа назад',
  'заснул полчаса назад',
  'заснул час назад',
  'уснул минут двадцать назад',
  'уснул пятнадцать минут назад',
  'проснулся в три',
  'заснул в 15',
  'проснулся только что',
  'заснул недавно',
  'заснул утром',
  'проснулся вечером',
  'проснулся ночью',
  'заснул днем',
  'уснул после обеда',
  'заснул перед ужином',
  'проснулся вчера поздно',
  'заснул в обед',
  'проснулся под утро',
];

/* ------------------------------------------------------------------ */
/* Воспроизведение прод-бага                                           */
/* ------------------------------------------------------------------ */

test('ПРОД-БАГ: «полтора часа назад» без сущностей больше не считается уверенным', () => {
  const res = match('андрей заснул полтора часа назад');

  assert.equal(res.kind, 'sleep_start', 'тип события матчер по-прежнему понимает');
  assert.equal('at' in res ? res.at : undefined, undefined, 'время разобрать не удалось');
  assert.equal(res.timeUnresolved, true, 'и матчер это признаёт');
  assert.ok(
    'confidence' in res && res.confidence < 0.8,
    `уверенность должна быть ниже порога, а она ${'confidence' in res ? res.confidence : '?'}`,
  );

  const decision = decideQueue({
    policy: 'smart',
    threshold: 0.8,
    fast: res,
    command: 'андрей заснул полтора часа назад',
  });
  assert.equal(decision.queue, true, 'фраза ОБЯЗАНА уйти модели');
  assert.match(decision.reason, /врем/i);
});

/* ------------------------------------------------------------------ */
/* Весь список формулировок                                            */
/* ------------------------------------------------------------------ */

test('пустые nlu.entities + слова времени -> уходит модели', () => {
  for (const phrase of PHRASES_WITH_TIME) {
    const res = match(phrase);
    assert.equal(res.timeUnresolved, true, `timeUnresolved должен быть true: «${phrase}»`);
    assert.ok(
      !('confidence' in res) || res.confidence < 0.8,
      `уверенность должна быть ниже порога: «${phrase}»`,
    );

    for (const policy of ['smart', 'all', 'unknown'] as const) {
      const decision = decideQueue({ policy, threshold: 0.8, fast: res, command: phrase });
      assert.equal(
        decision.queue,
        true,
        `политика ${policy} не должна экономить на «${phrase}» — время уедет молча`,
      );
    }
  }
});

test('время из YANDEX.DATETIME разобрано -> модель не нужна', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      'андрей заснул полтора часа назад',
      { hour: -1, hour_is_relative: true, minute: -30, minute_is_relative: true },
      '2026-09-15T12:30:00.000Z',
    ],
    ['заснул полчаса назад', { minute: -30, minute_is_relative: true }, '2026-09-15T13:30:00.000Z'],
    ['проснулся в три', { hour: 3, hour_is_relative: false }, '2026-09-15T00:00:00.000Z'],
    ['заснул час назад', { hour: -1, hour_is_relative: true }, '2026-09-15T13:00:00.000Z'],
  ];

  for (const [phrase, value, expectedAt] of cases) {
    const res = match(phrase, dtNlu(value));
    assert.equal('at' in res ? res.at : null, expectedAt, `время должно разобраться: «${phrase}»`);
    assert.equal(res.timeUnresolved, false, `«${phrase}»: время разобрано`);
    assert.ok('confidence' in res && res.confidence >= 0.9, `уверенность высокая: «${phrase}»`);
    assert.equal(
      decideQueue({ policy: 'unknown', threshold: 0.8, fast: res, command: phrase }).queue,
      false,
      'самый экономный режим на разобранном времени модель не зовёт',
    );

    // Под новым принципом (белый список канонических форм) фраза со временем
    // НЕ канонична даже с разобранным временем: «без чисел, без времени» —
    // часть определения простой формы. Матчер записывает событие с верным
    // временем сразу, а модель дополнительно проверяет, не потерян ли факт.
    const decision = decideQueue({ policy: 'smart', threshold: 0.8, fast: res, command: phrase });
    assert.equal(decision.queue, true, `фраза со временем уходит модели: «${phrase}»`);
  }
});

/* ------------------------------------------------------------------ */
/* Контроль: экономия не обнулена                                      */
/* ------------------------------------------------------------------ */

test('КОНТРОЛЬ: простые фразы модели по-прежнему НЕ уходят', () => {
  const simple = [
    'андрей заснул',
    'андрей проснулся',
    'заснул',
    'проснулся',
    'уснул',
    'встал',
    'спит',
    'не спит',
    'положили спать',
    'уложили',
  ];

  for (const phrase of simple) {
    const res = match(phrase);
    assert.equal(res.timeUnresolved, false, `ложное срабатывание на «${phrase}»`);
    assert.ok('confidence' in res && res.confidence >= 0.9, `уверенность не должна падать: «${phrase}»`);

    const decision = decideQueue({ policy: 'smart', threshold: 0.8, fast: res, command: phrase });
    assert.equal(decision.queue, false, `«${phrase}» не должна тревожить модель`);
  }
});

test('выход и запрос состояния событий не пишут — время им безразлично', () => {
  assert.equal(match('хватит').timeUnresolved, false);
  assert.equal(match('сколько он сегодня спал').timeUnresolved, false);
  assert.equal(match('как спал ночью').timeUnresolved, false, 'запрос состояния, а не запись');
});

/* ------------------------------------------------------------------ */
/* Детектор указаний на время                                          */
/* ------------------------------------------------------------------ */

test('hasTimeReference ловит слова времени', () => {
  for (const phrase of PHRASES_WITH_TIME) {
    assert.equal(hasTimeReference(normalize(phrase)), true, `не распознано время: «${phrase}»`);
  }
});

test('hasTimeReference не срабатывает на фразах без времени', () => {
  for (const phrase of [
    'андрей заснул',
    'проснулся',
    'положили спать',
    'поменяли подгузник',
    'он в кроватке',
    '',
  ]) {
    assert.equal(hasTimeReference(normalize(phrase)), false, `ложное срабатывание: «${phrase}»`);
  }
});

test('«в <число>» распознаётся, «в <слово>» — нет', () => {
  assert.equal(hasTimeReference(normalize('проснулся в три')), true);
  assert.equal(hasTimeReference(normalize('проснулся в 7')), true);
  assert.equal(hasTimeReference(normalize('проснулся в кроватке')), false);
});

test('isTimeUnresolved: разобранное время снимает флаг', () => {
  assert.equal(isTimeUnresolved('заснул полчаса назад', undefined), true);
  assert.equal(isTimeUnresolved('заснул полчаса назад', '2026-09-15T13:30:00.000Z'), false);
  assert.equal(isTimeUnresolved('заснул', undefined), false);
});

/* ------------------------------------------------------------------ */
/* Сквозная проверка                                                   */
/* ------------------------------------------------------------------ */

test('СКВОЗНОЕ: фраза со временем уходит в очередь, событие помечено низкой уверенностью', async (t) => {
  const h = await makeTestApp({ LLM_QUEUE_POLICY: 'smart' });
  t.after(() => h.close());

  const res = await h.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('андрей заснул полтора часа назад'),
  });

  // голос не называет время, которое мы знаем как вероятно неверное
  const text = (res.json() as { response: { text: string } }).response.text;
  assert.equal(text, ACK, `вслух нельзя называть неверное время, сказано: «${text}»`);
  assert.equal(/\d{2}:\d{2}/.test(text), false, 'в ответе не должно быть конкретного времени');

  const utterance = listUtterances(h.db)[0];
  assert.equal(utterance?.status, 'pending', 'фраза обязана уйти модели');

  const fast = JSON.parse(utterance?.fast_result ?? '{}') as {
    timeUnresolved?: boolean;
    confidence?: number;
  };
  assert.equal(fast.timeUnresolved, true);
  assert.ok((fast.confidence ?? 1) < 0.8);

  // событие всё же записано: если модель недоступна, лучше неточное, чем никакого
  const events = queryEvents(h.db, { type: 'sleep' });
  assert.equal(events.length, 1, 'событие создаётся сразу, время поправит модель');
  assert.ok(
    (events[0]?.confidence ?? 1) < 0.8,
    'в самой записи видно, что уверенности нет — дашборд может это показать',
  );
});

test('СКВОЗНОЕ: простая фраза отвечает временем и модель не тревожит', async (t) => {
  const h = await makeTestApp({ LLM_QUEUE_POLICY: 'smart' });
  t.after(() => h.close());

  const res = await h.app.inject({
    method: 'POST',
    url: `/alice/${TEST_SECRET}`,
    payload: aliceBody('андрей заснул'),
  });

  const text = (res.json() as { response: { text: string } }).response.text;
  assert.equal(text, ACK, 'вслух — только подтверждение приёма');
  assert.equal(listUtterances(h.db)[0]?.status, 'skipped');
  assert.equal(queryEvents(h.db, { type: 'sleep' })[0]?.confidence, 0.95);
});

test('СКВОЗНОЕ: пробуждение с неразобранным временем не называет длительность', async (t) => {
  const h = await makeTestApp();
  t.after(() => h.close());

  const post = (command: string, nlu?: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/alice/${TEST_SECRET}`,
      payload: aliceBody(command, nlu ? { nlu } : {}),
    });

  await post('андрей заснул');
  const woke = await post('проснулся в три');
  const text = (woke.json() as { response: { text: string } }).response.text;

  // Раньше голос называл время и длительность, и на неразобранном времени это
  // становилось правдоподобной неправдой. Теперь он не называет чисел вовсе —
  // проверяем сильное свойство, а не отсутствие одной формулировки.
  assert.equal(text, ACK);
  assert.equal(/\d/.test(text), false, 'в ответе не должно быть ни времени, ни длительности');
});
