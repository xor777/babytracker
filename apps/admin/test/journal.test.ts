/**
 * Журнал целиком: от ответа сервера до текста в свёрнутой строке.
 *
 * Сценарий взят с прода один в один — ровно те две строки, на которые
 * пожаловался заказчик («странное событие "что он проснулся"» и «мокрый
 * подгузник 0 минут»).
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildJournal } from '../src/lib/journal';
import type { PhraseRowData, EventRowData } from '../src/lib/journal';
import { describePhrase, summaryLine } from '../src/lib/describe';
import { classifyPhrase } from '../src/lib/utterance';
import type { ChangeSet, TrackerEvent, Utterance } from '../src/types';

/** Ночной сон, начатый вечером и закрытый утром. */
const nightSleep: TrackerEvent = {
  id: 15,
  type: 'sleep',
  subtype: 'night',
  started_at: '2026-09-14T19:05:00.000Z',
  ended_at: '2026-09-15T02:15:00.000Z',
  utterance_id: 12,
  source: 'alice-fast',
  confidence: 0.95,
};

/** Точечный подгузник: модель поставила ended_at равным started_at. */
const diaper: TrackerEvent = {
  id: 16,
  type: 'diaper',
  subtype: 'wet',
  started_at: '2026-09-15T18:04:00.000Z',
  ended_at: '2026-09-15T18:04:00.000Z',
  utterance_id: 34,
  source: 'alice-llm',
  confidence: 0.9,
};

/** Фраза, разобранная моделью: событий не создала, закрыла чужой сон. */
const woke: Utterance = {
  id: 35,
  raw_text: 'что он проснулся',
  received_at: '2026-09-15T02:15:00.000Z',
  status: 'done',
  fast_result: null,
};

const wokeSet: ChangeSet = {
  id: 'cs-0009',
  utterance_id: 35,
  summary: 'Разбор фразы моделью: «что он проснулся»',
  created_at: '2026-09-15T02:15:00.000Z',
  reverted_at: null,
  revisions: 1,
  events: [15],
};

function build(events: TrackerEvent[], orphans: Utterance[], sets: ChangeSet[]) {
  const setsByUtterance = new Map<number, ChangeSet[]>();
  for (const cs of sets) {
    if (cs.utterance_id == null) continue;
    const list = setsByUtterance.get(cs.utterance_id);
    if (list) list.push(cs);
    else setsByUtterance.set(cs.utterance_id, [cs]);
  }
  return buildJournal({
    events,
    orphans,
    setsByUtterance,
    eventsById: new Map(events.map((e) => [e.id, e])),
    utterancesById: new Map(orphans.map((u) => [u.id, u])),
  });
}

function rows(sections: ReturnType<typeof build>) {
  return sections.flatMap((s) => s.rows);
}

test('СКВОЗНОЕ: обе строки со скриншота заказчика читаются в разобранном виде', () => {
  const all = rows(build([nightSleep, diaper], [woke], [wokeSet]));

  const phrase = all.find((r): r is PhraseRowData => r.kind === 'phrase' && r.utterance.id === 35);
  assert.ok(phrase, 'фраза, закрывшая сон, обязана быть в журнале');
  assert.deepEqual(
    phrase.touched.map((e) => e.id),
    [15],
    'фраза изменила сон, не создав событий',
  );
  assert.equal(
    describePhrase(phrase.utterance.raw_text, phrase.touched, phrase.changeSets).text,
    'Сон, ночной — завершён, 7 ч 10 мин',
  );
  assert.equal(phrase.needsCheck, false, 'разбор прошёл штатно — метить нечего');

  const wet = all.find((r): r is EventRowData => r.kind === 'event' && r.event.id === 16);
  assert.ok(wet);
  assert.equal(summaryLine(wet.event), 'Подгузник, мокрый');
});

test('фраза стоит в ленте по времени, когда её услышали', () => {
  const all = rows(build([nightSleep, diaper], [woke], [wokeSet]));
  // Новое сверху, без исключений: подгузник 21:04 выше фразы 05:15.
  const order = all.map((r) => (r.kind === 'event' ? `e${r.event.id}` : `u${r.utterance.id}`));
  assert.deepEqual(order.slice(0, 2), ['e16', 'u35']);
});

test('без набора изменений фраза остаётся цитатой, а не выдаёт себя за разбор', () => {
  const all = rows(build([nightSleep, diaper], [woke], []));
  const phrase = all.find((r): r is PhraseRowData => r.kind === 'phrase');
  // classifyPhrase на status=done молчит, поэтому такой фразы в ленте быть и не должно;
  // но если она туда попала, показывать мы обязаны именно цитату.
  if (phrase) {
    assert.deepEqual(phrase.touched, []);
    assert.equal(
      describePhrase(phrase.utterance.raw_text, phrase.touched, phrase.changeSets).quote,
      true,
    );
  }
});

// ------------------------------------------------------------ три смысла skipped

test('classifyPhrase по-прежнему разводит три смысла статуса skipped', () => {
  const base = { id: 1, raw_text: 'x', received_at: '2026-09-15T10:00:00.000Z' };

  // 1. вопрос к Алисе — не дневник ребёнка вовсе
  assert.equal(
    classifyPhrase({ ...base, status: 'skipped', fast_result: { kind: 'query_state' } }).show,
    false,
  );
  // 2. матчер справился сам — это успех, а не пробел
  assert.equal(
    classifyPhrase({ ...base, status: 'skipped', fast_result: { kind: 'sleep_end' } }).show,
    false,
  );
  // 3. фразу никто не разобрал — вот это настоящий пробел
  const gap = classifyPhrase({ ...base, status: 'skipped', fast_result: { kind: 'unknown' } });
  assert.equal(gap.show, true);
  assert.equal(gap.show && gap.tone, 'gap');
});

test('неразобранная фраза помечается «стоит проверить» и остаётся цитатой', () => {
  const lost: Utterance = {
    id: 40,
    raw_text: 'он какой-то беспокойный и кряхтит',
    received_at: '2026-09-15T12:40:00.000Z',
    status: 'skipped',
    fast_result: { kind: 'unknown' },
  };
  const all = rows(build([], [lost], []));
  const phrase = all.find((r): r is PhraseRowData => r.kind === 'phrase');
  assert.ok(phrase);
  assert.equal(phrase.needsCheck, true);
  const s = describePhrase(phrase.utterance.raw_text, phrase.touched, phrase.changeSets);
  assert.equal(s.quote, true, 'цитата здесь единственный факт — убирать её нельзя');
  assert.equal(s.text, '«он какой-то беспокойный и кряхтит»');
});
