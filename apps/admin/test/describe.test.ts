/**
 * Строка события в журнале.
 *
 * Главный охраняемый здесь инвариант: НУЛЕВАЯ ДЛИТЕЛЬНОСТЬ НЕ ПЕЧАТАЕТСЯ.
 * Ноль минут — это не «событие длилось ноль», а «длительности нет»: у точечного
 * события модель пишет `ended_at = started_at`, а кормление в двадцать секунд
 * округляется в тот же ноль. Заказчик увидел это как «мокрый подгузник 0 минут».
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  describeEvent,
  eventDurationMin,
  eventName,
  hasTimeSpan,
  summaryLine,
} from '../src/lib/describe';
import type { TrackerEvent } from '../src/types';

const MINUTE = 60_000;

/** Момент `msAgo` миллисекунд назад в ISO — чтобы «идёт» считалось от сейчас. */
function ago(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function ev(patch: Partial<TrackerEvent> & Pick<TrackerEvent, 'type'>): TrackerEvent {
  return {
    id: 1,
    started_at: '2026-09-15T18:04:00.000Z',
    ...patch,
  } as TrackerEvent;
}

// ------------------------------------------------------------ нулевая длительность

test('точечный подгузник: ended_at равен started_at — «0 мин» не печатается', () => {
  const e = ev({
    type: 'diaper',
    subtype: 'wet',
    started_at: '2026-09-15T18:04:00.000Z',
    ended_at: '2026-09-15T18:04:00.000Z',
  });
  assert.equal(summaryLine(e), 'Подгузник, мокрый');
  assert.equal(eventDurationMin(e), null);
  assert.equal(hasTimeSpan(e), false);
});

test('взвешивание тоже точечное: «Вес 5,12 кг» без длительности', () => {
  const e = ev({
    type: 'measure',
    subtype: 'weight',
    started_at: '2026-09-14T06:20:00.000Z',
    ended_at: '2026-09-14T06:20:00.000Z',
    value_num: 5120,
    value_unit: 'g',
  });
  assert.equal(summaryLine(e), 'Вес 5,12 кг');
});

test('кормление короче полуминуты округляется в ноль — и тоже молчит', () => {
  const e = ev({
    type: 'feed',
    subtype: 'breast',
    started_at: '2026-09-14T00:10:00.000Z',
    ended_at: '2026-09-14T00:10:20.000Z',
    note: 'left',
  });
  assert.equal(summaryLine(e), 'Кормление, грудь, левая');
});

test('ровно 30 секунд округляются в минуту — это уже длительность, её печатаем', () => {
  const e = ev({
    type: 'feed',
    subtype: 'bottle',
    started_at: '2026-09-14T00:10:00.000Z',
    ended_at: '2026-09-14T00:10:30.000Z',
  });
  assert.equal(eventDurationMin(e), 1);
  assert.equal(summaryLine(e), 'Кормление, бутылочка, 1 мин');
});

test('настоящая длительность никуда не делась', () => {
  const e = ev({
    type: 'sleep',
    subtype: 'night',
    started_at: '2026-09-14T19:05:00.000Z',
    ended_at: '2026-09-15T02:15:00.000Z',
  });
  assert.equal(summaryLine(e), 'Сон, ночной, 7 ч 10 мин');
  assert.equal(eventDurationMin(e), 430);
  assert.equal(hasTimeSpan(e), true);
});

test('ended_at раньше started_at — битые данные не превращаются в «0 мин»', () => {
  const e = ev({
    type: 'activity',
    subtype: 'walk',
    started_at: '2026-09-15T12:00:00.000Z',
    ended_at: '2026-09-15T11:30:00.000Z',
  });
  assert.equal(eventDurationMin(e), null);
  assert.equal(summaryLine(e), 'Активность, прогулка');
});

test('ended_at нет вовсе: длительности нет, но и «0 мин» нет', () => {
  const e = ev({ type: 'diaper', subtype: 'dirty', ended_at: null });
  assert.equal(eventDurationMin(e), null);
  assert.equal(hasTimeSpan(e), false);
  assert.equal(summaryLine(e), 'Подгузник, грязный');
});

test('длительность не дублирует значение в минутах', () => {
  const e = ev({
    type: 'feed',
    subtype: 'breast',
    started_at: '2026-09-15T10:00:00.000Z',
    ended_at: '2026-09-15T10:15:00.000Z',
    value_num: 15,
    value_unit: 'min',
  });
  assert.equal(summaryLine(e), 'Кормление, грудь, 15 мин');
});

// ------------------------------------------------------------ «идёт»

test('открытый сон идёт: длительности нет, зато есть пометка', () => {
  const e = ev({ type: 'sleep', subtype: 'nap', started_at: ago(40 * MINUTE), ended_at: null });
  const lines = describeEvent(e);
  assert.equal(lines.open, true);
  assert.equal(summaryLine(e), 'Сон, дневной, идёт');
});

test('незакрытая запись старше 12 часов не считается идущей', () => {
  const e = ev({ type: 'activity', subtype: 'bath', started_at: ago(13 * 60 * MINUTE) });
  const lines = describeEvent(e);
  assert.equal(lines.open, false);
  assert.equal(summaryLine(e), 'Активность, купание');
});

// ------------------------------------------------------------ имя записи

test('eventName собирает начало строки и знает род', () => {
  assert.deepEqual(eventName(ev({ type: 'sleep', subtype: 'night' })), {
    text: 'Сон, ночной',
    gender: 'm',
  });
  assert.deepEqual(eventName(ev({ type: 'activity', subtype: 'walk' })), {
    text: 'Активность, прогулка',
    gender: 'f',
  });
  assert.deepEqual(eventName(ev({ type: 'feed', subtype: 'bottle' })), {
    text: 'Кормление, бутылочка',
    gender: 'n',
  });
  assert.deepEqual(eventName(ev({ type: 'measure', subtype: 'temp' })), {
    text: 'Температура',
    gender: 'f',
  });
  // Незнакомый тип не роняет ленту и согласуется средним родом.
  assert.deepEqual(eventName(ev({ type: 'зарядка' })), { text: 'зарядка', gender: 'n' });
});

test('заметка и лекарство сохраняют собственную форму строки', () => {
  assert.equal(summaryLine(ev({ type: 'note', note: 'покакал' })), 'Заметка: покакал');
  assert.equal(
    summaryLine(ev({ type: 'meds', subtype: 'витамин D', value_num: 1, value_unit: 'ml' })),
    'витамин D, 1 мл',
  );
});
