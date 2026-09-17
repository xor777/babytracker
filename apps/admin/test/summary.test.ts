/**
 * Арифметика «Сводки».
 *
 * Раздел показывают врачу, поэтому каждое число здесь обязано быть либо
 * заработанным фактом, либо честным прочерком. Тесты проверяют ровно границу
 * между ними: «не было» против «не записали», знаменатель среднего, деление
 * на ноль, округление положительной величины в ноль.
 *
 * Все моменты строятся конструктором `new Date(y, m, d, …)`, то есть в местной
 * зоне машины. Тесты не зависят от TZ; там, где зона существенна (переход на
 * летнее время), она задаётся явно — отдельным процессом, см. конец файла.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  averagePerDay,
  buildWindow,
  coverage,
  dayBars,
  diaperMarks,
  feedGapFacts,
  sleepFacts,
  weekStats,
  weeks,
  weightFacts,
} from '../src/lib/summary';
import type { DayCell } from '../src/lib/summary';
import {
  formatMinutes,
  formatPerDay,
  formatSignedGrams,
  formatSpan,
  localDateKey,
} from '../src/lib/format';
import type { DailyStats, TrackerEvent } from '../src/types';

/* ------------------------------------------------------------------ *
 * Подсобка
 * ------------------------------------------------------------------ */

/** Момент в местной зоне — чтобы тест не зависел от TZ машины. */
function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

const BIRTH = local(2026, 9, 2, 4, 35);
const NOW = local(2026, 9, 16, 15, 0);

interface DayParts {
  feeds?: Partial<DailyStats['feeds']>;
  diapers?: Partial<DailyStats['diapers']>;
  sleep?: Partial<DailyStats['sleep']>;
  weightG?: number | null;
}

/** Сутки в том виде, в каком их отдаёт `GET /api/stats/daily`: нули, а не пропуски. */
function day(dateMs: number, parts: DayParts = {}): DailyStats {
  return {
    date: localDateKey(dateMs),
    feeds: { total: 0, breast: 0, bottle: 0, solid: 0, volumeMl: null, ...parts.feeds },
    diapers: { wet: 0, dirty: 0, both: 0, total: 0, ...parts.diapers },
    sleep: { totalMin: 0, sessions: 0, longestMin: 0, ...parts.sleep },
    measures: {
      weightG: parts.weightG ?? null,
      heightCm: null,
      headCm: null,
      tempMaxC: null,
    },
  };
}

let seq = 0;
function ev(type: string, startedAt: number, extra: Partial<TrackerEvent> = {}): TrackerEvent {
  return {
    id: ++seq,
    type,
    started_at: new Date(startedAt).toISOString(),
    ...extra,
  } as TrackerEvent;
}

/* ================================================================== *
 * 1. Округление: положительное никогда не печатается нулём
 * ================================================================== */

test('прода: 1 подгузник за 7 суток окна не превращается в «0 в сутки»', () => {
  // Ровно тот случай, на котором экран соврал: 0,142857… округлили в ноль.
  assert.equal(formatPerDay(1 / 7), '0,1');
  assert.notEqual(formatPerDay(1 / 7), '0');
});

test('величина мельче десятой доли печатается словами, а не нулём', () => {
  assert.equal(formatPerDay(0.04), 'меньше 0,1');
  assert.equal(formatPerDay(0.0001), 'меньше 0,1');
  assert.equal(formatPerDay(-0.01), '−меньше 0,1');
});

test('настоящий ноль и отсутствие данных — разные строки', () => {
  assert.equal(formatPerDay(0), '0');
  assert.equal(formatPerDay(null), '—');
  assert.equal(formatPerDay(undefined), '—');
  assert.equal(formatPerDay(Number.NaN), '—');
});

test('целое печатается целым, дробное — с десятой долей, крупное — без хвоста', () => {
  assert.equal(formatPerDay(6), '6');
  assert.equal(formatPerDay(8.5), '8,5');
  assert.equal(formatPerDay(8.46), '8,5');
  assert.equal(formatPerDay(13.2), '13,2');
  // Больше десяти десятая доля уже ничего не сообщает.
  assert.equal(formatPerDay(124.4), '124');
});

test('длительность между нулём и минутой не печатается как «0 мин»', () => {
  assert.equal(formatMinutes(0.4), 'меньше минуты');
  assert.equal(formatMinutes(0), '0 мин');
  assert.equal(formatMinutes(1), '1 мин');
  assert.equal(formatMinutes(505), '8 ч 25 мин');
});

test('подпись отрезка называет дату конца, когда она другая', () => {
  // Боевой случай: «14 сентября, 13:00 → 19:06» стояло рядом со значением
  // «30 ч 6 мин». Подпись и значение противоречили друг другу, и подпись
  // читалась как шесть часов.
  assert.equal(
    formatSpan(local(2026, 9, 14, 13, 0), local(2026, 9, 15, 19, 6)),
    '14 сентября, 13:00 → 15 сентября, 19:06',
  );
  // Ночной сон рвался ровно так же: 8 ч 25 мин с подписью «22:10 → 06:35».
  assert.equal(
    formatSpan(local(2026, 9, 15, 22, 10), local(2026, 9, 16, 6, 35)),
    '15 сентября, 22:10 → 16 сентября, 06:35',
  );
  // А внутри одних суток вторая дата — шум: её не должно быть.
  assert.equal(
    formatSpan(local(2026, 9, 14, 13, 0), local(2026, 9, 14, 19, 6)),
    '14 сентября, 13:00 → 19:06',
  );
});

test('прибавка веса печатается со знаком, и крошечная не выглядит нулевой', () => {
  assert.equal(formatSignedGrams(34), '+34 г');
  assert.equal(formatSignedGrams(-270), '−270 г');
  assert.equal(formatSignedGrams(0), '0 г');
  assert.equal(formatSignedGrams(0.2), '+меньше 1 г');
  assert.equal(formatSignedGrams(null), '—');
});

/* ================================================================== *
 * 2. Окно: «не было» против «не записали»
 * ================================================================== */

/** Случай заказчика: ребёнку 14 дней, дневник ведут с 15 сентября. */
function prodWindow() {
  const days: DailyStats[] = [];
  for (let i = 6; i >= 0; i--) {
    const ms = local(2026, 9, 16 - i);
    if (i === 1) days.push(day(ms, { diapers: { wet: 1, total: 1 }, feeds: { total: 6 } }));
    else if (i === 0) days.push(day(ms, { diapers: { wet: 3, total: 3 }, feeds: { total: 4 } }));
    else days.push(day(ms));
  }
  const events = [
    ev('diaper', local(2026, 9, 15, 9, 0), { subtype: 'wet' }),
    ev('feed', local(2026, 9, 15, 8, 0), { subtype: 'breast' }),
    ev('diaper', local(2026, 9, 16, 7, 0), { subtype: 'wet' }),
    ev('feed', local(2026, 9, 16, 6, 30), { subtype: 'breast' }),
  ];
  return buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
}

test('сутки без единой записи помечены как незаписанные, а не как нулевые', () => {
  const cells = prodWindow();
  assert.equal(cells.length, 7);

  const blank = cells.filter((c) => c.recorded === false);
  assert.equal(blank.length, 5, 'пять суток окна дневник не вели');
  for (const c of blank) {
    assert.equal(c.feeds, null, 'кормлений не записано — null, а не 0');
    assert.equal(c.diapers, null);
    assert.equal(c.sleep, null);
  }

  const kept = cells.filter((c) => c.recorded === true);
  assert.deepEqual(
    kept.map((c) => c.date),
    ['2026-09-15', '2026-09-16'],
  );
});

test('прода целиком: «в среднем 0 подгузников» больше не получается', () => {
  const cells = prodWindow();
  const avg = averagePerDay(cells, (c) => (c.diapers ? c.diapers.total : null));

  // Единственные завершённые сутки с записью о подгузниках — 15 сентября, один подгузник.
  assert.ok(avg, 'среднее считается');
  assert.equal(avg.days, 1, 'знаменатель — сутки с записями, а не всё окно');
  assert.equal(avg.total, 1);
  assert.equal(avg.value, 1);
  assert.equal(formatPerDay(avg.value), '1');

  // Старая формула: сумма по всем завершённым суткам, делённая на их число.
  const oldWay = Math.round(1 / 6);
  assert.equal(oldWay, 0, 'так это и получалось');
  assert.notEqual(formatPerDay(avg.value), String(oldWay));
});

test('сутки до рождения в окно не попадают вовсе', () => {
  // Окно на месяц у двухнедельного: половина — время, когда ребёнка ещё не было.
  const days: DailyStats[] = [];
  for (let i = 29; i >= 0; i--) days.push(day(local(2026, 9, 16 - i)));
  const cells = buildWindow({ days, events: [], eventsKnown: true, birthMs: BIRTH, now: NOW });

  assert.equal(cells.length, 15, 'со 2 по 16 сентября включительно');
  assert.equal(cells[0].date, '2026-09-02');
  assert.equal(cells[0].ageDays, 0);
  assert.equal(cells[cells.length - 1].ageDays, 14);
});

test('сутки из будущего в окно не попадают', () => {
  const days = [day(local(2026, 9, 16)), day(local(2026, 9, 17))];
  const cells = buildWindow({ days, events: [], eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.deepEqual(cells.map((c) => c.date), ['2026-09-16']);
});

test('удалённое событие не делает сутки записанными', () => {
  const days = [day(local(2026, 9, 14)), day(local(2026, 9, 15))];
  const events = [
    ev('feed', local(2026, 9, 14, 10, 0), { deleted_at: new Date(NOW).toISOString() }),
    ev('feed', local(2026, 9, 15, 10, 0)),
  ];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.equal(cells[0].recorded, false, 'осталось только мягко удалённое — это пусто');
  assert.equal(cells[1].recorded, true);
});

test('запись любого типа считается записью: заметка тоже ведёт дневник', () => {
  const days = [day(local(2026, 9, 14))];
  const events = [ev('note', local(2026, 9, 14, 10, 0), { note: 'кряхтит' })];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.equal(cells[0].recorded, true);
  assert.equal(cells[0].feeds, null, 'но кормлений в этих сутках всё равно не записано');
});

test('лента не доехала — «записано» становится неизвестным, а не «нет»', () => {
  const days = [day(local(2026, 9, 14)), day(local(2026, 9, 15))];
  const cells = buildWindow({ days, events: [], eventsKnown: false, birthMs: BIRTH, now: NOW });
  for (const c of cells) {
    assert.equal(c.recorded, null, 'не знаем — значит не знаем');
    assert.equal(c.nightFeeds, null, 'ночные кормления считать не по чему');
  }
  const cov = coverage(cells, BIRTH, NOW);
  assert.equal(cov.unknown, 2);
  assert.equal(cov.blank, 0);
});

test('обрезанная лимитом лента не выдаёт старые сутки за пустые', () => {
  const days = [local(2026, 9, 13), local(2026, 9, 14), local(2026, 9, 15)].map((ms) => day(ms));
  const oldestSeenMs = local(2026, 9, 14, 8, 0);
  const cells = buildWindow({
    days,
    events: [ev('feed', local(2026, 9, 15, 9, 0))],
    eventsKnown: true,
    oldestSeenMs,
    birthMs: BIRTH,
    now: NOW,
  });

  assert.equal(cells[0].recorded, null, '13-е целиком старше виденного — неизвестно');
  assert.equal(cells[1].recorded, false, '14-е лента застала, записей в нём нет');
  assert.equal(cells[2].recorded, true);
});

/* ================================================================== *
 * 3. Среднее: знаменатель, ноль, пустота
 * ================================================================== */

function cellsOf(spec: Array<{ ms: number; parts?: DayParts }>): DayCell[] {
  return buildWindow({
    days: spec.map((s) => day(s.ms, s.parts)),
    events: spec.map((s) => ev('feed', s.ms + 10 * 3_600_000)),
    eventsKnown: true,
    birthMs: BIRTH,
    now: NOW,
  });
}

test('сегодняшние неполные сутки в среднее не входят', () => {
  const cells = cellsOf([
    { ms: local(2026, 9, 14), parts: { feeds: { total: 8 } } },
    { ms: local(2026, 9, 15), parts: { feeds: { total: 10 } } },
    { ms: local(2026, 9, 16), parts: { feeds: { total: 3 } } }, // сегодня, день ещё идёт
  ]);
  const avg = averagePerDay(cells, (c) => (c.feeds ? c.feeds.total : null));
  assert.deepEqual(avg, { value: 9, days: 2, total: 18 });
});

test('единственные сутки с записями — это сегодня: среднего ещё нет', () => {
  const cells = cellsOf([{ ms: local(2026, 9, 16), parts: { feeds: { total: 5 } } }]);
  assert.equal(averagePerDay(cells, (c) => (c.feeds ? c.feeds.total : null)), null);
});

test('окно без единых суток — null, а не ноль и не падение', () => {
  assert.equal(averagePerDay([], () => 1), null);
});

test('ноль в сутках с записями — полноценное слагаемое', () => {
  // Подгузники записывали оба дня; грязных во второй день не было ни одного.
  const cells = cellsOf([
    { ms: local(2026, 9, 14), parts: { diapers: { wet: 6, dirty: 3, total: 9 } } },
    { ms: local(2026, 9, 15), parts: { diapers: { wet: 6, dirty: 0, total: 6 } } },
  ]);
  const dirty = averagePerDay(cells, (c) => (c.diapers ? c.diapers.dirty : null));
  assert.deepEqual(dirty, { value: 1.5, days: 2, total: 3 });
});

test('сутки без подгузников не тянут среднее по подгузникам вниз', () => {
  const cells = cellsOf([
    { ms: local(2026, 9, 13), parts: { feeds: { total: 8 } } }, // записаны кормления, не подгузники
    { ms: local(2026, 9, 14), parts: { diapers: { wet: 6, total: 6 } } },
    { ms: local(2026, 9, 15), parts: { diapers: { wet: 8, total: 8 } } },
  ]);
  const avg = averagePerDay(cells, (c) => (c.diapers ? c.diapers.total : null));
  assert.deepEqual(avg, { value: 7, days: 2, total: 14 });
});

test('среднее не округляется внутри: округляет только печать', () => {
  const cells = cellsOf([
    { ms: local(2026, 9, 13), parts: { feeds: { total: 7 } } },
    { ms: local(2026, 9, 14), parts: { feeds: { total: 8 } } },
    { ms: local(2026, 9, 15), parts: { feeds: { total: 10 } } },
  ]);
  const avg = averagePerDay(cells, (c) => (c.feeds ? c.feeds.total : null));
  assert.ok(avg);
  assert.equal(avg.value, 25 / 3);
  assert.equal(formatPerDay(avg.value), '8,3');
});

/* ================================================================== *
 * 3.4. Покрытие ПО РОДУ событий
 *
 * `recorded` отвечает на вопрос «вели ли в эти сутки дневник», а не «записали
 * ли кормления». Решения о кормлениях, подгузниках и сне принимаются по своему
 * роду — иначе сутки, в которые записали одно взвешивание, попадают на график
 * кормлений нулём, а в знаменатель среднего не попадают вовсе: график и число
 * под ним начинают считать записанными разные сутки.
 * ================================================================== */

/** Боевое окно 2–16 сентября: 2-го только взвесили, 11-го — только подгузники. */
function mixedWindow(): DayCell[] {
  const days: DailyStats[] = [];
  for (let i = 14; i >= 0; i--) {
    const ms = local(2026, 9, 16 - i);
    if (i === 14) days.push(day(ms, { weightG: 4620 }));
    else if (i === 5) days.push(day(ms, { diapers: { wet: 4, dirty: 1, total: 5 } }));
    else if (i === 4)
      days.push(
        day(ms, {
          feeds: { total: 8 },
          diapers: { wet: 2, dirty: 3, total: 5 },
          sleep: { totalMin: 413, sessions: 5 },
        }),
      );
    else if (i === 3) days.push(day(ms, { feeds: { total: 6 }, diapers: { wet: 3, total: 3 } }));
    else if (i === 0)
      days.push(day(ms, { feeds: { total: 5 }, diapers: { wet: 3, total: 3 } })); // сегодня
    else days.push(day(ms));
  }
  const events = [
    ev('measure', local(2026, 9, 2, 12, 0), { subtype: 'weight', value_num: 4620 }),
    ev('diaper', local(2026, 9, 11, 9, 0), { subtype: 'wet' }),
    ev('feed', local(2026, 9, 12, 8, 0)),
    ev('feed', local(2026, 9, 13, 8, 0)),
    ev('feed', local(2026, 9, 16, 8, 0)),
  ];
  return buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
}

test('сутки с одним взвешиванием: дневник вели, а кормлений не записано', () => {
  const first = mixedWindow()[0];
  assert.equal(first.date, '2026-09-02');
  assert.equal(first.recorded, true, 'для полноты дневника эти сутки записаны');
  assert.equal(first.feeds, null, 'а для кормлений это такой же пробел, как пустые сутки');
  assert.equal(first.diapers, null);
  assert.equal(first.sleep, null);
  assert.equal(first.nightFeeds, null, 'ночные кормления тут считать не по чему');
});

test('график, среднее и знаменатель под ним считают записанными одни и те же сутки', () => {
  const cells = mixedWindow();
  const todayKey = localDateKey(NOW);

  // Сутки, за которые записано именно это. Список явный: сверять `dayBars`
  // с `averagePerDay` их же формулой значило бы проверять тавтологию.
  const cases = [
    { pick: (c: DayCell) => c.feeds?.total ?? null, days: ['2026-09-12', '2026-09-13'] },
    {
      pick: (c: DayCell) => c.diapers?.wet ?? null,
      days: ['2026-09-11', '2026-09-12', '2026-09-13'],
    },
    { pick: (c: DayCell) => c.sleep?.totalMin ?? null, days: ['2026-09-12'] },
  ];

  for (const { pick, days } of cases) {
    const drawn = dayBars(cells, pick)
      .filter((b) => b.primary !== null && b.date !== todayKey)
      .map((b) => b.date);
    assert.deepEqual(drawn, days, 'столбцы стоят ровно за эти сутки');
    assert.equal(averagePerDay(cells, pick)?.days, days.length, 'и знаменатель — ровно они же');
  }
});

test('на графике кормлений сутки с одним взвешиванием — штриховка, а не ноль', () => {
  const bars = dayBars(mixedWindow(), (c) => c.feeds?.total ?? null);
  assert.equal(bars[0].date, '2026-09-02');
  assert.equal(bars[0].primary, null, 'ноль тут означал бы «кормили ноль раз» — этого никто не записывал');
  assert.equal(bars[9].date, '2026-09-11', 'и 11-е, где записали только подгузники, — тоже');
  assert.equal(bars[9].primary, null);
  assert.equal(bars[10].primary, 8, 'а сутки с кормлениями рисуются как есть');
});

/* ================================================================== *
 * 3.5. Подгузники: знаков ровно столько, сколько подгузников
 *
 * Карточка рисует штуку на каждый подгузник, а сервер отдаёт два
 * ПЕРЕСЕКАЮЩИХСЯ ряда: подгузник с подтипом `both` лежит и в `wet`, и в
 * `dirty`. Отсюда единственное, что нельзя сломать: сумма нарисованного
 * не должна превышать число сменённых подгузников. Иначе картинка
 * покажет врачу подгузников больше, чем было, — а по ним он судит об
 * обезвоживании.
 * ================================================================== */

/** Инвариант карточки: кучки не пересекаются и в сумме дают ровно `total`. */
function assertHonest(m: ReturnType<typeof diaperMarks>, d: DailyStats['diapers']) {
  assert.ok(m);
  assert.equal(
    m.wetOnly + m.both + m.dirtyOnly + m.unknown,
    m.total,
    'нарисованных знаков должно быть ровно столько, сколько подгузников сменили',
  );
  assert.ok(m.total <= d.total, 'знаков больше, чем подгузников, быть не может');
}

test('подгузник «и мокрый, и грязный» рисуется ОДИН раз, а не дважды', () => {
  // 5 сменили: 3 только мокрых, 1 только грязный, 1 сразу оба.
  // Сервер отдаёт wet=4, dirty=2 — в сумме 6, и стопка нарисовала бы шесть.
  const d = { wet: 4, dirty: 2, both: 1, total: 5 };
  const m = diaperMarks(d);
  assert.deepEqual(m, { wetOnly: 3, both: 1, dirtyOnly: 1, unknown: 0, total: 5 });
  assertHonest(m, d);
});

test('сутки, где каждый подгузник и мокрый, и грязный: три знака, а не шесть', () => {
  const d = { wet: 3, dirty: 3, both: 3, total: 3 };
  const m = diaperMarks(d);
  assert.deepEqual(m, { wetOnly: 0, both: 3, dirtyOnly: 0, unknown: 0, total: 3 });
  assertHonest(m, d);
});

test('кучки складываются обратно в ряды сервера: врач сравнивает с ориентиром их', () => {
  const d = { wet: 8, dirty: 4, both: 2, total: 10 };
  const m = diaperMarks(d);
  assert.ok(m);
  assert.equal(m.wetOnly + m.both, d.wet, 'мокрые — это нижний отрезок вместе с двойными');
  assert.equal(m.dirtyOnly + m.both, d.dirty, 'грязные — верхний отрезок вместе с двойными');
  assertHonest(m, d);
});

test('подгузник без подтипа не теряется: знаков всё равно столько, сколько сменили', () => {
  // «поменяли подгузник» без уточнения: в wet/dirty он не попал, в total — да.
  const d = { wet: 5, dirty: 1, both: 0, total: 7 };
  const m = diaperMarks(d);
  assert.deepEqual(m, { wetOnly: 5, both: 0, dirtyOnly: 1, unknown: 1, total: 7 });
  assertHonest(m, d);
});

test('подгузников за сутки не записано — null, а не ноль', () => {
  assert.equal(diaperMarks(null), null);
  assert.equal(diaperMarks(undefined), null);
  // А вот записанный ноль — это ноль, и он остаётся нулём.
  assert.deepEqual(diaperMarks({ wet: 0, dirty: 0, both: 0, total: 0 }), {
    wetOnly: 0,
    both: 0,
    dirtyOnly: 0,
    unknown: 0,
    total: 0,
  });
});

test('битые числа с сервера не рисуют лишних подгузников', () => {
  // `both` больше, чем `wet`; сумма подтипов больше, чем `total`. Так быть не
  // должно, но если случится — лучше показать меньше, чем придумать подгузник.
  for (const d of [
    { wet: 1, dirty: 5, both: 4, total: 2 },
    { wet: 9, dirty: 9, both: 0, total: 3 },
    { wet: -2, dirty: 1.7, both: 0, total: 3 },
  ]) {
    const m = diaperMarks(d);
    assert.ok(m);
    assert.ok(
      m.wetOnly + m.both + m.dirtyOnly + m.unknown <= Math.max(0, Math.floor(d.total)),
      `знаков больше, чем подгузников: ${JSON.stringify(d)} → ${JSON.stringify(m)}`,
    );
    assert.ok(
      [m.wetOnly, m.both, m.dirtyOnly, m.unknown].every((n) => Number.isInteger(n) && n >= 0),
      `знаки обязаны быть целыми и неотрицательными: ${JSON.stringify(m)}`,
    );
  }
});

test('на любых правдоподобных сутках нарисованное не превышает сменённого', () => {
  // Перебор вместо примера: ровно этот инвариант и есть причина всей раскладки.
  for (let wetOnly = 0; wetOnly <= 6; wetOnly++) {
    for (let dirtyOnly = 0; dirtyOnly <= 6; dirtyOnly++) {
      for (let both = 0; both <= 4; both++) {
        for (const extra of [0, 1, 2]) {
          const total = wetOnly + dirtyOnly + both + extra;
          const d = { wet: wetOnly + both, dirty: dirtyOnly + both, both, total };
          const m = diaperMarks(d);
          assert.ok(m);
          assert.deepEqual(
            m,
            { wetOnly, both, dirtyOnly, unknown: extra, total },
            `не разложилось: ${JSON.stringify(d)}`,
          );
        }
      }
    }
  }
});

/* ================================================================== *
 * 4. Полнота и недели
 * ================================================================== */

test('полнота считает записанные, пустые и неизвестные по отдельности', () => {
  const cov = coverage(prodWindow(), BIRTH, NOW);
  assert.equal(cov.total, 7);
  assert.equal(cov.recorded, 2);
  assert.equal(cov.blank, 5);
  assert.equal(cov.unknown, 0);
  assert.equal(cov.firstRecordedDate, '2026-09-15');
  assert.equal(cov.ageDays, 14, 'ребёнку две недели');
  assert.equal(cov.fromBirth, false, 'окно в неделю всей жизни не покрывает');
});

test('недели считаются от рождения, а не от календарного понедельника', () => {
  const days: DailyStats[] = [];
  for (let i = 14; i >= 0; i--) days.push(day(local(2026, 9, 16 - i)));
  const cells = buildWindow({ days, events: [], eventsKnown: true, birthMs: BIRTH, now: NOW });
  const rows = weeks(cells);

  assert.deepEqual(rows.map((r) => r.index), [1, 2, 3]);
  assert.equal(rows[0].cells.length, 7, 'возраст 0–6 дней');
  assert.equal(rows[0].cells[0].date, '2026-09-02');
  assert.equal(rows[1].cells.length, 7, 'возраст 7–13 дней');
  assert.equal(rows[2].cells.length, 1, 'третья неделя только началась');
});

test('без даты рождения недель не выдумываем', () => {
  const cells = buildWindow({
    days: [day(local(2026, 9, 15)), day(local(2026, 9, 16))],
    events: [],
    eventsKnown: true,
    birthMs: null,
    now: NOW,
  });
  assert.deepEqual(weeks(cells), []);
});

/* ================================================================== *
 * 5. Вес
 * ================================================================== */

const W = (d: number, grams: number) => ({ at: local(2026, 9, d, 11, 0), value: grams });

test('вес: провал, возврат и прибавка считаются по отдельности', () => {
  const f = weightFacts(
    [W(2, 4620), W(5, 4290), W(9, 4640), W(15, 4980)],
    BIRTH,
  );
  assert.ok(f);

  assert.equal(f.birth.value, 4620);
  assert.equal(f.last.value, 4980);
  assert.equal(f.count, 4);
  assert.equal(f.fromBirthG, 360);

  assert.ok(f.nadir);
  assert.equal(f.nadir.point.value, 4290);
  assert.equal(f.nadir.point.ageDays, 3, 'минимум — на третьи сутки жизни');
  assert.equal(f.nadir.lossG, 330);
  assert.ok(Math.abs(f.nadir.lossPct - 7.142857) < 1e-4);

  assert.ok(f.regained);
  assert.equal(f.regained.value, 4640);
  assert.equal(f.regained.ageDays, 7, 'вес рождения перекрыт на седьмые сутки');

  // Прибавка между двумя последними: 4980 − 4640 = 340 за 6 суток.
  assert.ok(f.recent);
  assert.equal(f.recent.days, 6);
  assert.ok(Math.abs(f.recent.perDay - 340 / 6) < 1e-9);

  // От минимума: 4980 − 4290 = 690 за 10 суток.
  assert.ok(f.sinceNadir);
  assert.equal(f.sinceNadir.days, 10);
  assert.equal(f.sinceNadir.perDay, 69);
});

test('вес: единственное измерение не даёт ни провала, ни прибавки', () => {
  const f = weightFacts([W(2, 4620)], BIRTH);
  assert.ok(f);
  assert.equal(f.count, 1);
  assert.equal(f.nadir, null);
  assert.equal(f.regained, null);
  assert.equal(f.recent, null, 'делить не на что и не на чем');
  assert.equal(f.sinceNadir, null);
  assert.equal(f.fromBirthG, 0);
});

test('вес: двух взвешиваний в одни сутки хватает на разницу, но не на прибавку в сутки', () => {
  // Делить на ноль суток нельзя. И «половину суток» за сутки выдавать тоже:
  // это умножило бы погрешность весов на два и выдало бы её за факт.
  const f = weightFacts(
    [{ at: local(2026, 9, 15, 9, 0), value: 4900 }, { at: local(2026, 9, 15, 21, 0), value: 4960 }],
    BIRTH,
  );
  assert.ok(f);
  assert.equal(f.fromBirthG, 60);
  assert.equal(f.recent, null);
  assert.ok(Number.isFinite(f.fromBirthG));
});

test('вес: если ниже рождения не опускались, провала нет и возврата тоже', () => {
  const f = weightFacts([W(2, 4620), W(9, 4700)], BIRTH);
  assert.ok(f);
  assert.equal(f.nadir, null);
  assert.equal(f.regained, null);
  assert.equal(f.sinceNadir, null);
  assert.ok(f.recent);
  assert.equal(f.recent.days, 7);
});

test('вес: пока не перекрыли исходный, возврат остаётся незафиксированным', () => {
  const f = weightFacts([W(2, 4620), W(5, 4290), W(9, 4480)], BIRTH);
  assert.ok(f);
  assert.ok(f.nadir);
  assert.equal(f.regained, null, 'не «не вернулся», а «пока не записано»');
  assert.equal(f.fromBirthG, -140);
  assert.equal(formatSignedGrams(f.fromBirthG), '−140 г');
});

test('вес: потеря между взвешиваниями — тоже факт, со знаком минус', () => {
  const f = weightFacts([W(2, 4620), W(5, 4290)], BIRTH);
  assert.ok(f?.recent);
  assert.equal(f.recent.days, 3);
  assert.equal(f.recent.perDay, -110);
  assert.equal(formatSignedGrams(f.recent.perDay), '−110 г');
});

test('вес: без измерений — null, а не пустой объект с нулями', () => {
  assert.equal(weightFacts([], BIRTH), null);
});

test('вес: без даты рождения возраст на взвешивании остаётся неизвестным', () => {
  const f = weightFacts([W(2, 4620), W(9, 4700)], null);
  assert.ok(f);
  assert.equal(f.birth.ageDays, null, 'подставлять сюда первое взвешивание нельзя');
  assert.ok(f.recent, 'а прибавка считается и без даты рождения');
});

test('прибавка за неделю едет вместе со сроком, за который набралась', () => {
  // Боевой случай: взвешивали 2-го, 12-го и 15-го. «−36 г» в строке «2-я
  // неделя» — это разница не за неделю, а за тринадцать суток, и без срока
  // рядом она читается как недельная.
  const days: DailyStats[] = [];
  for (let i = 14; i >= 0; i--) days.push(day(local(2026, 9, 16 - i)));
  const cells = buildWindow({ days, events: [], eventsKnown: true, birthMs: BIRTH, now: NOW });
  const rows = weekStats(weeks(cells), [W(2, 4620), W(12, 4528), W(15, 4584)]);

  assert.equal(rows[0].weightDeltaG, null, 'в первой неделе взвешивание одно — разницы нет');
  assert.equal(rows[0].weightSpanDays, null);
  assert.equal(rows[1].weightDeltaG, -36, 'последнее в неделе минус последнее до неё');
  assert.equal(rows[1].weightSpanDays, 13, 'и набралась она за тринадцать суток, а не за семь');
  assert.equal(formatSignedGrams(rows[1].weightDeltaG), '−36 г');
});

test('вес: измерения приходят вперемешку — порядок восстанавливается', () => {
  const f = weightFacts([W(15, 4980), W(2, 4620), W(5, 4290)], BIRTH);
  assert.ok(f);
  assert.equal(f.birth.value, 4620);
  assert.equal(f.last.value, 4980);
});

/* ================================================================== *
 * 6. Сон
 * ================================================================== */

test('сон: самый длинный отрезок считается целиком, а не кусками по полуночи', () => {
  const start = local(2026, 9, 15, 22, 10);
  const end = local(2026, 9, 16, 6, 35);
  const f = sleepFacts(
    [ev('sleep', start, { ended_at: new Date(end).toISOString(), subtype: 'night' })],
    local(2026, 9, 10),
    NOW,
  );
  assert.ok(f.longest);
  assert.equal(f.longest.minutes, 505, '8 ч 25 мин, а не 110 + 395');
  assert.equal(formatMinutes(f.longest.minutes), '8 ч 25 мин');
  assert.equal(f.closed, 1);
});

test('сон: идущий сон не считается завершённым, но и не теряется', () => {
  const start = local(2026, 9, 16, 13, 30);
  const f = sleepFacts([ev('sleep', start)], local(2026, 9, 10), NOW);
  assert.equal(f.longest, null, 'завершённых отрезков нет');
  assert.equal(f.closed, 0);
  assert.equal(f.openMin, 90, 'но идёт он уже полтора часа');
});

test('сон: идущий сон длиннее всех завершённых их не подменяет', () => {
  const f = sleepFacts(
    [
      ev('sleep', local(2026, 9, 16, 1, 0), {
        ended_at: new Date(local(2026, 9, 16, 3, 0)).toISOString(),
      }),
      ev('sleep', local(2026, 9, 16, 9, 0)),
    ],
    local(2026, 9, 10),
    NOW,
  );
  assert.equal(f.longest?.minutes, 120);
  assert.equal(f.openMin, 360);
});

test('сон: удалённые и вывернутые записи в расчёт не идут', () => {
  const f = sleepFacts(
    [
      ev('sleep', local(2026, 9, 15, 1, 0), {
        ended_at: new Date(local(2026, 9, 15, 9, 0)).toISOString(),
        deleted_at: new Date(NOW).toISOString(),
      }),
      // конец раньше начала — это сломанная запись, а не отрицательный сон
      ev('sleep', local(2026, 9, 15, 12, 0), {
        ended_at: new Date(local(2026, 9, 15, 11, 0)).toISOString(),
      }),
      ev('sleep', local(2026, 9, 15, 14, 0), {
        ended_at: new Date(local(2026, 9, 15, 15, 0)).toISOString(),
      }),
    ],
    local(2026, 9, 10),
    NOW,
  );
  assert.equal(f.closed, 1);
  assert.equal(f.longest?.minutes, 60);
});

test('сон: отрезки старше окна не учитываются', () => {
  const f = sleepFacts(
    [
      ev('sleep', local(2026, 9, 1, 22, 0), {
        ended_at: new Date(local(2026, 9, 2, 10, 0)).toISOString(),
      }),
    ],
    local(2026, 9, 10),
    NOW,
  );
  assert.equal(f.longest, null);
  assert.equal(f.closed, 0);
});

/* ================================================================== *
 * 7. Промежутки между кормлениями
 * ================================================================== */

test('промежуток через незаписанные сутки — это дыра в дневнике, а не голод', () => {
  const days = [];
  for (let i = 7; i >= 0; i--) {
    const ms = local(2026, 9, 16 - i);
    // Сутки в том виде, в каком их отдаёт сервер: где кормления записаны, там их счёт.
    if (i === 7) days.push(day(ms, { feeds: { total: 1 } }));
    else if (i === 1) days.push(day(ms, { feeds: { total: 2 } }));
    else days.push(day(ms));
  }
  const events = [
    ev('feed', local(2026, 9, 9, 20, 0)),
    ev('feed', local(2026, 9, 15, 8, 0)),
    ev('feed', local(2026, 9, 15, 12, 0)),
  ];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  const gaps = feedGapFacts(events, cells);

  assert.equal(gaps.longest?.minutes, 240, 'только те 4 часа, что мы действительно наблюдали');
  assert.equal(gaps.count, 1, 'шестисуточный «промежуток» не засчитан');
  assert.equal(gaps.breaks.length, 1, 'но и не потерян: это перерыв в записях');
  assert.equal(gaps.breaks[0].minutes, 6 * 24 * 60 - 12 * 60, 'с 9-го 20:00 по 15-е 8:00');
});

test('промежуток через полночь между записанными сутками засчитывается', () => {
  const days = [
    day(local(2026, 9, 15), { feeds: { total: 1 } }),
    day(local(2026, 9, 16), { feeds: { total: 2 } }),
  ];
  const events = [
    ev('feed', local(2026, 9, 15, 23, 0)),
    ev('feed', local(2026, 9, 16, 4, 30)),
    ev('feed', local(2026, 9, 16, 7, 0)),
  ];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  const gaps = feedGapFacts(events, cells);
  assert.equal(gaps.longest?.minutes, 330, '23:00 → 4:30 — пять с половиной часов');
  assert.equal(gaps.count, 2);
  assert.deepEqual(gaps.breaks, []);
});

test('дубль разбора промежутком не считается', () => {
  const days = [day(local(2026, 9, 16), { feeds: { total: 3 } })];
  const t = local(2026, 9, 16, 8, 0);
  const events = [ev('feed', t), ev('feed', t + 20_000), ev('feed', local(2026, 9, 16, 11, 0))];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  const gaps = feedGapFacts(events, cells);
  assert.equal(gaps.count, 1);
  assert.equal(gaps.longest?.minutes, 180);
});

test('одно кормление — промежутков ещё нет', () => {
  const days = [day(local(2026, 9, 16), { feeds: { total: 1 } })];
  const events = [ev('feed', local(2026, 9, 16, 8, 0))];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  const gaps = feedGapFacts(events, cells);
  assert.equal(gaps.longest, null);
  assert.equal(gaps.count, 0);
  assert.deepEqual(gaps.breaks, []);
});

test('промежуток длиннее суток — это перерыв в записях, а не наблюдение', () => {
  // Боевой случай. 14-го записали 4 кормления, 15-го — 3: оба дня записаны
  // ПО КОРМЛЕНИЯМ, проверка записанных суток их пропускает. Но между последним
  // 14-го и первым 15-го — 30 ч 6 мин, и это значит только одно: дневник вели
  // не сплошь. Врач прочитал бы «тридцать часов без еды» как факт.
  const days = [
    day(local(2026, 9, 13), { feeds: { total: 1 } }),
    day(local(2026, 9, 14), { feeds: { total: 2 } }),
    day(local(2026, 9, 15), { feeds: { total: 1 } }),
  ];
  const events = [
    ev('feed', local(2026, 9, 13, 20, 25)),
    ev('feed', local(2026, 9, 14, 7, 25)),
    ev('feed', local(2026, 9, 14, 13, 0)),
    ev('feed', local(2026, 9, 15, 19, 6)),
  ];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  const gaps = feedGapFacts(events, cells);

  assert.equal(gaps.longest?.minutes, 660, 'самый длинный из наблюдённых — 11 ч');
  assert.equal(formatMinutes(660), '11 ч');
  assert.equal(gaps.count, 2, 'тридцатичасовой в счёт промежутков не пошёл');

  // Но и не пропал: карточка обязана назвать его границами, с датами.
  assert.equal(gaps.breaks.length, 1);
  assert.equal(gaps.breaks[0].minutes, 30 * 60 + 6);
  assert.equal(
    formatSpan(gaps.breaks[0].fromAt, gaps.breaks[0].toAt),
    '14 сентября, 13:00 → 15 сентября, 19:06',
  );
});

test('ровно сутки — ещё промежуток, сутки и минута — уже перерыв', () => {
  const days = [
    day(local(2026, 9, 14), { feeds: { total: 1 } }),
    day(local(2026, 9, 15), { feeds: { total: 1 } }),
    day(local(2026, 9, 16), { feeds: { total: 1 } }),
  ];
  const exact = [ev('feed', local(2026, 9, 14, 9, 0)), ev('feed', local(2026, 9, 15, 9, 0))];
  const over = [ev('feed', local(2026, 9, 14, 9, 0)), ev('feed', local(2026, 9, 15, 9, 1))];
  const cells = buildWindow({
    days,
    events: exact,
    eventsKnown: true,
    birthMs: BIRTH,
    now: NOW,
  });

  assert.equal(feedGapFacts(exact, cells).longest?.minutes, 24 * 60);
  assert.deepEqual(feedGapFacts(exact, cells).breaks, []);
  assert.equal(feedGapFacts(over, cells).longest, null);
  assert.equal(feedGapFacts(over, cells).breaks.length, 1);
});

test('сутки, записанные одними подгузниками, промежуток через себя не пропускают', () => {
  // 11-го записали только подгузники: кормлений в этих сутках нет, и
  // промежуток с 10-го по 12-е — не наблюдение, а дыра в дневнике.
  const days = [
    day(local(2026, 9, 10), { feeds: { total: 1 } }),
    day(local(2026, 9, 11), { diapers: { wet: 4, total: 4 } }),
    day(local(2026, 9, 12), { feeds: { total: 2 } }),
  ];
  const events = [
    ev('feed', local(2026, 9, 10, 20, 0)),
    ev('diaper', local(2026, 9, 11, 9, 0), { subtype: 'wet' }),
    ev('feed', local(2026, 9, 12, 8, 0)),
    ev('feed', local(2026, 9, 12, 11, 0)),
  ];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  const gaps = feedGapFacts(events, cells);

  assert.equal(cells[1].recorded, true, 'дневник 11-го вели');
  assert.equal(cells[1].feeds, null, 'но кормлений в нём не записано');
  assert.equal(gaps.longest?.minutes, 180, 'остались только те 3 часа 12-го');
  assert.equal(gaps.breaks.length, 1, 'а 36 часов через 11-е названы перерывом в записях');
});

test('кормление, которого нет в суточной сводке, промежутка не создаёт', () => {
  // Лента событий и сводка сервера разъехались: событие успело записаться
  // между двумя запросами. Сутки, про которые сервер говорит «кормлений 0»,
  // записанными по кормлениям не считаются — иначе карточка промежутков
  // говорила бы о сутках, которые график показывает штриховкой.
  const days = [day(local(2026, 9, 15), { feeds: { total: 1 } }), day(local(2026, 9, 16))];
  const events = [ev('feed', local(2026, 9, 15, 20, 0)), ev('feed', local(2026, 9, 16, 6, 0))];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });

  assert.equal(cells[1].recorded, true, 'запись за эти сутки есть');
  assert.equal(cells[1].feeds, null, 'а в сводке кормлений за них нет');
  assert.equal(feedGapFacts(events, cells).longest, null, 'десять часов не заработаны');
});

test('удалённое кормление не растягивает промежуток', () => {
  const days = [day(local(2026, 9, 16), { feeds: { total: 2 } })];
  const events = [
    ev('feed', local(2026, 9, 16, 8, 0)),
    ev('feed', local(2026, 9, 16, 10, 0), { deleted_at: new Date(NOW).toISOString() }),
    ev('feed', local(2026, 9, 16, 12, 0)),
  ];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.equal(feedGapFacts(events, cells).longest?.minutes, 240, '8:00 → 12:00 напрямую');
});

/* ================================================================== *
 * 8. Ночные кормления
 * ================================================================== */

test('ночные кормления считаются по границе 00:00–06:00', () => {
  const days = [day(local(2026, 9, 15), { feeds: { total: 5 } })];
  const events = [
    ev('feed', local(2026, 9, 15, 0, 5)),
    ev('feed', local(2026, 9, 15, 3, 40)),
    ev('feed', local(2026, 9, 15, 5, 59)),
    ev('feed', local(2026, 9, 15, 6, 0)), // уже утро
    ev('feed', local(2026, 9, 15, 23, 50)), // ещё вечер
  ];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.equal(cells[0].nightFeeds, 3);
  assert.equal(cells[0].recorded, true);
});

test('записанные сутки без ночных кормлений — это ноль, а не пропуск', () => {
  const days = [day(local(2026, 9, 15), { feeds: { total: 1 } })];
  const events = [ev('feed', local(2026, 9, 15, 10, 0))];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.equal(cells[0].nightFeeds, 0);
});

test('сутки без записанных кормлений в знаменатель ночных не идут', () => {
  // Боевой случай целиком: окно 15 суток, кормления записаны за четверо,
  // ночное среди них одно. На экране стояло «ночью 0,1 в сутки» рядом с
  // «5,3 кормлений в сутки по записям за 4 суток» — два средних с разными
  // знаменателями бок о бок, и «0,1 из 5,3» читается как доля.
  const spec: Array<[number, number, number]> = [
    // [день, кормлений за сутки, из них ночных]
    [12, 8, 0],
    [13, 6, 1],
    [14, 4, 0],
    [15, 3, 0],
  ];
  const days: DailyStats[] = [];
  const events: TrackerEvent[] = [];
  for (let i = 14; i >= 0; i--) {
    const d = 16 - i;
    const row = spec.find(([n]) => n === d);
    days.push(row ? day(local(2026, 9, d), { feeds: { total: row[1] } }) : day(local(2026, 9, d)));
    if (!row) continue;
    for (let k = 0; k < row[1]; k++) {
      events.push(ev('feed', local(2026, 9, d, k < row[2] ? 3 : 9, k)));
    }
  }
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });

  const blank = cells.filter((c) => !c.recorded);
  assert.equal(blank.length, 11, 'одиннадцать суток окна дневник не вели вовсе');
  for (const c of blank) assert.equal(c.nightFeeds, null, 'и ночных кормлений в них не считали');

  const night = averagePerDay(cells, (c) => c.nightFeeds);
  const feeds = averagePerDay(cells, (c) => c.feeds?.total ?? null);
  assert.ok(night);
  assert.equal(night.total, 1);
  assert.equal(night.days, 4, 'делим на сутки с кормлениями');
  assert.equal(night.days, feeds?.days, 'знаменатель тот же, что у кормлений рядом');
  assert.equal(formatPerDay(night.value), '0,3');

  // Прежняя формула: то же одно кормление, делённое на все завершённые сутки.
  assert.equal(formatPerDay(1 / 14), '0,1', 'вот что стояло на экране');
});

/* ================================================================== *
 * 9. Часовые пояса и переход на летнее время
 * ================================================================== */

/**
 * Всё выше считается в местной зоне машины. Осталось проверить то, чего в
 * Москве не бывает: сутки длиной 23 и 25 часов. Если шаг по дням сделать
 * прибавлением ровных 24 часов, в такие сутки он промахнётся — и промежуток
 * между кормлениями молча начнёт проверяться не по тем суткам.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

function inTimezone(tz: string, expression: string): string {
  return execFileSync(
    process.execPath,
    ['--import', path.join(HERE, 'ts-imports.mjs'), '--input-type=module', '--eval', expression],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
  ).trim();
}

test('переход на летнее время не сбивает шаг по суткам (23-часовые сутки)', () => {
  const out = inTimezone(
    'Europe/Berlin',
    `
    import { buildWindow, feedGapFacts } from ${JSON.stringify(path.join(HERE, '../src/lib/summary.ts'))};
    const day = (d) => ({
      date: d,
      feeds: { total: 1, breast: 0, bottle: 0, solid: 0, volumeMl: null },
      diapers: { wet: 0, dirty: 0, both: 0, total: 0 },
      sleep: { totalMin: 0, sessions: 0, longestMin: 0 },
      measures: { weightG: null, heightCm: null, headCm: null, tempMaxC: null },
    });
    const ev = (id, iso) => ({ id, type: 'feed', started_at: iso });
    // Ночь перевода часов в Берлине: 2026-03-29, 02:00 → 03:00.
    const events = [
      ev(1, new Date(2026, 2, 28, 23, 0).toISOString()),
      ev(2, new Date(2026, 2, 29, 4, 0).toISOString()),
      ev(3, new Date(2026, 2, 30, 9, 0).toISOString()),
    ];
    const cells = buildWindow({
      days: ['2026-03-28', '2026-03-29', '2026-03-30'].map(day),
      events,
      eventsKnown: true,
      birthMs: new Date(2026, 2, 1).getTime(),
      now: new Date(2026, 2, 30, 20, 0).getTime(),
    });
    const g = feedGapFacts(events, cells);
    console.log(JSON.stringify({
      days: cells.map((c) => c.date),
      recorded: cells.map((c) => c.recorded),
      gapCount: g.count,
      maxMin: g.longest && g.longest.minutes,
      breaks: g.breaks.map((b) => b.minutes),
    }));
    `,
  );
  const got = JSON.parse(out);
  assert.deepEqual(got.days, ['2026-03-28', '2026-03-29', '2026-03-30']);
  assert.deepEqual(got.recorded, [true, true, true]);
  assert.equal(got.gapCount, 1, 'проверку записанных суток прошёл один промежуток');
  // 23:00 → 04:00 в сутки, потерявшие час: календарно пять часов, реально четыре.
  assert.equal(got.maxMin, 240, 'и это ровно те четыре часа, что ребёнок прожил');
  assert.deepEqual(got.breaks, [1740], 'а 29 ч со второго по третье — перерыв в записях');
});

test('в сутки перевода часов пробел в дневнике всё так же рвёт промежуток', () => {
  const out = inTimezone(
    'Europe/Berlin',
    `
    import { buildWindow, feedGapFacts } from ${JSON.stringify(path.join(HERE, '../src/lib/summary.ts'))};
    const day = (d, feeds) => ({
      date: d,
      feeds: { total: feeds, breast: 0, bottle: 0, solid: 0, volumeMl: null },
      diapers: { wet: 0, dirty: 0, both: 0, total: 0 },
      sleep: { totalMin: 0, sessions: 0, longestMin: 0 },
      measures: { weightG: null, heightCm: null, headCm: null, tempMaxC: null },
    });
    const ev = (id, iso) => ({ id, type: 'feed', started_at: iso });
    // 29 марта — сутки длиной 23 часа, и ровно в них дневник не вели.
    const events = [
      ev(1, new Date(2026, 2, 28, 23, 0).toISOString()),
      ev(2, new Date(2026, 2, 30, 9, 0).toISOString()),
    ];
    const cells = buildWindow({
      days: [day('2026-03-28', 1), day('2026-03-29', 0), day('2026-03-30', 1)],
      events,
      eventsKnown: true,
      birthMs: new Date(2026, 2, 1).getTime(),
      now: new Date(2026, 2, 30, 20, 0).getTime(),
    });
    console.log(JSON.stringify({
      recorded: cells.map((c) => c.recorded),
      gaps: feedGapFacts(events, cells),
    }));
    `,
  );
  const got = JSON.parse(out);
  assert.deepEqual(got.recorded, [true, false, true], '29-е осталось пустым');
  assert.equal(
    got.gaps.longest,
    null,
    'через пробел промежуток не считается и в сутки перевода часов',
  );
  assert.equal(got.gaps.count, 0);
  assert.equal(got.gaps.breaks.length, 1, 'зато перерыв в записях назван');
});

test('обратный перевод часов (25-часовые сутки) тоже не ломает шаг', () => {
  const out = inTimezone(
    'Europe/Berlin',
    `
    import { buildWindow, feedGapFacts } from ${JSON.stringify(path.join(HERE, '../src/lib/summary.ts'))};
    const day = (d) => ({
      date: d,
      feeds: { total: 1, breast: 0, bottle: 0, solid: 0, volumeMl: null },
      diapers: { wet: 0, dirty: 0, both: 0, total: 0 },
      sleep: { totalMin: 0, sessions: 0, longestMin: 0 },
      measures: { weightG: null, heightCm: null, headCm: null, tempMaxC: null },
    });
    const ev = (id, iso) => ({ id, type: 'feed', started_at: iso });
    // Ночь 2026-10-25: 03:00 → 02:00, сутки длиной 25 часов.
    const events = [
      ev(1, new Date(2026, 9, 24, 22, 0).toISOString()),
      ev(2, new Date(2026, 9, 25, 5, 0).toISOString()),
      ev(3, new Date(2026, 9, 26, 8, 0).toISOString()),
    ];
    const cells = buildWindow({
      days: ['2026-10-24', '2026-10-25', '2026-10-26'].map(day),
      events,
      eventsKnown: true,
      birthMs: new Date(2026, 9, 1).getTime(),
      now: new Date(2026, 9, 26, 20, 0).getTime(),
    });
    const g = feedGapFacts(events, cells);
    console.log(JSON.stringify({
      days: cells.map((c) => c.date),
      recorded: cells.map((c) => c.recorded),
      gapCount: g.count,
      maxMin: g.longest && g.longest.minutes,
      breaks: g.breaks.map((b) => b.minutes),
    }));
    `,
  );
  const got = JSON.parse(out);
  assert.deepEqual(got.days, ['2026-10-24', '2026-10-25', '2026-10-26']);
  assert.deepEqual(got.recorded, [true, true, true]);
  assert.equal(got.gapCount, 1);
  // 22:00 → 05:00 в сутки, получившие лишний час: календарно семь, реально восемь.
  assert.equal(got.maxMin, 480, 'считаем прожитое время, а не деления календаря');
  assert.deepEqual(got.breaks, [27 * 60], 'а 27 ч со второго по третье — перерыв в записях');
});

test('событие в 00:30 относится к новым суткам, а не к прошедшим', () => {
  const days = [day(local(2026, 9, 15)), day(local(2026, 9, 16), { feeds: { total: 1 } })];
  const events = [ev('feed', local(2026, 9, 16, 0, 30))];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.equal(cells[0].recorded, false, '15-е осталось пустым');
  assert.equal(cells[1].recorded, true);
  assert.equal(cells[1].nightFeeds, 1);
});
