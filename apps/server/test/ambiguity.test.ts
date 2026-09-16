/**
 * Политика неоднозначности (§5, §9.5, §10.3) — детерминированная часть.
 *
 * Здесь проверяется ровно то, что можно проверить без модели:
 *   - контракт пометки допущения (`[?]` + confidence) и то, что им пользуется
 *     не только модель, но и быстрый матчер;
 *   - подбор ситуативных разборов: нужный случай показан, ненужные — нет;
 *   - инварианты текста промпта, потеря которых означает молчаливую деградацию
 *     политики (запрет на выдумывание, шкала confidence, вердикты по всем
 *     разобранным случаям);
 *   - размер промпта: избыточный промпт ухудшает следование инструкциям
 *     не меньше, чем недостаточный, поэтому рост здесь — регрессия;
 *   - согласованность воркера и MCP-сервера: тул, о котором промпт
 *     рассказывает, но которого нет в --allowedTools, модель вызвать не сможет.
 *
 * Поведение самой модели тестами не проверяется — оно проверено живыми
 * прогонами на claude-opus-5, см. отчёт.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type Config } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import {
  ASSUMPTION_MARK,
  IMPLAUSIBLE_SLEEP_HOURS,
  MAX_CASE_CARDS,
  REPEAT_WINDOW_MIN,
  SLEEP_REPEAT_WINDOW_MIN,
  DURATIVE_TYPES,
  buildPrompt,
  isAssumption,
  isStaleOpen,
  maxOpenMin,
  repeatWindowMin,
} from '../src/prompt.ts';
import { ALLOWED_TOOLS, DEFAULT_EFFORT, resolveEffort } from '../src/worker.ts';
import { endSleep, getState, insertEvent, startSleep } from '../src/events.ts';
import { matchFast } from '../src/fastpath.ts';
import type { EventRow, FastResult, UtteranceRow } from '../src/types.ts';

const NOW = new Date('2026-09-15T11:02:00.000Z'); // 14:02 по Москве

function cfgOf(): Config {
  return loadConfig(
    {
      ALICE_WEBHOOK_SECRET: '0123456789abcdef0123456789abcdef',
      TZ: 'Europe/Moscow',
      CHILD_NAME: 'Андрей',
      CHILD_BIRTHDATE: '2026-09-02',
      DB_PATH: ':memory:',
      WORKER_ENABLED: 'false',
    } as NodeJS.ProcessEnv,
    { cwd: process.cwd() },
  );
}

const cfg = cfgOf();

function db(): Db {
  return openDb({ path: ':memory:' });
}

function utterance(id: number, text: string, minutesAgo: number, status = 'done'): UtteranceRow {
  return {
    id,
    raw_text: text,
    alice_user_id: null,
    session_id: null,
    received_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    status,
    fast_result: null,
    llm_result: null,
    llm_error: null,
    attempts: 0,
    processed_at: null,
    reparse_count: 0,
  };
}

interface PromptOpts {
  db?: Db;
  say?: string;
  fast?: FastResult | null;
  fastEvent?: EventRow | null;
  recentEvents?: EventRow[];
  recentUtterances?: UtteranceRow[];
  utteranceId?: number | null;
}

function prompt(opts: PromptOpts = {}): string {
  const database = opts.db ?? db();
  const say = opts.say ?? 'андрей заснул';
  return buildPrompt({
    cfg,
    rawText: say,
    fast: opts.fast === undefined ? matchFast(say, undefined, { now: NOW, tz: cfg.tz }) : opts.fast,
    fastEvent: opts.fastEvent ?? null,
    state: getState(database, cfg, NOW),
    utteranceId: opts.utteranceId ?? 77,
    recentEvents: opts.recentEvents ?? [],
    recentUtterances: opts.recentUtterances ?? [],
    now: NOW,
  });
}

/* ------------------------------------------------------------------ */
/* Контракт пометки допущения                                          */
/* ------------------------------------------------------------------ */

test('маркер допущения узнаётся в начале заметки и только там', () => {
  assert.equal(isAssumption({ note: `${ASSUMPTION_MARK} конец сна не назывался` }), true);
  assert.equal(isAssumption({ note: `  ${ASSUMPTION_MARK} с отступом` }), true);
  assert.equal(isAssumption({ note: 'исправлено по словам родителя' }), false);
  assert.equal(isAssumption({ note: null }), false);
  assert.equal(
    isAssumption({ note: 'мама сказала «поменяли [?] подгузник»' }),
    false,
    'маркер в середине текста — это часть фразы родителя, а не пометка',
  );
});

test('маркер — короткий ASCII, пригодный для грепа по note и для вырезания из TTS', () => {
  assert.equal(ASSUMPTION_MARK, '[?]');
  assert.ok(/^[\x20-\x7e]+$/.test(ASSUMPTION_MARK), 'только ASCII: иначе не сгрепать из SQL');
  assert.ok(ASSUMPTION_MARK.length <= 4);
});

test('пробуждение без записанного сна помечается как пробел, а не как факт', () => {
  const d = db();
  const res = endSleep(d, cfg, { at: NOW.toISOString() });

  assert.equal(res.status, 'no_open_sleep');
  assert.equal(res.event.type, 'note');
  assert.ok(
    isAssumption(res.event),
    'матчер тоже обязан помечать неизвестное: маркер общий для fast-path и модели',
  );
  assert.match(res.event.note ?? '', /когда заснул, неизвестно/);
  d.close();
});

test('окна повтора: сон шире прочего, неизвестный тип получает умолчание', () => {
  assert.equal(repeatWindowMin('sleep'), SLEEP_REPEAT_WINDOW_MIN);
  assert.ok(
    repeatWindowMin('sleep') > repeatWindowMin('feed'),
    'два «заснул» через 10 минут бывают, два кормления — нет',
  );
  assert.equal(repeatWindowMin('невиданный-тип'), 10);
  assert.equal(REPEAT_WINDOW_MIN.measure, 60);
});

/* ------------------------------------------------------------------ */
/* Длительные события: ended_at = «идёт», а не «конец неизвестен»       */
/* ------------------------------------------------------------------ */

function openEvent(id: number, type: string, minutesAgo: number): EventRow {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  return {
    id,
    child_id: 'andrey',
    type,
    subtype: null,
    started_at: at,
    ended_at: null,
    value_num: null,
    value_unit: null,
    note: 'Начало кормления со слов родителя',
    source: 'alice-llm',
    utterance_id: null,
    confidence: 0.7,
    created_at: at,
    updated_at: at,
    deleted_at: null,
  };
}

test('идущими могут быть только типы с длительностью', () => {
  assert.deepEqual([...DURATIVE_TYPES].sort(), ['activity', 'feed', 'pump', 'sleep']);
  for (const type of ['diaper', 'measure', 'meds', 'symptom', 'note']) {
    assert.equal(maxOpenMin(type), null, `${type} точечный — у него нет предела «идёт»`);
    assert.equal(
      isStaleOpen(openEvent(1, type, 600), NOW),
      false,
      'точечные типы этим правилом не чинятся: у них ended_at обязан ставиться сразу',
    );
  }
});

test('у сна предела «идёт» нет: долгий сон неправдоподобен, но возможен', () => {
  assert.equal(maxOpenMin('sleep'), null);
  assert.equal(
    isStaleOpen(openEvent(1, 'sleep', 600), NOW),
    false,
    'десятичасовой открытый сон разбирается карточкой про второе «заснул», а не подчисткой',
  );
});

test('провисевшее кормление опознаётся, свежее — нет', () => {
  assert.equal(isStaleOpen(openEvent(1, 'feed', 12), NOW), false, '12 минут — обычное кормление');
  assert.equal(isStaleOpen(openEvent(1, 'feed', 360), NOW), true, 'шесть часов — заведомо не правда');
  assert.equal(isStaleOpen(openEvent(1, 'pump', 45), NOW), true);
  assert.equal(isStaleOpen(openEvent(1, 'activity', 45), NOW), false, 'прогулка 45 минут — норма');
  assert.equal(isStaleOpen(openEvent(1, 'activity', 400), NOW), true);
});

test('закрытое и удалённое провисевшим не считается', () => {
  const closed = { ...openEvent(1, 'feed', 360), ended_at: NOW.toISOString() };
  const removed = { ...openEvent(1, 'feed', 360), deleted_at: NOW.toISOString() };
  assert.equal(isStaleOpen(closed, NOW), false);
  assert.equal(isStaleOpen(removed, NOW), false);
});

test('различие «начал кушать» и «покормила» есть в любом промпте', () => {
  const text = prompt();
  assert.match(text, /ended_at = null означает «ИДЁТ ПРЯМО СЕЙЧАС», а не «конец неизвестен»/);
  assert.match(text, /«покормила», «поел», «искупали», «погуляли» —\s*\n?\s*законченный факт/);
  assert.match(text, /«Начал кушать», «кормлю»,\s*\n?\s*«приложила», «купаемся» — идёт/);
});

test('открытое кормление поднимает карточку и показано с id и возрастом', () => {
  const text = prompt({ say: 'он поел', recentEvents: [openEvent(13, 'feed', 12)] });
  assert.match(text, /событие с длительностью, которому нечем закрыться/);
  assert.match(text, /id=13 feed\/- открыто с/);
  assert.doesNotMatch(text, /ТАК ДОЛГО НЕ ДЛИТСЯ/, '12 минут — не провисевшее');
  assert.match(text, /ЗАКРЫВАЮТ открытое/);
  assert.match(text, /маркер не нужен/);
});

test('провисевшее кормление отмечено прямо в карточке и чинится точкой', () => {
  const text = prompt({ say: 'поменяли подгузник', recentEvents: [openEvent(13, 'feed', 362)] });
  assert.match(text, /id=13 feed\/- открыто с[^\n]*ТАК ДОЛГО НЕ ДЛИТСЯ/);
  assert.match(text, /Закрывай ТОЧКОЙ: ended_at = started_at/);
  assert.match(text, /value_num не трогай/);
  assert.match(
    text,
    /ПОЧЕМУ точкой, а у сна границей/,
    'разное обращение со сном и кормлением обязано быть объяснено, иначе выглядит произволом',
  );
});

test('карточка не поднимается там, где длительных событий нет и речь не о них', () => {
  assert.doesNotMatch(
    prompt({ say: 'поменяли подгузник', recentEvents: [] }),
    /событие с длительностью, которому нечем закрыться/,
  );
});

/* ------------------------------------------------------------------ */
/* Ядро промпта: то, что должно быть в нём ВСЕГДА                      */
/* ------------------------------------------------------------------ */

test('главное правило и запрет на выдумывание есть в любом промпте', () => {
  const text = prompt();
  assert.match(text, /ВЫДУМЫВАТЬ ФАКТЫ — НЕЛЬЗЯ НИКОГДА/);
  assert.match(text, /РЕШАТЬ О ПРОЧТЕНИИ — МОЖНО И НУЖНО/);
  assert.match(text, /Связность — не доказательство/);
  assert.match(text, /вправе сказать «не знаю» и ВСЁ РАВНО записать/);
});

test('механика пометки описана: маркер, шкала confidence и порог 0.6', () => {
  const text = prompt();
  assert.ok(text.includes(`note начинается с «${ASSUMPTION_MARK}»`));
  assert.match(text, /0\.9–1\.0/);
  assert.match(text, /0\.2–0\.35/);
  assert.match(
    text,
    /confidence не выше 0\.6 ОБЯЗАТЕЛЕН[\s\S]{0,140}value_num/,
    'порог должен быть привязан именно к полям, которые становятся метриками',
  );
  assert.match(text, /ГРАНИЦУ, которую можешь защитить/);
  assert.match(text, /«Типичное», «примерное», «обычно столько» — не ставь никогда/);
});

test('запрет на медицинские суждения есть всегда', () => {
  assert.match(prompt(), /Медицинских суждений, диагнозов, тревоги и советов не пиши нигде/);
});

test('вердикт есть по каждому разобранному случаю — даже когда карточки не показаны', () => {
  const text = prompt({ say: 'ага' });
  const verdicts = [
    /«заснул», а сон уже открыт →/,
    /«проснулся», а открытого сна нет →/,
    /то же событие второй раз подряд/,
    /вторая фраза добавила подробность →/,
    /событие задним числом/,
    /родитель отрицает записанное →/,
    /а не в десять» →/,
    /часть фразы понятна, часть нет →/,
    /вышло неправдоподобно для возраста →/,
    /во фразе несколько событий →/,
  ];
  for (const re of verdicts) assert.match(text, re, `нет вердикта: ${String(re)}`);
});

test('ориентиры по возрасту даны как основание ВЫБИРАТЬ, а не подставлять числа', () => {
  const text = prompt();
  assert.match(text, /Ориентиры для 13-дневного — чтобы ВЫБИРАТЬ ПРОЧТЕНИЕ, а не подставлять/);
  assert.ok(text.includes(`дольше ${IMPLAUSIBLE_SLEEP_HOURS} ч подряд редкость`));
});

test('обязанность владельца пересматривать свои прежние допущения прописана', () => {
  const text = prompt();
  assert.ok(text.includes(`Свои прежние «${ASSUMPTION_MARK}»-допущения уточняй`));
  assert.match(text, /сними маркер,\s*\n?\s*подними confidence/);
});

test('нетронутые данные — законный исход, он назван самым частым', () => {
  assert.match(prompt(), /НЕ ДЕЛАЙ НИЧЕГО: это самый\s*\n?частый и самый правильный исход/);
});

/* ------------------------------------------------------------------ */
/* Ситуативные карточки                                                */
/* ------------------------------------------------------------------ */

test('канонический случай: «заснул» при открытом сне трёхчасовой давности', () => {
  const d = db();
  startSleep(d, cfg, { at: new Date(NOW.getTime() - 182 * 60_000).toISOString() });
  const text = prompt({ db: d });

  assert.match(text, /ТВОЙ СЛУЧАЙ: «заснул», а сон уже открыт/);
  assert.match(text, /\(а\) проснулся, а сказать забыли/);
  assert.match(text, /пропущенное пробуждение/);
  assert.match(text, /Момент пробуждения\nНЕИЗВЕСТЕН/);
  assert.match(text, /поставила ГРАНИЦУ|Поставила ГРАНИЦУ/);
  assert.match(text, /confidence=0\.3/);
  assert.doesNotMatch(text, /это \(б\), повтор/, 'через три часа ветка повтора не предлагается');
  d.close();
});

test('тот же случай через 8 минут даёт ветку повтора, а не разрыв сна', () => {
  const d = db();
  startSleep(d, cfg, { at: new Date(NOW.getTime() - 8 * 60_000).toISOString() });
  const text = prompt({ db: d });

  assert.match(text, /это \(б\), повтор/);
  assert.match(text, /Открытый сон НЕ трогай, второй не создавай/);
  assert.doesNotMatch(text, /пропущенное пробуждение/);
  d.close();
});

test('неправдоподобно долгий сон опускает предлагаемую confidence и требует слов', () => {
  const d = db();
  startSleep(d, cfg, {
    at: new Date(NOW.getTime() - (IMPLAUSIBLE_SLEEP_HOURS * 60 + 30) * 60_000).toISOString(),
  });
  const text = prompt({ db: d });

  assert.match(text, /confidence=0\.2/);
  assert.match(text, /неправдоподобно/);
  assert.match(text, /«исправить» на красивую длительность — нет/);
  d.close();
});

test('«проснулся» без открытого сна: карточка запрещает сон задним числом', () => {
  const text = prompt({ say: 'андрей проснулся' });
  assert.match(text, /ТВОЙ СЛУЧАЙ: «проснулся», а открытого сна в базе нет/);
  assert.match(text, /НЕ создавай сон задним числом/);
  assert.match(text, /ИСКЛЮЧЕНИЕ: родитель сам назвал начало или длительность/);
});

test('«проснулся» при открытом сне — обычное закрытие, карточки нет', () => {
  const d = db();
  startSleep(d, cfg, { at: new Date(NOW.getTime() - 60 * 60_000).toISOString() });
  assert.doesNotMatch(prompt({ db: d, say: 'андрей проснулся' }), /а открытого сна в базе нет/);
  d.close();
});

test('поправка «а не в десять» поднимает карточку правки и напоминает про запись матчера', () => {
  const text = prompt({ say: 'нет, он заснул в девять, а не в десять' });
  assert.match(text, /похоже на поправку к уже записанному/);
  assert.match(text, /не завёл ли матчер по этой же фразе новое событие/);
  assert.match(text, /маркер «\[\?\]» не ставь/);
  assert.match(text, /кандидатов несколько — НИЧЕГО НЕ ТРОГАЙ/);
});

test('дословный повтор фразы виден модели как повтор, а не как второе событие', () => {
  const text = prompt({
    say: 'поменяли подгузник',
    recentUtterances: [utterance(76, 'Поменяли подгузник!', 4), utterance(77, 'поменяли подгузник', 0)],
    utteranceId: 77,
  });
  assert.match(text, /ровно эта фраза уже звучала 4 мин назад/);
  assert.match(text, /Второго события НЕ создавай/);
});

test('повтор ищется без оглядки на регистр и пунктуацию, но не за пределами получаса', () => {
  const far = prompt({
    say: 'поменяли подгузник',
    recentUtterances: [utterance(70, 'поменяли подгузник', 90)],
  });
  assert.doesNotMatch(far, /ровно эта фраза уже звучала/);
});

test('противоречие записанному поднимает карточку только при наличии записей', () => {
  const rows: EventRow[] = [
    {
      id: 5,
      child_id: 'andrey',
      type: 'sleep',
      subtype: 'nap',
      started_at: new Date(NOW.getTime() - 240 * 60_000).toISOString(),
      ended_at: new Date(NOW.getTime() - 120 * 60_000).toISOString(),
      value_num: null,
      value_unit: null,
      note: null,
      source: 'alice-fast',
      utterance_id: null,
      confidence: 0.95,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      deleted_at: null,
    },
  ];
  const withRows = prompt({ say: 'да он не спал днём совсем', recentEvents: rows });
  assert.match(withRows, /фраза противоречит тому, что уже записано/);
  assert.match(withRows, /НЕ УДАЛЯЙ НИЧЕГО/);

  const empty = prompt({ say: 'да он не спал днём совсем', recentEvents: [] });
  assert.doesNotMatch(empty, /фраза противоречит тому, что уже записано/);
});

test('простая однозначная фраза не получает ни одной карточки', () => {
  const text = prompt({ say: 'андрей заснул' });
  assert.doesNotMatch(text, /## ТВОЙ СЛУЧАЙ/);
});

test('карточек не больше установленного предела, даже если подходит всё сразу', () => {
  const d = db();
  startSleep(d, cfg, { at: new Date(NOW.getTime() - 200 * 60_000).toISOString() });
  const rows = [
    {
      id: 9,
      child_id: 'andrey',
      type: 'feed',
      subtype: 'breast',
      started_at: new Date(NOW.getTime() - 2 * 60_000).toISOString(),
      ended_at: null,
      value_num: null,
      value_unit: null,
      note: null,
      source: 'alice-fast',
      utterance_id: null,
      confidence: 0.9,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      deleted_at: null,
    } satisfies EventRow,
  ];
  const say = 'нет, он не спал, исправь, он заснул в девять, а не в десять';
  const text = prompt({
    db: d,
    say,
    recentEvents: rows,
    recentUtterances: [utterance(76, say, 3), utterance(77, say, 0)],
    utteranceId: 77,
  });
  const count = (text.match(/## ТВОЙ СЛУЧАЙ/g) ?? []).length;
  assert.ok(count > 0, 'хотя бы один разбор должен быть');
  assert.ok(count <= MAX_CASE_CARDS, `карточек ${count}, предел ${MAX_CASE_CARDS}`);
  d.close();
});

/* ------------------------------------------------------------------ */
/* Видимость прежних допущений и истории фраз                          */
/* ------------------------------------------------------------------ */

test('прежние допущения модели помечены в ленте событий отдельно', () => {
  const d = db();
  const { event } = insertEvent(d, {
    type: 'sleep',
    subtype: 'nap',
    started_at: new Date(NOW.getTime() - 200 * 60_000).toISOString(),
    ended_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    note: `${ASSUMPTION_MARK} конец сна не назывался, взята граница`,
    source: 'alice-llm',
    confidence: 0.3,
  });
  const plain = insertEvent(d, {
    type: 'feed',
    subtype: 'breast',
    started_at: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    ended_at: new Date(NOW.getTime() - 25 * 60_000).toISOString(),
    source: 'alice-fast',
  }).event;

  const text = prompt({ db: d, recentEvents: [event, plain] });
  assert.match(text, new RegExp(`id=${event.id}[^\\n]*ТВОЁ ПРЕЖНЕЕ ДОПУЩЕНИЕ`));
  assert.doesNotMatch(text, new RegExp(`id=${plain.id}[^\\n]*ТВОЁ ПРЕЖНЕЕ ДОПУЩЕНИЕ`));
  assert.match(text, new RegExp(`id=${event.id}[^\\n]*confidence=0\\.3`));
  d.close();
});

test('история фраз показана, а текущая фраза в ней не дублируется', () => {
  const text = prompt({
    say: 'андрей заснул',
    utteranceId: 77,
    recentUtterances: [utterance(77, 'андрей заснул', 0), utterance(76, 'покормили', 40)],
  });
  assert.match(text, /# ПОСЛЕДНИЕ ФРАЗЫ РОДИТЕЛЯ/);
  assert.match(text, /«покормили»/);
  assert.equal(
    (text.match(/\[done] «андрей заснул»/g) ?? []).length,
    0,
    'разбираемая фраза не должна попадать в список «предыдущих»',
  );
});

test('без истории фраз блок не врёт, а честно говорит, что её нет', () => {
  assert.match(prompt(), /Других фраз пока не было/);
});

/* ------------------------------------------------------------------ */
/* Сигналы матчера                                                     */
/* ------------------------------------------------------------------ */

test('неразобранное время: требование поправить, а не заменить одну догадку другой', () => {
  const say = 'андрей заснул полтора часа назад';
  const fast = matchFast(say, undefined, { now: NOW, tz: cfg.tz });
  assert.equal(fast.timeUnresolved, true);

  const text = prompt({ say, fast });
  assert.match(text, /СИГНАЛ «время названо, но не разобрано»/);
  assert.match(text, /второго события не создавай/);
  assert.match(text, /догадка, записанная молча, хуже честно помеченной неточности/);
});

test('запись матчера подана как черновик с id, а не как готовая правда', () => {
  const d = db();
  const res = startSleep(d, cfg, { at: NOW.toISOString(), confidence: 0.4 });
  const text = prompt({ db: d, fastEvent: res.status === 'created' ? res.event : null });
  assert.match(text, /Матчер УЖЕ ЗАПИСАЛ это в базу/);
  assert.match(text, /Его запись — черновик/);
  assert.match(text, /confidence=0\.4/);
  d.close();
});

/* ------------------------------------------------------------------ */
/* Размер: избыточный промпт — тоже регрессия                          */
/* ------------------------------------------------------------------ */

/*
 * Потолки ниже — сторожа от расползания, и их подняли ровно один раз и ровно
 * на то, что выросло: §10.2 получила наблюдения-состояния (`skin_yellow`,
 * `eyes_yellow`), и справочник таксономии стал длиннее на два подтипа и одну
 * строку правила про `ended_at`. Это рост СПРАВОЧНИКА, а не политики: сама
 * политика неоднозначности не прибавила ни строки, а подробный разбор желтизны
 * лежит в ситуативной карточке и показывается, только когда родитель говорит
 * про цвет.
 *
 * Именно поэтому главный сторож здесь — не абсолютные числа, а отношение
 * ниже: карточки не должны весить как второй промпт. Оно не тронуто.
 */
test('базовый промпт не разрастается: политика не должна стоить объёма', () => {
  const base = prompt({ say: 'андрей заснул' }).length;
  assert.ok(base < 10_100, `базовый промпт ${base} символов — политика утонет в тексте`);
});

test('ситуативные разборы стоят заметно меньше, чем ядро политики', () => {
  const base = prompt({ say: 'андрей заснул' }).length;

  const d = db();
  startSleep(d, cfg, { at: new Date(NOW.getTime() - 200 * 60_000).toISOString() });
  const say = 'нет, он не спал, исправь, он заснул в девять, а не в десять';
  const worst = prompt({
    db: d,
    say,
    recentUtterances: [utterance(76, say, 3), utterance(77, say, 0)],
    utteranceId: 77,
  }).length;
  d.close();

  // Худший случай — когда три неоднозначности совпали; ровно тогда подсказки
  // и нужнее всего, поэтому режется не он, а рост ядра. Граница здесь — сторож
  // от расползания, а не цель.
  assert.ok(worst < 13_700, `худший случай ${worst} символов`);
  assert.ok(
    worst - base < base * 0.45,
    `карточки добавили ${worst - base} символов к ядру в ${base} — это уже не подсказка, а второй промпт`,
  );
});

/* ------------------------------------------------------------------ */
/* Согласованность воркера с MCP-сервером                              */
/* ------------------------------------------------------------------ */

test('каждый тул MCP-сервера разрешён воркеру', () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp-server.ts'),
    'utf8',
  );
  const declared = [...source.matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 10, `нашлось только ${declared.length} тулов — сломался разбор`);

  for (const name of declared) {
    assert.ok(
      ALLOWED_TOOLS.includes(`mcp__babytracker__${name}`),
      `тул ${name} объявлен в MCP-сервере, но модель не сможет его вызвать: нет в --allowedTools`,
    );
  }
});

test('промпт не рассказывает про тулы, которых модели не дали', () => {
  const text = prompt();
  for (const tool of ['sql_execute', 'revert_change_set', 'list_change_sets', 'sleep_daily']) {
    if (!text.includes(tool)) continue;
    assert.ok(
      ALLOWED_TOOLS.includes(`mcp__babytracker__${tool}`),
      `промпт обещает ${tool}, а в --allowedTools его нет`,
    );
  }
});

test('уровень усилия закреплён явно и не съезжает от мусора в окружении', () => {
  assert.equal(resolveEffort({} as NodeJS.ProcessEnv), DEFAULT_EFFORT);
  assert.equal(resolveEffort({ CLAUDE_EFFORT: '' } as NodeJS.ProcessEnv), DEFAULT_EFFORT);
  assert.equal(resolveEffort({ CLAUDE_EFFORT: '  MAX ' } as NodeJS.ProcessEnv), 'max');
  assert.equal(resolveEffort({ CLAUDE_EFFORT: 'medium' } as NodeJS.ProcessEnv), 'medium');
  assert.equal(
    resolveEffort({ CLAUDE_EFFORT: 'сверхвысокий' } as NodeJS.ProcessEnv),
    DEFAULT_EFFORT,
    'непонятное значение не должно ронять воркер и не должно уезжать в умолчание CLI',
  );
});
