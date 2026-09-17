/**
 * Раскладка знаков на полосе суток и промежутки между кормлениями.
 *
 * Полоса читается ПО ШТУКАМ: сколько событий, столько и знаков. Всё остальное
 * — правила, при которых это остаётся правдой: порядок, просвет, сдвиг не
 * дальше половины знака и подпись числом там, где развести нельзя.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { feedGaps, layoutMarks } from '../src/lib/timeline';
import type { MarkSlot, TimeMark } from '../src/lib/timeline';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const T0 = Date.parse('2026-09-15T06:00:00.000Z');

function mark(minutesFromT0: number): TimeMark {
  return { at: T0 + minutesFromT0 * MINUTE, pos: 0, label: '' };
}

/**
 * Полоса телефона: 336 точек на сутки, знак 8 точек, просвет 3, сдвиг не
 * дальше половины знака. Ровно те же числа, что в DayStrip.tsx.
 */
const WIDTH_PX = 336;
const PITCH = 11 / WIDTH_PX;
const MAX_SHIFT = 4 / WIDTH_PX;
const PHONE = { pitch: PITCH, maxShift: MAX_SHIFT };

const MIDNIGHT = Date.parse('2026-09-16T00:00:00.000Z');

/** Метка на полосе суток: `min` минут от полуночи. */
function atMin(min: number): TimeMark {
  return { at: MIDNIGHT + min * MINUTE, pos: (min * MINUTE) / DAY, label: '' };
}

/** Доли суток обратно в минуты — в них видно, о каком сдвиге речь. */
function minutes(share: number): number {
  return share * 24 * 60;
}

/** Настоящий день 16 сентября: пятнадцать кормлений. */
const REAL_DAY = [
  19, 179, 299, 495, 555, 736, 851, 913, 1075, 1115, 1173, 1201, 1243, 1308, 1370,
].map(atMin);

function positions(slots: MarkSlot[]): number[] {
  return slots.map((s) => s.pos);
}

test('знаков ровно столько, сколько событий', () => {
  const slots = layoutMarks(REAL_DAY, PHONE);
  assert.equal(slots.length, REAL_DAY.length);
  assert.deepEqual(
    slots.map((s) => s.count),
    REAL_DAY.map(() => 1),
  );
});

test('порядок знаков — порядок событий', () => {
  const slots = layoutMarks(REAL_DAY, PHONE);
  for (let i = 1; i < slots.length; i++) {
    assert.ok(slots[i].pos > slots[i - 1].pos, `знак ${i} встал левее предыдущего`);
    assert.ok(slots[i].firstAt > slots[i - 1].firstAt, `знак ${i} взял время не по порядку`);
  }
});

test('между соседними знаками остаётся просвет', () => {
  const slots = layoutMarks(REAL_DAY, PHONE);
  for (let i = 1; i < slots.length; i++) {
    const gap = slots[i].pos - slots[i - 1].pos;
    assert.ok(gap >= PITCH - 1e-9, `знаки ${i - 1} и ${i} слиплись: ${minutes(gap).toFixed(1)} мин`);
  }
});

test('раздвинутая пачка держится центром на своём времени', () => {
  // Три кормления через сорок минут: просвету не хватает семи, и пачка
  // расправляется — но не уезжает ни вправо, ни влево.
  const pack = [400, 440, 480].map(atMin);
  const slots = layoutMarks(pack, PHONE);

  assert.equal(slots.length, 3);
  assert.ok(
    Math.abs(slots[1].pos - pack[1].pos) < 1e-12,
    'середина пачки уехала со своего времени',
  );
  const centre = positions(slots).reduce((s, p) => s + p, 0) / slots.length;
  assert.ok(Math.abs(centre - pack[1].pos) < 1e-12, 'пачка уехала целиком');
  assert.ok(slots[0].pos < pack[0].pos && slots[2].pos > pack[2].pos, 'пачка не расправилась');
});

test('знак не уходит со своего времени дальше половины себя', () => {
  const slots = layoutMarks(REAL_DAY, PHONE);
  slots.forEach((s, i) => {
    const shift = Math.abs(s.pos - REAL_DAY[i].pos);
    assert.ok(
      shift <= MAX_SHIFT + 1e-9,
      `знак ${i} уехал на ${minutes(shift).toFixed(1)} мин при пределе ${minutes(MAX_SHIFT).toFixed(1)}`,
    );
  });
});

test('пачку, которую не раздвинуть, подписываем числом', () => {
  // Шесть кормлений за сорок минут. Раздвинуть их — нарисовать четыре часа
  // кормлений, которых не было; поэтому часть знаков становится общей.
  const dense = [600, 608, 616, 624, 632, 640].map(atMin);
  const slots = layoutMarks(dense, PHONE);

  assert.ok(slots.length < dense.length, 'такая плотность обязана была схлопнуться');
  assert.equal(
    slots.reduce((s, x) => s + x.count, 0),
    dense.length,
    'события потерялись при слиянии',
  );
  assert.ok(
    slots.some((s) => s.count > 1),
    'нет ни одного знака с числом — считать нечем',
  );
  assert.equal(slots[0].firstAt, dense[0].at);
  assert.equal(slots[slots.length - 1].lastAt, dense[dense.length - 1].at);
  for (const s of slots) {
    assert.ok(s.firstAt <= s.lastAt, 'края знака перепутаны местами');
  }
});

test('тесная пачка не портит соседнюю, которую развести можно', () => {
  // 05:00 и 05:20 разводятся честно, а 13:20, 13:45 и 14:10 — уже нет.
  // Слить обязано там, где тесно, а не там, где просто ближе всего.
  const marks = [300, 320, 800, 825, 850].map(atMin);
  const slots = layoutMarks(marks, PHONE);
  const noon = atMin(600).at;

  assert.deepEqual(
    slots.filter((s) => s.firstAt < noon).map((s) => s.count),
    [1, 1],
    'пару, которая разводится, слили заодно с чужой теснотой',
  );
  const late = slots.filter((s) => s.firstAt >= noon);
  assert.equal(
    late.reduce((sum, s) => sum + s.count, 0),
    3,
    'события из тесной тройки потерялись',
  );
  assert.ok(late.some((s) => s.count > 1), 'тесную тройку обязано было схлопнуть');
});

test('у полуночи пачка расправляется внутрь суток, а не за край', () => {
  // Два кормления в 00:05 и 00:40: просвет требует развести их сильнее, но
  // левее полуночи на полосе места нет.
  const pack = [5, 40].map(atMin);
  const slots = layoutMarks(pack, PHONE);

  assert.equal(slots.length, 2);
  assert.ok(slots[0].pos >= 0, 'знак уехал левее начала суток');
  assert.ok(slots[1].pos <= 1, 'знак уехал правее конца суток');
  assert.ok(slots[1].pos - slots[0].pos >= PITCH - 1e-9, 'у края просвет потерялся');
});

test('пока ширина полосы не измерена, знаки стоят на своих временах', () => {
  const pack = [400, 405, 410].map(atMin);
  const slots = layoutMarks(pack, { pitch: 0, maxShift: 0 });
  assert.deepEqual(
    positions(slots),
    pack.map((m) => m.pos),
  );
  assert.deepEqual(
    slots.map((s) => s.count),
    [1, 1, 1],
  );
});

test('дубль разбора не теряется: один знак, но с числом 2', () => {
  // «Покормила» и следом «грудью» — два события в одну минуту. Развести их
  // можно только соврав про время, поэтому знак один, зато подписан.
  const slots = layoutMarks([600, 600].map(atMin), PHONE);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].count, 2);
  assert.ok(Math.abs(slots[0].pos - atMin(600).pos) < 1e-12, 'знак уехал со своего времени');
});

test('на широком экране раздвигать нечего', () => {
  // Тот же день в браузере на мониторе: 1100 точек, просвет вчетверо мельче.
  const wide = { pitch: 11 / 1100, maxShift: 4 / 1100 };
  const slots = layoutMarks(REAL_DAY, wide);
  assert.equal(slots.length, REAL_DAY.length);
  slots.forEach((s, i) => {
    assert.ok(Math.abs(s.pos - REAL_DAY[i].pos) < 1e-12, `знак ${i} сдвинули без нужды`);
  });
});

test('меньше двух кормлений — промежутков ещё нет', () => {
  assert.equal(feedGaps([]), null);
  assert.equal(feedGaps([mark(0)]), null);
});

test('два кормления в одну минуту — это дубль, а не промежуток', () => {
  assert.equal(feedGaps([mark(0), mark(0)]), null);
});

test('дубль не тянет средний промежуток к нулю', () => {
  // Разбор записал кормление дважды, а настоящий промежуток — три часа.
  const gaps = feedGaps([mark(0), mark(0), mark(180)]);
  assert.deepEqual(gaps, { avgMin: 180, maxMin: 180 });
});

test('обычные промежутки считаются как раньше', () => {
  assert.deepEqual(feedGaps([mark(0), mark(120), mark(300)]), { avgMin: 150, maxMin: 180 });
});
