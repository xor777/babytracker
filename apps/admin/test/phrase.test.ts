/**
 * Свёрнутая строка фразы, не создавшей записей.
 *
 * Требование к журналу: «время и событие самое основное уже в РАЗОБРАННОМ виде,
 * по тапу разворот». У события это работало, у фразы — нет: строка показывала
 * сырую цитату, и «что он проснулся» читалось как необработанный мусор, хотя
 * фраза штатно закрыла ночной сон.
 *
 * Обратная сторона: фразу, которую НИКТО не разобрал, цитатой и оставляем —
 * там она единственный факт (см. lib/utterance.ts, tone: 'gap').
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { describePhrase } from '../src/lib/describe';
import type { ChangeSet, TrackerEvent } from '../src/types';

function ev(patch: Partial<TrackerEvent> & Pick<TrackerEvent, 'type'>): TrackerEvent {
  return { id: 1, started_at: '2026-09-15T10:00:00.000Z', ...patch } as TrackerEvent;
}

function set(patch: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: 'cs-0001',
    utterance_id: 35,
    summary: 'Разбор фразы моделью: «что он проснулся»',
    created_at: '2026-09-15T02:15:00.000Z',
    reverted_at: null,
    revisions: 1,
    events: [15],
    ...patch,
  };
}

/** Ровно тот случай, на который пожаловался заказчик. */
const nightSleep = ev({
  id: 15,
  type: 'sleep',
  subtype: 'night',
  started_at: '2026-09-14T19:05:00.000Z',
  ended_at: '2026-09-15T02:15:00.000Z',
});

// ------------------------------------------------------------ разбор в строке

test('фраза, закрывшая ночной сон, называет результат, а не себя', () => {
  const s = describePhrase('что он проснулся', [nightSleep], [set()]);
  assert.equal(s.text, 'Сон, ночной — завершён, 7 ч 10 мин');
  assert.equal(s.quote, false);
});

test('фраза, тронувшая ещё идущий сон, не объявляет его завершённым', () => {
  const open = ev({ id: 15, type: 'sleep', subtype: 'nap', ended_at: null });
  const s = describePhrase('он уснул в девять, а не в десять', [open], [set({ events: [15] })]);
  assert.equal(s.text, 'Сон, дневной — идёт');
});

test('у точечной записи длительности нет — и «завершён» тоже нет', () => {
  const diaper = ev({
    id: 16,
    type: 'diaper',
    subtype: 'wet',
    started_at: '2026-09-15T18:04:00.000Z',
    ended_at: '2026-09-15T18:04:00.000Z',
  });
  const s = describePhrase('нет, он не пописал, а покакал', [diaper], [set({ events: [16] })]);
  assert.equal(s.text, 'Подгузник, мокрый — изменён');
});

test('причастие согласуется с родом записи', () => {
  const walk = ev({
    type: 'activity',
    subtype: 'walk',
    started_at: '2026-09-15T10:00:00.000Z',
    ended_at: '2026-09-15T11:30:00.000Z',
  });
  assert.equal(
    describePhrase('гуляли полтора часа', [walk], [set()]).text,
    'Активность, прогулка — завершена, 1 ч 30 мин',
  );

  const feed = ev({
    type: 'feed',
    subtype: 'bottle',
    started_at: '2026-09-15T10:00:00.000Z',
    ended_at: '2026-09-15T10:20:00.000Z',
  });
  assert.equal(
    describePhrase('он доел', [feed], [set()]).text,
    'Кормление, бутылочка — завершено, 20 мин',
  );

  const temp = ev({ type: 'measure', subtype: 'temp', value_num: 37.2, value_unit: 'c' });
  assert.equal(describePhrase('нет, 37,2', [temp], [set()]).text, 'Температура — изменена');

  const weight = ev({ type: 'measure', subtype: 'weight', value_num: 5120, value_unit: 'g' });
  assert.equal(describePhrase('нет, 5120', [weight], [set()]).text, 'Вес — изменён');
});

// ------------------------------------------------------------ удаление и откат

test('удалённая запись названа удалённой', () => {
  const gone = ev({
    id: 15,
    type: 'sleep',
    subtype: 'night',
    started_at: '2026-09-14T19:05:00.000Z',
    ended_at: '2026-09-15T02:15:00.000Z',
    deleted_at: '2026-09-15T08:00:00.000Z',
  });
  // Длительность здесь остаётся: по ней и понятно, КАКУЮ запись убрали.
  assert.equal(
    describePhrase('убери этот сон', [gone], [set()]).text,
    'Сон, ночной — удалён, 7 ч 10 мин',
  );
});

test('откат: непогашенных наборов не осталось — так и говорим', () => {
  // Свой набор откатили, и рядом лёг набор-откат с тем же utterance_id (§9.3).
  const sets = [
    set({ reverted_at: '2026-09-15T09:00:00.000Z' }),
    set({ id: 'cs-0002', summary: 'Откат набора изменений cs-0001' }),
  ];
  const s = describePhrase('что он проснулся', [nightSleep], sets);
  assert.equal(s.text, 'Сон, ночной — изменение отменено');
  assert.equal(s.quote, false);
});

test('набор-откат сам по себе не выдаётся за живое изменение', () => {
  const sets = [set({ id: 'cs-0002', summary: 'Откат набора изменений cs-0001' })];
  assert.equal(
    describePhrase('верни как было', [nightSleep], sets).text,
    'Сон, ночной — изменение отменено',
  );
});

// ------------------------------------------------------------ несколько записей

test('несколько тронутых записей: первая названа, остальные сосчитаны', () => {
  const feed = ev({
    id: 20,
    type: 'feed',
    subtype: 'breast',
    started_at: '2026-09-15T10:00:00.000Z',
    ended_at: '2026-09-15T10:28:00.000Z',
  });
  const s = describePhrase('он поел и уснул, поправь время', [nightSleep, feed], [
    set({ events: [15, 20], revisions: 2 }),
  ]);
  // Длительность у первой записи опущена намеренно: ширина строки конечна.
  assert.equal(s.text, 'Сон, ночной — завершён · ещё 1 запись');
});

test('три записи склоняются правильно', () => {
  const rows = [nightSleep, ev({ id: 20, type: 'diaper' }), ev({ id: 21, type: 'pump' })];
  const s = describePhrase('поправь всё', rows, [set({ events: [15, 20, 21], revisions: 3 })]);
  assert.equal(s.text, 'Сон, ночной — завершён · ещё 2 записи');
});

// ------------------------------------------------------------ неразобранная фраза

test('фразу, которую никто не разобрал, оставляем цитатой', () => {
  const s = describePhrase('он какой-то беспокойный и кряхтит', []);
  assert.equal(s.text, '«он какой-то беспокойный и кряхтит»');
  assert.equal(s.quote, true);
});

test('цитатой остаётся и фраза, разбор которой ещё идёт', () => {
  const s = describePhrase('поменяла подгузник и покормила', [], []);
  assert.equal(s.quote, true);
});

test('набор изменений без загруженных записей не выдумывает разбор', () => {
  // Запись изменена, но в окно ленты не попала — говорить о ней нечего.
  const s = describePhrase('что он проснулся', [], [set()]);
  assert.equal(s.text, '«что он проснулся»');
  assert.equal(s.quote, true);
});
