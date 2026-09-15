/**
 * §4 — крайние случаи матчера и ЛОЖНЫЕ СРАБАТЫВАНИЯ.
 *
 * Матчер отвечает голосом за миллисекунды и при высокой уверенности закрывает
 * фразу собой, не тревожа модель. Поэтому каждое лишнее срабатывание — это
 * запись в дневнике, которой не было в жизни, и никто её не заметит.
 * Здесь проверяется ровно это: что матчер молчит там, где не уверен.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFast, normalize } from '../src/fastpath.ts';
import type { AliceNlu } from '../src/types.ts';

const TZ = 'Europe/Moscow';
/** 2026-09-15 17:32 по Москве. */
const NOW = new Date('2026-09-15T14:32:00.000Z');

const match = (command: string, nlu?: AliceNlu) => matchFast(command, nlu, { now: NOW, tz: TZ });
const kind = (command: string): string => match(command).kind;

/* ------------------------------------------------------------------ */
/* Мусор на входе                                                      */
/* ------------------------------------------------------------------ */

test('пустая строка, пробелы и одни знаки препинания не разбираются и не падают', () => {
  for (const command of ['', ' ', '\t\n', '...', '!!!', '?!', '—', '«»', '- - -', '.,;:']) {
    assert.equal(kind(command), 'unknown', `ожидался unknown для ${JSON.stringify(command)}`);
  }
});

test('нестроковый и отсутствующий ввод не роняет матчер', () => {
  for (const command of [undefined, null, 42, {}, []] as unknown[]) {
    const res = matchFast(command as string, undefined, { now: NOW, tz: TZ });
    assert.equal(res.kind, 'unknown');
  }
});

test('битый nlu любой формы не мешает разобрать саму фразу', () => {
  const broken: unknown[] = [
    { entities: null },
    { entities: 'строка' },
    { entities: [null] },
    { entities: [{ type: 'YANDEX.DATETIME' }] },
    { entities: [{ type: 'YANDEX.DATETIME', value: 'не объект' }] },
    { entities: [{ type: 'YANDEX.NUMBER', value: { hour: 3 } }] },
  ];
  for (const nlu of broken) {
    const res = match('андрей заснул', nlu as AliceNlu);
    assert.equal(res.kind, 'sleep_start', `сломался на ${JSON.stringify(nlu)}`);
    assert.equal('at' in res && res.at !== undefined, false, 'из битого nlu время браться не должно');
  }
});

test('очень длинная фраза разбирается и не уводит матчер в бесконечность', () => {
  const long = `${'андрей '.repeat(3000)}заснул`;
  const res = match(long);
  assert.equal(res.kind, 'sleep_start');
  assert.equal(long.length > 20_000, true, 'фраза должна быть действительно длинной');
});

/* ------------------------------------------------------------------ */
/* Нормализация: регистр, ё, пробелы, мусорные символы                 */
/* ------------------------------------------------------------------ */

test('регистр, «ё», лишние пробелы и эмодзи дают тот же разбор', () => {
  const canonical = match('андрей заснул');
  for (const variant of [
    'Андрей заснул',
    'АНДРЕЙ ЗАСНУЛ',
    'аНдРеЙ   ЗаСнУл',
    '  андрей\tзаснул  ',
    'андрей, заснул!',
    'андрей заснул 😴',
  ]) {
    assert.equal(match(variant).kind, canonical.kind, `разошлось на «${variant}»`);
  }
});

test('«ё» и «е» — одно и то же слово во всех словарях', () => {
  assert.equal(kind('подъём'), kind('подъем'));
  assert.equal(kind('ещё не проснулся'), kind('еще не проснулся'));
  assert.equal(kind('отчёт'), kind('отчет'));
  assert.equal(normalize('Ёжик ЁЖ'), 'ежик еж');
});

test('слова-паразиты вокруг команды её не ломают', () => {
  assert.equal(kind('ну всё, андрей заснул'), 'sleep_start');
  assert.equal(kind('алиса скажи андрей проснулся'), 'sleep_end');
  assert.equal(kind('ну ладно хватит'), 'exit');
  assert.equal(kind('алиса статус'), 'query_state');
});

test('фраза из одного слова разбирается по словарю', () => {
  assert.equal(kind('заснул'), 'sleep_start');
  assert.equal(kind('проснулся'), 'sleep_end');
  assert.equal(kind('стоп'), 'exit');
  assert.equal(kind('статус'), 'query_state');
  assert.equal(kind('абырвалг'), 'unknown');
});

test('имя ребёнка внутри фразы и без него не меняет разбор', () => {
  assert.equal(match('заснул').kind, match('андрей заснул').kind);
  assert.equal(match('проснулся').kind, match('андрей проснулся').kind);
  assert.equal(match('андрея уложили').kind, 'sleep_start');
});

/* ------------------------------------------------------------------ */
/* ЛОЖНЫЕ СРАБАТЫВАНИЯ — главная часть файла                           */
/* ------------------------------------------------------------------ */

test('отрицание перед ключевым словом не даёт записать событие', () => {
  for (const phrase of [
    'не заснул',
    'андрей не заснул',
    'ещё не проснулся',
    'он так и не уснул',
    'нет он не уснул',
    'не разбудили',
    'ни разу не проснулся',
    'он не засыпает',
    'так и не уложили',
  ]) {
    assert.equal(kind(phrase), 'unknown', `отрицание «${phrase}» не должно становиться событием`);
  }
});

test('отрицание видно и через слово: «не сразу заснул» матчер сам не решает', () => {
  // Смотреть надо не только на соседний токен: между «не» и ключевым словом
  // почти всегда есть наречие, а смысл фразы от этого не меняется.
  assert.equal(kind('он не сразу заснул'), 'unknown');
  assert.equal(kind('не совсем проснулся'), 'unknown');
  assert.equal(kind('андрей не очень заснул'), 'unknown');
  assert.equal(kind('так и не заснул'), 'unknown');
});

test('будущее время и намерение — ещё не событие', () => {
  for (const phrase of [
    'когда он заснёт',
    'скоро спать',
    'пора спать',
    'хочет спать',
    'не хочет спать',
    'будем укладывать',
    'собираемся спать',
    'надо бы уложить',
  ]) {
    assert.equal(kind(phrase), 'unknown', `«${phrase}» — это планы, а не запись в дневник`);
  }
});

test('вопрос о прошлом не создаёт событие', () => {
  for (const phrase of ['а он спал', 'он спал днём', 'сколько он не спал', 'он хорошо спал']) {
    assert.notEqual(
      kind(phrase),
      'sleep_start',
      `«${phrase}» — вопрос о прошлом, началом сна быть не может`,
    );
  }
});

test(
  'БАГ: вопрос с «ли» матчер принимает за утверждение и молча пишет событие',
  () => {
    for (const phrase of ['спит ли он', 'заснул ли он', 'уснул ли андрей']) {
      assert.equal(kind(phrase), 'unknown', `вопрос «${phrase}» не должен начинать сон`);
    }
    for (const phrase of ['проснулся ли он', 'проснулся ли уже андрей']) {
      assert.equal(kind(phrase), 'unknown', `вопрос «${phrase}» не должен закрывать сон`);
    }
  },
);

test('слово выхода внутри содержательной фразы не завершает диалог', () => {
  assert.equal(kind('пока спит'), 'sleep_start');
  assert.equal(kind('пока не спит'), 'sleep_end');
  assert.notEqual(kind('стоп машина он проснулся'), 'exit');
});

test('команда правки данных не притворяется выходом из диалога', () => {
  // «отмена» — выход, «отмени последнюю запись» — работа с данными.
  assert.equal(kind('отмена'), 'exit');
  assert.notEqual(kind('отмени последнюю запись'), 'exit');
  assert.notEqual(kind('удали последнюю запись'), 'exit');
});

/* ------------------------------------------------------------------ */
/* Составные и многословные маркеры                                    */
/* ------------------------------------------------------------------ */

test('«не спит» — это пробуждение, а не отрицание засыпания (§4)', () => {
  assert.equal(kind('не спит'), 'sleep_end');
  assert.equal(kind('андрей больше не спит'), 'sleep_end');
  assert.equal(kind('уже не спит'), 'sleep_end');
  assert.equal(kind('глаза открыл'), 'sleep_end');
  assert.equal(kind('сон закончился'), 'sleep_end');
});

test('пробуждение имеет приоритет над засыпанием в одной фразе', () => {
  // «заснул, а потом проснулся» — последним состоянием ребёнок бодрствует.
  assert.equal(kind('заснул а потом проснулся'), 'sleep_end');
});

test('запрос состояния не пишет событий и остаётся запросом', () => {
  for (const phrase of [
    'сколько он сегодня спал',
    'сколько проспал',
    'как спал',
    'как он спит',
    'что там',
    'что по сну',
    'что со сном',
    'сколько всего',
    'сводка',
    'итоги',
    'состояние',
  ]) {
    assert.equal(kind(phrase), 'query_state', `ожидался query_state для «${phrase}»`);
  }
});

/* ------------------------------------------------------------------ */
/* Уверенность                                                         */
/* ------------------------------------------------------------------ */

test('прямое словарное попадание без времени заявляет 0.95, запрос — 0.9', () => {
  const start = match('андрей заснул');
  assert.equal(start.kind, 'sleep_start');
  assert.equal('confidence' in start && start.confidence, 0.95);

  const end = match('андрей проснулся');
  assert.equal('confidence' in end && end.confidence, 0.95);

  const query = match('статус');
  assert.equal('confidence' in query && query.confidence, 0.9);
});

test('у unknown и exit уверенности нет — заявлять нечего', () => {
  assert.equal('confidence' in match('абырвалг'), false);
  assert.equal('confidence' in match('хватит'), false);
});

/* ------------------------------------------------------------------ */
/* Время из YANDEX.DATETIME                                            */
/* ------------------------------------------------------------------ */

function dtNlu(value: Record<string, unknown>): AliceNlu {
  return { tokens: [], entities: [{ type: 'YANDEX.DATETIME', value }], intents: {} };
}

test('абсолютное время из nlu обнуляет минуты, относительное — нет', () => {
  // «в три» -> 03:00:00, а не 03:32
  const absolute = match('проснулся в три', dtNlu({ hour: 3 }));
  assert.equal('at' in absolute && absolute.at, '2026-09-15T00:00:00.000Z');

  // «два часа назад» сказанное в 17:32 -> 15:32, минуты обнулять нельзя
  const relative = match('заснул два часа назад', dtNlu({ hour: -2, hour_is_relative: true }));
  assert.equal('at' in relative && relative.at, '2026-09-15T12:32:00.000Z');
});

test('названа только дата — время суток обнуляется, а не берётся текущее', () => {
  // «заснул четырнадцатого», сказанное в 17:32: это начало тех суток,
  // а не 17:32 того дня — час, минуты и секунды обнуляются все вместе.
  const res = match('андрей заснул четырнадцатого', dtNlu({ day: 14 }));
  assert.equal('at' in res && res.at, '2026-09-13T21:00:00.000Z', '14 сентября 00:00 по Москве');

  const full = match('андрей заснул', dtNlu({ year: 2026, month: 9, day: 14 }));
  assert.equal('at' in full && full.at, '2026-09-13T21:00:00.000Z');

  // а у относительного сдвига обнулять нечего: «вчера» — это ровно сутки назад
  const relative = match('заснул вчера', dtNlu({ day: -1, day_is_relative: true }));
  assert.equal('at' in relative && relative.at, '2026-09-14T14:32:00.000Z');
});

test('названный час из будущего трактуется как прошедшие сутки, а не как завтра', () => {
  // сказано в 17:32, «в 23» -> вчерашние 23:00, потому что сон уже был
  const res = match('заснул в 23', dtNlu({ hour: 23 }));
  assert.equal('at' in res && res.at, '2026-09-14T20:00:00.000Z');
});

test('первая осмысленная сущность выигрывает, пустые пропускаются', () => {
  const nlu: AliceNlu = {
    entities: [
      { type: 'YANDEX.NUMBER', value: 5 },
      { type: 'YANDEX.DATETIME', value: {} },
      { type: 'YANDEX.DATETIME', value: { hour: 9 } },
    ],
  };
  const res = match('проснулся в девять', nlu);
  assert.equal('at' in res && res.at, '2026-09-15T06:00:00.000Z');
});

test('matchFast остаётся чистой функцией: тот же вход — тот же выход', () => {
  const nlu = dtNlu({ hour: -1, hour_is_relative: true });
  assert.deepEqual(match('андрей заснул час назад', nlu), match('андрей заснул час назад', nlu));
  assert.deepEqual(match('хватит'), match('хватит'));
});

/* ------------------------------------------------------------------ */
/* Бюджет ответа (§3.1: 200 мс на весь вебхук)                          */
/* ------------------------------------------------------------------ */

test('обычная фраза разбирается за доли миллисекунды', () => {
  const started = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) match('андрей заснул полчаса назад');
  const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 1000;
  assert.ok(perCallMs < 1, `один разбор занял ${perCallMs.toFixed(3)} мс — бюджет вебхука 200 мс`);
});

test(
  'БАГ: разбор квадратичен по длине — длинная фраза съедает бюджет вебхука целиком',
  () => {
    const hostile = 'сколько '.repeat(2000); // 16 КБ
    const started = process.hrtime.bigint();
    matchFast(hostile, undefined, { now: NOW, tz: TZ });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 200, `разбор занял ${elapsedMs.toFixed(0)} мс при бюджете 200 мс`);
  },
);
