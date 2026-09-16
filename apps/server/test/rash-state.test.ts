/**
 * Сыпь как наблюдение-СОСТОЯНИЕ (§10.2).
 *
 * Врач спрашивает про сыпь ровно то же, что про желтизну: когда появилась и
 * прошла ли. Точками этого не записать, поэтому `symptom/rash` получил ту же
 * механику, что `skin_yellow`: `started_at` — когда заметили, `ended_at = NULL`
 * — держится, `ended_at` — когда сошла.
 *
 * Здесь проверяется ПОВЕДЕНИЕ конвейера, а не то, как модель разберёт фразу.
 *
 * Границы, которые сторожит этот файл:
 *
 *   1. Быстрый матчер не тронут. Корень «сып» стоял в его словаре доменов
 *      ЗАДОЛГО до этой правки — новых слов ему не добавляли, — и фраза про
 *      сыпь уходит модели, а вслух звучит обычное «Приняла».
 *   2. Открытая сыпь не считается провисевшей: `MAX_OPEN_MIN` на неё
 *      не распространяется, как и на желтизну.
 *   3. Диагноза нет нигде: ни «аллергии», ни «потницы», ни «диатеза».
 *      Родитель видит сыпь, а не её причину.
 *   4. Границы разбора: «покраснел» и голое «пятно» состоянием НЕ считаются,
 *      «пятнышки» — считаются. См. `STATE_WORDS` в prompt.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TEST_SECRET, aliceBody, makeTestApp, testConfig, testDb } from './helpers.ts';
import { ACK } from '../src/alice.ts';
import { getState, insertEvent, openStateEvents, queryEvents, updateEvent } from '../src/events.ts';
import { matchFast, detectDomains, normalize } from '../src/fastpath.ts';
import { decideQueue } from '../src/queue-policy.ts';
import { buildPrompt, isDurative, isStaleOpen } from '../src/prompt.ts';
import { STATE_SUBTYPES, TAXONOMY, isStateSubtype } from '../src/taxonomy.ts';

const URL_OK = `/alice/${TEST_SECRET}`;
const cfg = testConfig();
const NOW = new Date('2026-03-15T12:00:00Z');

/** Фразы, которыми родитель на самом деле про это говорит. */
const PHRASES = [
  'у него сыпь на щеках',
  'высыпало по всему телу',
  'какие-то прыщики появились',
  'сыпь прошла',
];

/* ------------------------------------------------------------------ */
/* 1. Быстрый матчер не тронут и фразу не проглатывает                  */
/* ------------------------------------------------------------------ */

test('матчер не пишет событий по сыпи: это не его дело', () => {
  for (const phrase of PHRASES) {
    const fast = matchFast(phrase, undefined, { now: NOW });
    assert.equal(
      fast.kind,
      'unknown',
      `«${phrase}» матчер разбирать не должен — наблюдение разбирает модель`,
    );
  }
});

test('фраза про сыпь уходит модели при любой политике очереди', () => {
  for (const phrase of PHRASES) {
    const fast = matchFast(phrase, undefined, { now: NOW });
    for (const policy of ['all', 'smart', 'unknown'] as const) {
      const d = decideQueue({ policy, threshold: 0.75, fast, command: phrase });
      assert.equal(d.queue, true, `«${phrase}» при политике ${policy} обязана уйти модели`);
    }
  }
});

test('сыпь в составной фразе не даёт матчеру закрыть её кормлением', () => {
  // Живой способ потерять наблюдение: матчер уверенно разбирает знакомую
  // половину фразы, а незнакомая пропадает молча (§10.3). Корень «сып»
  // в DOMAIN_STEMS стоял и до этой правки — словарь матчера не менялся.
  const phrase = 'покормила, и сыпь на щеках появилась';
  assert.ok(
    detectDomains(normalize(phrase)).has('symptom'),
    'корень «сып» обязан поднимать домен symptom',
  );
  const fast = matchFast(phrase, undefined, { now: NOW });
  assert.equal(
    decideQueue({ policy: 'smart', threshold: 0.75, fast, command: phrase }).queue,
    true,
  );
});

test('голосом на сыпь отвечаем обычное «Приняла», без своей интерпретации', async (t) => {
  const h = await makeTestApp({ LLM_QUEUE_POLICY: 'all' });
  t.after(() => h.close());

  for (const phrase of PHRASES) {
    const res = await h.app.inject({ method: 'POST', url: URL_OK, payload: aliceBody(phrase) });
    const body = res.json() as { response: { text: string } };
    assert.equal(body.response.text, ACK, `на «${phrase}» Алиса говорит ровно «Приняла»`);
  }

  assert.equal(queryEvents(h.db, {}).length, 0, 'матчер не записал ни одной сыпи');
});

/* ------------------------------------------------------------------ */
/* 2. Состояние: держится, не «протухает», закрывается второй фразой    */
/* ------------------------------------------------------------------ */

test('сыпь живёт по правилам сна, а колики и плач — по-прежнему нет', () => {
  assert.equal(isStateSubtype('symptom', 'rash'), true);
  assert.equal(isDurative('symptom', 'rash'), true);
  // Список состояний закрыт намеренно: у колик и плача нет ни закрывающей
  // фразы, ни предела правдоподобия — открытыми они висели бы вечно.
  for (const point of ['colic', 'crying', 'spit_up', 'vomit', 'fever']) {
    assert.equal(isDurative('symptom', point), false, `${point} остаётся точкой`);
  }
});

test('открытая сыпь не считается провисевшей даже через неделю', () => {
  const started = new Date(NOW.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const row = {
    id: 1,
    child_id: 'andrey',
    type: 'symptom',
    subtype: 'rash',
    started_at: started,
    ended_at: null,
    value_num: null,
    value_unit: null,
    note: 'сыпь на щеках',
    source: 'alice-llm',
    utterance_id: null,
    confidence: 0.9,
    created_at: started,
    updated_at: started,
    deleted_at: null,
  };
  assert.equal(
    isStaleOpen(row, NOW),
    false,
    'семь суток открытой сыпи — это норма, а не забытое закрытие',
  );
});

test('состояние открывается первой фразой и закрывается второй', () => {
  const db = testDb();
  const started = new Date(NOW.getTime() - 3 * 24 * 60 * 60_000).toISOString();

  const { event } = insertEvent(db, {
    type: 'symptom',
    subtype: 'rash',
    started_at: started,
    ended_at: null,
    source: 'alice-llm',
    note: 'сыпь на щеках',
  });
  assert.equal(openStateEvents(db).length, 1, 'сыпь числится открытой');

  updateEvent(db, event.id, { ended_at: NOW.toISOString() });
  assert.equal(openStateEvents(db).length, 0, 'после «прошла» открытых состояний нет');

  const closed = queryEvents(db, {}).find((e) => e.id === event.id);
  assert.equal(closed?.started_at, started, 'начало осталось прежним: сыпь была и вчера');
  assert.ok(closed?.ended_at, 'конец проставлен');
  db.close();
});

test('сыпь и желтизна — независимые наблюдения, одно не закрывает другое', () => {
  const db = testDb();
  insertEvent(db, {
    type: 'symptom',
    subtype: 'rash',
    started_at: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000).toISOString(),
    ended_at: null,
    source: 'alice-llm',
  });
  insertEvent(db, {
    type: 'symptom',
    subtype: 'skin_yellow',
    started_at: new Date(NOW.getTime() - 4 * 24 * 60 * 60_000).toISOString(),
    ended_at: null,
    source: 'alice-llm',
  });

  const open = openStateEvents(db);
  assert.equal(open.length, 2, 'открытых состояний два, и они не мешают друг другу');
  assert.deepEqual(
    open.map((e) => e.subtype),
    ['skin_yellow', 'rash'],
    'порядок — по времени начала, старшее первым',
  );
  db.close();
});

/* ------------------------------------------------------------------ */
/* 3. Промпт: карточка, маршрут записи и запрет на диагноз              */
/* ------------------------------------------------------------------ */

function promptFor(say: string): string {
  const db = testDb();
  const text = buildPrompt({
    cfg,
    rawText: say,
    fast: matchFast(say, undefined, { now: NOW, tz: cfg.tz }),
    fastEvent: null,
    state: getState(db, cfg, NOW),
    utteranceId: 501,
    recentEvents: [],
    recentUtterances: [],
    now: NOW,
  });
  db.close();
  return text;
}

test('фраза про сыпь поднимает разбор наблюдения и называет подтип', () => {
  for (const phrase of ['у него сыпь на щеках', 'высыпало по всему телу', 'прыщики появились']) {
    const p = promptFor(phrase);
    assert.match(
      p,
      /ТВОЙ СЛУЧАЙ: родитель говорит про то, что ДЕРЖИТСЯ/,
      `«${phrase}» поднимает карточку`,
    );
    assert.match(p, /symptom\/rash/, 'модели названо, куда писать');
    assert.match(p, /ДИАГНОЗ СТАВИТЬ ЗАПРЕЩЕНО/);
  }
});

test('модели сказано, что место сыпи идёт в note, а не в подтип', () => {
  const p = promptFor('у него сыпь на щеках');
  assert.match(p, /Где именно сыпь.*— в note/s, 'слова родителя терять нельзя');
});

test('«пятнышки» карточку поднимают, а «пятно на пелёнке» — нет', () => {
  assert.match(
    promptFor('какие-то пятнышки на коже'),
    /ТВОЙ СЛУЧАЙ: родитель говорит про то, что ДЕРЖИТСЯ/,
    'уменьшительная форма — почти всегда про кожу ребёнка',
  );
  assert.doesNotMatch(
    promptFor('покормила, и пятно на пелёнке осталось'),
    /ТВОЙ СЛУЧАЙ: родитель говорит про то, что ДЕРЖИТСЯ/,
    'голое «пятно» чаще про бельё; карточка стоит первой и вытеснила бы нужную',
  );
});

test('«покраснел» состоянием не считается и карточку не поднимает', () => {
  // Граница проведена намеренно: у младенца краснеют от натуги, от жары и
  // перед плачем. Это описание минуты, а не наблюдение о коже, и заводить
  // под него открытую запись нельзя — закрывать её никто не придёт.
  const p = promptFor('он весь покраснел, когда тужился');
  assert.doesNotMatch(p, /ТВОЙ СЛУЧАЙ: родитель говорит про то, что ДЕРЖИТСЯ/);
});

test('правило про ended_at перечисляет состояния списком из кода, а не прозой', () => {
  const p = promptFor('андрей заснул');
  // Список рисуется из STATE_SUBTYPES: добавили состояние — правило поехало
  // само, забыть его нельзя.
  for (const subtype of STATE_SUBTYPES.symptom) {
    assert.match(p, new RegExp(`symptom/${subtype}`), `${subtype} назван в правилах данных`);
  }
});

test('ни таксономия, ни промпт не произносят диагноз про сыпь', () => {
  const DIAGNOSIS = /аллерги|потниц|диатез|дерматит|крапивниц/i;

  assert.doesNotMatch(JSON.stringify(TAXONOMY), DIAGNOSIS, 'таксономия говорит о наблюдении');
  assert.doesNotMatch(JSON.stringify(STATE_SUBTYPES), DIAGNOSIS);

  // В промпте эти слова встречаются РОВНО как запрет и только в карточке.
  const p = promptFor('у него сыпь на щеках');
  assert.match(p, /про сыпь — ни «аллергия»/, 'упоминание — прямой запрет');
  assert.doesNotMatch(promptFor('андрей заснул'), DIAGNOSIS, 'в базовом промпте их нет вовсе');
});

test('подтип назван тем, что видно, а не причиной', () => {
  for (const subtype of STATE_SUBTYPES.symptom) {
    assert.doesNotMatch(subtype, /allerg|diathes|dermat|jaundice|icterus/i);
    assert.ok(
      (TAXONOMY.symptom.subtypes as readonly string[]).includes(subtype),
      `${subtype} обязан быть в таксономии`,
    );
  }
});
