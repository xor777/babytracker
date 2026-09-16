/**
 * Наблюдения-состояния в «Сводке» (§10.2).
 *
 * Раздел показывают врачу, и от него требуется ровно одно: сказать, ЧТО
 * РОДИТЕЛИ ВИДЕЛИ И КОГДА. Ни причины, ни оценки, ни медицинского названия.
 * Тесты сторожат именно эту границу, а не вёрстку.
 *
 * Дата рождения здесь настоящая — 2 сентября 2026, как у Андрея. День жизни
 * считается с единицы: сутки рождения — «1-й день», поэтому 6 сентября это
 * 5-й день. Сдвиг на единицу тут — самая дешёвая и самая незаметная ошибка,
 * поэтому он проверяется отдельно.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { dayOfLife, observationFacts, observationPhrase } from '../src/lib/summary';
import { stateSubtypes, subtypeAccusative, subtypeLabel } from '../src/lib/taxonomy';
import type { TrackerEvent } from '../src/types';

function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

const BIRTH = local(2026, 9, 2, 4, 35);
const NOW = local(2026, 9, 16, 15, 0);

let seq = 0;
/** Наблюдение. `endedAt === undefined` — держится; равный началу — отметка поверх. */
function obs(
  subtype: string,
  startedAt: number,
  endedAt?: number | null,
): TrackerEvent {
  return {
    id: ++seq,
    type: 'symptom',
    subtype,
    started_at: new Date(startedAt).toISOString(),
    ended_at: endedAt == null ? null : new Date(endedAt).toISOString(),
  } as TrackerEvent;
}

const SKIN = stateSubtypes().map((x) => x.subtype);
const facts = (events: TrackerEvent[]) =>
  observationFacts(events, SKIN, { birthMs: BIRTH, windowStartMs: BIRTH });
const phrase = (events: TrackerEvent[], subtype = 'skin_yellow') => {
  const f = facts(events).find((x) => x.subtype === subtype);
  assert.ok(f, `наблюдения ${subtype} не нашлось`);
  return observationPhrase(f, subtypeAccusative('symptom', subtype));
};

/* ================================================================== *
 * 1. День жизни: сутки рождения — первые
 * ================================================================== */

test('день жизни считается с единицы, а не с нуля', () => {
  assert.equal(dayOfLife(BIRTH, BIRTH), 1, 'сутки рождения — 1-й день');
  assert.equal(dayOfLife(BIRTH, local(2026, 9, 6, 9, 0)), 5, '6 сентября — 5-й день');
  assert.equal(dayOfLife(BIRTH, local(2026, 9, 10, 23, 30)), 9, '10 сентября — 9-й день');
  assert.equal(dayOfLife(null, NOW), null, 'без даты рождения дней жизни нет');
});

/* ================================================================== *
 * 2. Фраза, которую читает врач
 * ================================================================== */

test('завершённое наблюдение: «с 5-го по 9-й день»', () => {
  const events = [obs('skin_yellow', local(2026, 9, 6, 9, 0), local(2026, 9, 10, 12, 0))];
  assert.equal(
    phrase(events),
    'Родители отмечали желтизну кожи с 5-го по 9-й день.',
  );
});

test('незавершённое наблюдение: «отмечают с 5-го дня, продолжается»', () => {
  const events = [obs('skin_yellow', local(2026, 9, 6, 9, 0))];
  assert.equal(
    phrase(events),
    'Родители отмечают желтизну кожи с 5-го дня, продолжается.',
  );
});

test('белки глаз — своя фраза, своё наблюдение', () => {
  const events = [
    obs('skin_yellow', local(2026, 9, 6, 9, 0), local(2026, 9, 10, 12, 0)),
    obs('eyes_yellow', local(2026, 9, 7, 9, 0)),
  ];
  const all = facts(events);
  assert.equal(all.length, 2, 'кожа и глаза считаются по отдельности');

  assert.equal(
    phrase(events, 'eyes_yellow'),
    'Родители отмечают желтизну белков глаз с 6-го дня, продолжается.',
  );
  // Кожа уже прошла, глаза ещё нет — и глагол у каждого свой.
  assert.match(phrase(events, 'skin_yellow'), /^Родители отмечали/);
});

test('наблюдение на одни сутки не превращается в «с 5-го по 5-й»', () => {
  const events = [obs('skin_yellow', local(2026, 9, 6, 9, 0), local(2026, 9, 6, 21, 0))];
  assert.equal(phrase(events), 'Родители отмечали желтизну кожи на 5-й день.');
});

/* ================================================================== *
 * 3. Отметки поверх состояния границ не двигают
 * ================================================================== */

test('«стало желтее» — отметка поверх, а не второе состояние и не новая граница', () => {
  const events = [
    obs('skin_yellow', local(2026, 9, 6, 9, 0), local(2026, 9, 10, 12, 0)),
    // Точка внутри отрезка: ended_at равен started_at.
    obs('skin_yellow', local(2026, 9, 8, 14, 0), local(2026, 9, 8, 14, 0)),
  ];

  const f = facts(events)[0];
  assert.equal(f.spans.length, 1, 'отметка не завела второго отрезка');
  assert.equal(f.marks.length, 1);
  assert.equal(f.records, 2, 'но в записях учтены обе');
  assert.equal(f.spans[0].fromDay, 5);
  assert.equal(f.spans[0].toDay, 9, 'граница осталась там, где её поставили');
  assert.equal(phrase(events), 'Родители отмечали желтизну кожи с 5-го по 9-й день.');
});

test('«почти сошла» после конца отрезка не воскрешает состояние', () => {
  const events = [
    obs('skin_yellow', local(2026, 9, 6, 9, 0), local(2026, 9, 10, 12, 0)),
    obs('skin_yellow', local(2026, 9, 12, 10, 0), local(2026, 9, 12, 10, 0)),
  ];
  const f = facts(events)[0];
  assert.equal(f.ongoing, false, 'отметка — не открытое состояние');
  assert.equal(f.spans.length, 1);
  assert.equal(f.spans[0].toDay, 9);
});

test('одни отметки без протяжённости: отрезок не выдумывается', () => {
  // Соблазн натянуть отрезок от первой отметки до последней живёт именно здесь:
  // между ними наблюдения могло не быть вовсе, и отрезок был бы выводом.
  const events = [
    obs('skin_yellow', local(2026, 9, 6, 9, 0), local(2026, 9, 6, 9, 0)),
    obs('skin_yellow', local(2026, 9, 9, 9, 0), local(2026, 9, 9, 9, 0)),
  ];
  const f = facts(events)[0];
  assert.equal(f.spans.length, 0);
  assert.equal(
    phrase(events),
    'Родители отмечали желтизну кожи — 2 записи, протяжённость не записана.',
  );
});

/* ================================================================== *
 * 4. Честность окна и слияние
 * ================================================================== */

test('два открытых состояния подряд — сбой разбора, а не два эпизода', () => {
  const events = [
    obs('skin_yellow', local(2026, 9, 6, 9, 0)),
    obs('skin_yellow', local(2026, 9, 8, 9, 0)),
  ];
  const f = facts(events)[0];
  assert.equal(f.spans.length, 1, 'пересекающиеся отрезки слиты');
  assert.equal(f.spans[0].fromDay, 5, 'начало — раннее из двух');
  assert.equal(f.ongoing, true);
});

test('раздельные эпизоды остаются раздельными', () => {
  const events = [
    obs('skin_yellow', local(2026, 9, 4, 9, 0), local(2026, 9, 6, 9, 0)),
    obs('skin_yellow', local(2026, 9, 10, 9, 0), local(2026, 9, 12, 9, 0)),
  ];
  const f = facts(events)[0];
  assert.equal(f.spans.length, 2);
  assert.equal(
    phrase(events),
    'Родители отмечали желтизну кожи с 3-го по 5-й день и с 9-го по 11-й день.',
  );
});

test('запись на краю окна помечается: «с 5-го дня» может быть началом окна, а не наблюдения', () => {
  const windowStart = local(2026, 9, 10, 0, 0);
  const events = [obs('skin_yellow', local(2026, 9, 10, 9, 0))];
  const [f] = observationFacts(events, SKIN, { birthMs: BIRTH, windowStartMs: windowStart });
  assert.equal(f.atWindowEdge, true, 'что было до окна, мы не знаем и утверждать не можем');

  const [inside] = observationFacts([obs('skin_yellow', local(2026, 9, 12, 9, 0))], SKIN, {
    birthMs: BIRTH,
    windowStartMs: windowStart,
  });
  assert.equal(inside.atWindowEdge, false);
});

test('удалённые записи в сводку не идут', () => {
  const e = obs('skin_yellow', local(2026, 9, 6, 9, 0));
  e.deleted_at = new Date(NOW).toISOString();
  assert.equal(facts([e]).length, 0);
});

test('нет наблюдений — нет и карточки: пустое не выдаётся за «не было»', () => {
  assert.equal(facts([]).length, 0);
});

/* ================================================================== *
 * 5. Диагноза на экране нет
 * ================================================================== */

test('ни подпись, ни фраза не произносят диагноз', () => {
  const DIAGNOSIS = /желтух|jaundice|icterus|билирубин/i;

  for (const { type, subtype } of stateSubtypes()) {
    assert.doesNotMatch(subtype, DIAGNOSIS, `id ${subtype}`);
    assert.doesNotMatch(String(subtypeLabel(type, subtype)), DIAGNOSIS);
    assert.doesNotMatch(subtypeAccusative(type, subtype), DIAGNOSIS);
  }

  const cases: TrackerEvent[][] = [
    [obs('skin_yellow', local(2026, 9, 6, 9, 0))],
    [obs('skin_yellow', local(2026, 9, 6, 9, 0), local(2026, 9, 10, 12, 0))],
    [obs('eyes_yellow', local(2026, 9, 6, 9, 0))],
  ];
  for (const events of cases) {
    for (const f of facts(events)) {
      const line = observationPhrase(f, subtypeAccusative('symptom', f.subtype));
      assert.doesNotMatch(line, DIAGNOSIS, line);
      // И никакой оценки: «норма», «повышен», «опасно» — не наше дело.
      assert.doesNotMatch(line, /норм|опасн|повышен|тревож|срочно/i, line);
    }
  }
});

test('подпись склоняется: «отмечали желтизну кожи», а не «желтизна кожи»', () => {
  assert.equal(subtypeLabel('symptom', 'skin_yellow'), 'желтизна кожи');
  assert.equal(subtypeAccusative('symptom', 'skin_yellow'), 'желтизну кожи');
  assert.equal(subtypeAccusative('symptom', 'eyes_yellow'), 'желтизну белков глаз');
  // У подтипа без винительного падежа откат на именительный, но не на пустоту.
  assert.equal(subtypeAccusative('symptom', 'colic'), 'колики');
});
