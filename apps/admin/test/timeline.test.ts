/**
 * Промежутки между кормлениями — тот же класс, что «0 мин» в строке журнала:
 * нулевой промежуток не промежуток, а дубль разбора. «Между кормлениями
 * в среднем 0 мин» ничего не сообщает, зато выглядит поломкой.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { feedGaps } from '../src/lib/timeline';
import type { TimeMark } from '../src/lib/timeline';

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-15T06:00:00.000Z');

function mark(minutesFromT0: number): TimeMark {
  return { at: T0 + minutesFromT0 * MINUTE, pos: 0, label: '' };
}

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
