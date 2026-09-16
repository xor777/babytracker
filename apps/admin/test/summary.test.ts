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
  feedGapFacts,
  sleepFacts,
  weeks,
  weightFacts,
} from '../src/lib/summary';
import type { DayCell } from '../src/lib/summary';
import { formatMinutes, formatPerDay, formatSignedGrams, localDateKey } from '../src/lib/format';
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
  for (let i = 7; i >= 0; i--) days.push(day(local(2026, 9, 16 - i)));
  const events = [
    ev('feed', local(2026, 9, 9, 20, 0)),
    ev('feed', local(2026, 9, 15, 8, 0)),
    ev('feed', local(2026, 9, 15, 12, 0)),
  ];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  const gaps = feedGapFacts(events, cells);

  assert.ok(gaps);
  assert.equal(gaps.maxMin, 240, 'только те 4 часа, что мы действительно наблюдали');
  assert.equal(gaps.count, 1, 'шестисуточный «промежуток» не засчитан');
});

test('промежуток через полночь между записанными сутками засчитывается', () => {
  const days = [day(local(2026, 9, 15)), day(local(2026, 9, 16))];
  const events = [
    ev('feed', local(2026, 9, 15, 23, 0)),
    ev('feed', local(2026, 9, 16, 4, 30)),
    ev('feed', local(2026, 9, 16, 7, 0)),
  ];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  const gaps = feedGapFacts(events, cells);
  assert.equal(gaps?.maxMin, 330, '23:00 → 4:30 — пять с половиной часов');
  assert.equal(gaps?.count, 2);
});

test('дубль разбора промежутком не считается', () => {
  const days = [day(local(2026, 9, 16))];
  const t = local(2026, 9, 16, 8, 0);
  const events = [ev('feed', t), ev('feed', t + 20_000), ev('feed', local(2026, 9, 16, 11, 0))];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  const gaps = feedGapFacts(events, cells);
  assert.equal(gaps?.count, 1);
  assert.equal(gaps?.maxMin, 180);
});

test('одно кормление — промежутков ещё нет', () => {
  const days = [day(local(2026, 9, 16))];
  const events = [ev('feed', local(2026, 9, 16, 8, 0))];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.equal(feedGapFacts(events, cells), null);
});

test('удалённое кормление не растягивает промежуток', () => {
  const days = [day(local(2026, 9, 16))];
  const events = [
    ev('feed', local(2026, 9, 16, 8, 0)),
    ev('feed', local(2026, 9, 16, 10, 0), { deleted_at: new Date(NOW).toISOString() }),
    ev('feed', local(2026, 9, 16, 12, 0)),
  ];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.equal(feedGapFacts(events, cells)?.maxMin, 240, '8:00 → 12:00 напрямую');
});

/* ================================================================== *
 * 8. Ночные кормления
 * ================================================================== */

test('ночные кормления считаются по границе 00:00–06:00', () => {
  const days = [day(local(2026, 9, 15))];
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
  const days = [day(local(2026, 9, 15))];
  const events = [ev('feed', local(2026, 9, 15, 10, 0))];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.equal(cells[0].nightFeeds, 0);
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
      maxMin: g.maxMin,
    }));
    `,
  );
  const got = JSON.parse(out);
  assert.deepEqual(got.days, ['2026-03-28', '2026-03-29', '2026-03-30']);
  assert.deepEqual(got.recorded, [true, true, true]);
  assert.equal(got.gapCount, 2, 'оба промежутка прошли проверку записанных суток');
  // 23:00 → 04:00 в сутки, потерявшие час: календарно пять часов, реально четыре.
  assert.equal(got.maxMin, 1740, 'а самый длинный — 29 ч, со второго по третье');
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
  assert.equal(got.gaps, null, 'через пробел промежуток не считается и в сутки перевода часов');
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
    }));
    `,
  );
  const got = JSON.parse(out);
  assert.deepEqual(got.days, ['2026-10-24', '2026-10-25', '2026-10-26']);
  assert.deepEqual(got.recorded, [true, true, true]);
  assert.equal(got.gapCount, 2);
});

test('событие в 00:30 относится к новым суткам, а не к прошедшим', () => {
  const days = [day(local(2026, 9, 15)), day(local(2026, 9, 16))];
  const events = [ev('feed', local(2026, 9, 16, 0, 30))];
  const cells = buildWindow({ days, events, eventsKnown: true, birthMs: BIRTH, now: NOW });
  assert.equal(cells[0].recorded, false, '15-е осталось пустым');
  assert.equal(cells[1].recorded, true);
  assert.equal(cells[1].nightFeeds, 1);
});
