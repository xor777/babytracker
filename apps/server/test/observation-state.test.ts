/**
 * Наблюдения-состояния (§10.2): желтизна кожи и белков глаз.
 *
 * Здесь проверяется ПОВЕДЕНИЕ конвейера вокруг наблюдения, а не то, как
 * разберёт фразу модель, — её поведение проверено живыми прогонами
 * на claude-opus-5 через `lab/run.ts` (см. отчёт).
 *
 * Границы, которые этот файл сторожит:
 *
 *   1. Быстрый матчер желтизну НЕ узнаёт и событий по ней не пишет — но и
 *      не проглатывает: фраза уходит модели, а вслух звучит обычное «Приняла».
 *      Матчер отвечает за три секунды словарём, и «узнавать» наблюдение,
 *      от которого зависит разговор с врачом, ему нельзя.
 *   2. Состояние ведёт себя как сон: открывается, держится сутками, закрывается
 *      второй фразой. Провисевшим открытым его считать НЕЛЬЗЯ — в отличие от
 *      кормления, которое через час заведомо не идёт.
 *   3. Слова «желтуха» нет нигде: ни в таксономии, ни в промпте, ни в том,
 *      что уходит в базу. Родитель видит цвет, а не диагноз.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TEST_SECRET, aliceBody, makeTestApp, testConfig, testDb } from './helpers.ts';
import { ACK } from '../src/alice.ts';
import { insertEvent, openStateEvents, queryEvents, updateEvent } from '../src/events.ts';
import { getState } from '../src/events.ts';
import { matchFast, detectDomains, normalize } from '../src/fastpath.ts';
import { decideQueue } from '../src/queue-policy.ts';
import { listUtterances } from '../src/utterances.ts';
import { buildPrompt, isDurative, isStaleOpen, maxOpenMin } from '../src/prompt.ts';
import { STATE_SUBTYPES, TAXONOMY, isStateSubtype } from '../src/taxonomy.ts';

const URL_OK = `/alice/${TEST_SECRET}`;

/**
 * Заголовок ситуативной карточки. Одна карточка на все наблюдения-состояния:
 * правила у желтизны и сыпи буквально общие, различается только строка «куда».
 */
const CARD_TITLE = /ТВОЙ СЛУЧАЙ: родитель говорит про то, что ДЕРЖИТСЯ/;
const NOW = new Date('2026-03-15T12:00:00Z');

/** Фразы, которыми родитель на самом деле про это говорит. */
const PHRASES = [
  'он какой-то желтенький',
  'андрей желтит',
  'белки глаз жёлтые',
  'желтизна почти сошла',
  'кожа пожелтела',
];

/* ------------------------------------------------------------------ */
/* 1. Быстрый матчер: не узнаёт сам, но и не проглатывает               */
/* ------------------------------------------------------------------ */

test('матчер не пишет событий по желтизне: это не его дело', () => {
  for (const phrase of PHRASES) {
    const fast = matchFast(phrase, undefined, { now: NOW });
    assert.equal(
      fast.kind,
      'unknown',
      `«${phrase}» матчер разбирать не должен — наблюдение разбирает модель`,
    );
  }
});

test('фраза про желтизну уходит модели при любой политике', () => {
  for (const phrase of PHRASES) {
    const fast = matchFast(phrase, undefined, { now: NOW });
    for (const policy of ['all', 'smart', 'unknown'] as const) {
      const d = decideQueue({ policy, threshold: 0.75, fast, command: phrase });
      assert.equal(d.queue, true, `«${phrase}» при политике ${policy} обязана уйти модели`);
    }
  }
});

test('желтизна в составной фразе не даёт матчеру закрыть её кормлением', () => {
  // Живой способ потерять наблюдение: матчер уверенно разбирает знакомую
  // половину фразы, а незнакомая пропадает молча (§10.3).
  const phrase = 'покормила, и он какой-то желтенький';
  assert.ok(
    detectDomains(normalize(phrase)).has('symptom'),
    'корень «желт» обязан поднимать домен symptom',
  );
  const fast = matchFast(phrase, undefined, { now: NOW });
  assert.equal(
    decideQueue({ policy: 'smart', threshold: 0.75, fast, command: phrase }).queue,
    true,
  );
});

test('голосом на желтизну отвечаем обычное «Приняла», без своей интерпретации', async (t) => {
  const h = await makeTestApp({ LLM_QUEUE_POLICY: 'all' });
  t.after(() => h.close());

  for (const phrase of PHRASES) {
    const res = await h.app.inject({ method: 'POST', url: URL_OK, payload: aliceBody(phrase) });
    const body = res.json() as { response: { text: string } };
    assert.equal(body.response.text, ACK, `на «${phrase}» Алиса говорит ровно «Приняла»`);
  }

  // Ни одного события матчер не создал — всё ждёт модель.
  assert.equal(queryEvents(h.db, {}).length, 0, 'матчер не записал ни одного наблюдения');
  assert.equal(listUtterances(h.db).length, PHRASES.length, 'но каждая фраза встала в очередь');
});

/* ------------------------------------------------------------------ */
/* 2. Состояние: открывается, держится, закрывается второй фразой       */
/* ------------------------------------------------------------------ */

test('наблюдение-состояние живёт по правилам сна, а прочие симптомы — нет', () => {
  assert.equal(isDurative('symptom', 'skin_yellow'), true);
  assert.equal(isDurative('symptom', 'eyes_yellow'), true);
  // Колики и плач открытыми висеть не могут: у них нет ни закрывающей фразы,
  // ни предела правдоподобия — расширение на весь тип было бы дырой.
  assert.equal(isDurative('symptom', 'colic'), false);
  assert.equal(isDurative('symptom', 'crying'), false);
  assert.equal(isDurative('symptom', null), false);
  assert.equal(isStateSubtype('symptom', 'skin_yellow'), true);
  assert.equal(isStateSubtype('diaper', 'skin_yellow'), false);
});

test('открытое наблюдение не считается провисевшим даже через неделю', () => {
  const started = new Date(NOW.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const row = {
    id: 1,
    type: 'symptom',
    subtype: 'skin_yellow',
    started_at: started,
    ended_at: null,
    deleted_at: null,
  } as Parameters<typeof isStaleOpen>[0];

  assert.equal(maxOpenMin('symptom'), null, 'предела «идёт» у наблюдения нет');
  assert.equal(
    isStaleOpen(row, NOW),
    false,
    'желтизна держится сутками — «чинить» её как провисевшее кормление нельзя',
  );
});

test('состояние открывается первой фразой и закрывается второй', () => {
  const cfg = testConfig();
  const db = testDb();

  // Первая фраза: родитель заметил. Состояние открыто, конца нет.
  const opened = insertEvent(db, {
    type: 'symptom',
    subtype: 'skin_yellow',
    started_at: new Date(NOW.getTime() - 4 * 24 * 60 * 60_000).toISOString(),
    ended_at: null,
    source: 'alice-llm',
    note: 'желтенький',
  }).event;

  assert.equal(opened.ended_at, null, 'пока держится — конца нет');

  const open = openStateEvents(db);
  assert.equal(open.length, 1, 'открытое наблюдение видно отдельным запросом');
  assert.equal(open.at(0)?.id, opened.id);

  // Отметка ПОВЕРХ состояния: «стало желтее» не закрывает и не двигает границ.
  const mark = new Date(NOW.getTime() - 2 * 24 * 60 * 60_000).toISOString();
  insertEvent(db, {
    type: 'symptom',
    subtype: 'skin_yellow',
    started_at: mark,
    ended_at: mark,
    source: 'alice-llm',
    note: 'стало желтее',
  });

  assert.equal(openStateEvents(db).length, 1, 'отметка поверх не заводит второго состояния');
  assert.equal(
    queryEvents(db, { type: 'symptom' }).length,
    2,
    'но сама отметка сохранена отдельной записью',
  );

  // Вторая фраза: «прошла». Закрывается ТА ЖЕ запись, а не заводится новая.
  updateEvent(db, opened.id, { ended_at: NOW.toISOString() });

  const closed = queryEvents(db, { type: 'symptom' }).find((e) => e.id === opened.id);
  assert.ok(closed?.ended_at, 'состояние закрыто');
  assert.equal(openStateEvents(db).length, 0, 'открытых наблюдений не осталось');
  assert.equal(
    queryEvents(db, { type: 'symptom' }).length,
    2,
    'закрытие — правка прежней записи, а не третье событие',
  );

  db.close();
});

test('кожа и белки глаз — два независимых наблюдения', () => {
  const db = testDb();
  const at = new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString();

  const skin = insertEvent(db, {
    type: 'symptom',
    subtype: 'skin_yellow',
    started_at: at,
    ended_at: null,
    source: 'alice-llm',
  }).event;
  insertEvent(db, {
    type: 'symptom',
    subtype: 'eyes_yellow',
    started_at: at,
    ended_at: null,
    source: 'alice-llm',
  });

  assert.equal(openStateEvents(db).length, 2);

  // Кожа посветлела, белки ещё жёлтые — для врача это разные факты,
  // и закрытие одного не трогает другое.
  updateEvent(db, skin.id, { ended_at: NOW.toISOString() });
  const still = openStateEvents(db);
  assert.equal(still.length, 1);
  assert.equal(still.at(0)?.subtype, 'eyes_yellow');

  db.close();
});

/* ------------------------------------------------------------------ */
/* 3. Промпт видит состояние и знает, что про него нельзя               */
/* ------------------------------------------------------------------ */

function promptFor(rawText: string, openStates: ReturnType<typeof openStateEvents> = []) {
  const cfg = testConfig();
  const db = testDb();
  const text = buildPrompt({
    cfg,
    rawText,
    fast: matchFast(rawText, undefined, { now: NOW }),
    fastEvent: null,
    state: getState(db, cfg),
    now: NOW,
    receivedAt: NOW,
    openStates,
  });
  db.close();
  return text;
}

test('фраза про цвет поднимает разбор наблюдения с прямым запретом на диагноз', () => {
  for (const phrase of ['он какой-то желтенький', 'белки глаз жёлтые', 'желтизна почти сошла']) {
    const p = promptFor(phrase);
    assert.match(p, CARD_TITLE, `«${phrase}» поднимает карточку`);
    assert.match(p, /ДИАГНОЗ СТАВИТЬ ЗАПРЕЩЕНО/);
    assert.match(p, /skin_yellow/);
    assert.match(p, /eyes_yellow/);
  }
});

test('на постороннюю фразу карточка наблюдения не показывается', () => {
  const p = promptFor('андрей заснул');
  assert.doesNotMatch(p, CARD_TITLE);
});

test('открытое состояние видно модели, даже когда оно старое', () => {
  const db = testDb();
  insertEvent(db, {
    type: 'symptom',
    subtype: 'skin_yellow',
    // Пять суток назад: в двадцатку последних событий такое уже не попадает,
    // и без отдельного блока модель завела бы вторую запись вместо закрытия.
    started_at: new Date(NOW.getTime() - 5 * 24 * 60 * 60_000).toISOString(),
    ended_at: null,
    source: 'alice-llm',
    note: 'желтенький',
  });
  const open = openStateEvents(db);
  db.close();

  const p = promptFor('кажется, желтизна прошла', open);
  assert.match(p, /ОТКРЫТЫЕ НАБЛЮДЕНИЯ-СОСТОЯНИЯ/);
  assert.match(p, /symptom\/skin_yellow держится с/);
  assert.match(p, /это 5 дней/, 'модель должна видеть, СКОЛЬКО это держится');
});

test('без открытых состояний лишнего блока в промпте нет', () => {
  const p = promptFor('андрей заснул');
  assert.doesNotMatch(p, /ОТКРЫТЫЕ НАБЛЮДЕНИЯ-СОСТОЯНИЯ/);
});

/* ------------------------------------------------------------------ */
/* 4. Слова «желтуха» в дневнике нет                                    */
/* ------------------------------------------------------------------ */

test('ни таксономия, ни промпт не произносят диагноз', () => {
  const DIAGNOSIS = /желтух|icterus|jaundice|билирубин/i;

  assert.doesNotMatch(JSON.stringify(TAXONOMY), DIAGNOSIS, 'таксономия говорит о наблюдении');
  assert.doesNotMatch(JSON.stringify(STATE_SUBTYPES), DIAGNOSIS);

  // Промпт слово «желтуха» упоминает ровно один раз и ровно как запрет.
  const p = promptFor('он какой-то желтенький');
  const mentions = p.match(/желтух\w*/gi) ?? [];
  assert.equal(mentions.length, 1, `«желтуха» встречается ${mentions.length} раз(а), а не один`);
  assert.match(
    p,
    /ДИАГНОЗ СТАВИТЬ ЗАПРЕЩЕНО\. Ни «желтуха»/,
    'единственное упоминание — прямой запрет, а не разрешение так писать',
  );
  assert.doesNotMatch(p, /jaundice|icterus/i);
});

test('подтип назван наблюдением, а не болезнью', () => {
  for (const subtype of STATE_SUBTYPES.symptom ?? []) {
    assert.doesNotMatch(subtype, /jaundice|icterus|желтух/i);
    assert.ok(TAXONOMY.symptom.subtypes.includes(subtype), `${subtype} обязан быть в таксономии`);
  }
});
