#!/usr/bin/env node
/**
 * Мок сервера BabyTracker для разработки админки /dash.
 * Чистый node, без зависимостей.
 *
 * ВАЖНО: формы ответов и границы валидации повторяют apps/server один в один —
 * имена полей (`utterance_text`, `feeds`, `diapers`, `measures`, `norms.wetDiapers`),
 * порядок дней в сводке (по возрастанию), потолок limit у /api/utterances (200),
 * отсутствие `deleted_at` в схеме PATCH и возврат только через журнал ревизий.
 * Любое расхождение здесь — это баг, который мок спрячет до самого прода.
 *
 *   GET    /api/events?from&to&type&limit&include_deleted
 *   POST   /api/events
 *   PATCH  /api/events/:id                 — ручная правка (без deleted_at!)
 *   DELETE /api/events/:id                 — мягкое удаление, отдаёт revertWith
 *   GET    /api/change-sets?limit
 *   POST   /api/change-sets/:id/revert     — единственный способ вернуть удалённое (§9.6)
 *   GET    /api/utterances?limit           — максимум 200, иначе 400
 *   GET    /api/stats/daily?days
 *   GET    /api/state, /healthz
 *
 * Данные — семь дней жизни с составными фразами и намеренными ошибками разбора,
 * которые хочется поправить руками: ровно то, ради чего админка и делается.
 *
 *   node mock-server.mjs              → http://localhost:8787
 *   MOCK_401=1 node mock-server.mjs              → /api отвечает 401
 *                                                  (проверить уход на /pair)
 *   MOCK_EMPTY=1 node mock-server.mjs            → только вес при рождении:
 *                                                  проверить экраны на пустой базе
 *   MOCK_NO_UTTERANCES=1 node mock-server.mjs    → падает только /api/utterances:
 *                                                  цитаты обязаны остаться на месте
 *   MOCK_RECORDED_DAYS=2 node mock-server.mjs    → случай заказчика: ребёнку две
 *                                                  недели, записи только за двое
 *                                                  последних суток
 *   CHILD_BIRTHDATE=2026-08-16 MOCK_RECORDED_DAYS=30 node mock-server.mjs
 *                                                → месяц полных записей: как будет
 *                                                  через месяц
 *
 * Если рядом лежит ./dist — отдаёт его по /dash, как это будет делать настоящий сервер.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8787);
const CHILD_NAME = process.env.CHILD_NAME ?? 'Андрей';
const CHILD_BIRTHDATE = process.env.CHILD_BIRTHDATE ?? '2026-09-02';
/** MOCK_EMPTY=1 — как на проде у двухнедельного: только вес при рождении. */
const EMPTY = process.env.MOCK_EMPTY === '1';
/**
 * За сколько последних суток вообще есть записи.
 *
 * Дневник почти никогда не ведут с рождения: у заказчика ребёнку две недели, а
 * записывать начали на четырнадцатые сутки. Экран обязан показывать эту разницу,
 * а не растворять её в средних, — значит мок обязан уметь её воспроизводить.
 *   MOCK_RECORDED_DAYS=2 — случай заказчика: две недели жизни, записи за двое суток.
 */
const RECORDED_DAYS = Math.max(0, Number(process.env.MOCK_RECORDED_DAYS ?? 7));
const FORCE_401 = process.env.MOCK_401 === '1';
/** Роняет только /api/utterances: цитаты обязаны выжить — они приходят с событиями. */
const NO_UTTERANCES = process.env.MOCK_NO_UTTERANCES === '1';
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// ------------------------------------------------------------------ хранилище

/** @type {any[]} */
const events = [];
/** @type {any[]} */
const utterances = [];
let eventSeq = 0;
let uttSeq = 0;

function iso(ms) {
  return new Date(ms).toISOString();
}

/** Момент в локальной зоне: daysAgo суток назад, в h:m. */
function at(daysAgo, h, m = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * @param kind что понял быстрый матчер (§4). Админка по нему отличает вопрос
 *   к Алисе от фразы, которую действительно никто не разобрал, — без него
 *   безобидное «сколько он спал» выглядит поломкой разбора.
 */
function say(rawText, receivedMs, status = 'done', kind = null) {
  const u = {
    id: ++uttSeq,
    raw_text: rawText,
    alice_user_id: 'mock-user',
    session_id: 'mock-session',
    received_at: iso(receivedMs),
    status,
    fast_result: kind ? { kind, confidence: 0.9 } : null,
    llm_result: null,
    llm_error: status === 'failed' ? 'timeout: claude не ответил за 60 с' : null,
    attempts: status === 'failed' ? 3 : 1,
    processed_at: status === 'done' ? iso(receivedMs + 4200) : null,
  };
  utterances.push(u);
  return u;
}

function add(e) {
  const created = e.started_at;
  const row = {
    id: ++eventSeq,
    child_id: 'andrey',
    type: e.type,
    subtype: e.subtype ?? null,
    started_at: iso(e.started_at),
    ended_at: e.ended_at != null ? iso(e.ended_at) : null,
    value_num: e.value_num ?? null,
    value_unit: e.value_unit ?? null,
    note: e.note ?? null,
    source: e.source ?? 'alice-llm',
    utterance_id: e.utterance?.id ?? null,
    confidence: e.confidence ?? null,
    created_at: iso(created),
    updated_at: iso(created),
    deleted_at: e.deleted_at != null ? iso(e.deleted_at) : null,
  };
  events.push(row);
  return row;
}

/** Событий из будущего не бывает — сегодняшний день обрезаем по «сейчас». */
function past(ms) {
  return ms <= Date.now();
}

// ------------------------------------------------------------------ сид

const FEED_PHRASES = [
  'покормила грудью',
  'поел из бутылочки',
  'дали смесь',
  'приложила к груди',
  'покушал',
];
const DIAPER_PHRASES = ['поменяли подгузник', 'подгузник мокрый', 'покакал', 'сменили памперс'];

/**
 * Вес по возрасту, граммы.
 *
 * Как у настоящего новорождённого: провал первых суток до минимума на третьи,
 * дальше ровный набор примерно по 32 г в сутки. Формула одна на весь мок —
 * иначе отдельные «интересные» записи выпадают из кривой выбросами, и экран
 * приходится проверять на ребёнке, которого не бывает.
 */
function weightFor(age) {
  return age <= 3 ? 4620 - 107 * age : 4299 + 32 * (age - 3);
}

function seedDay(daysAgo) {
  // --- ночной сон: начался вчера вечером, кончился утром
  const nightStart = at(daysAgo + 1, 22, 10 + (daysAgo % 3) * 7);
  const nightEnd = at(daysAgo, 6, 35 + (daysAgo % 4) * 5);
  if (past(nightStart)) {
    const u = say('всё, уснул на ночь', nightStart);
    add({
      type: 'sleep',
      subtype: 'night',
      started_at: nightStart,
      ended_at: past(nightEnd) ? nightEnd : null,
      source: 'alice-fast',
      confidence: 0.95,
      utterance: u,
    });
    if (past(nightEnd)) say('проснулся', nightEnd);
  }

  // --- утро: витамин D
  const meds = at(daysAgo, 9, 5);
  if (past(meds)) {
    const u = say('дала витамин д', meds);
    add({
      type: 'meds',
      subtype: 'витамин D',
      started_at: meds,
      value_num: 1,
      value_unit: 'ml',
      source: 'alice-llm',
      confidence: 0.9,
      utterance: u,
    });
  }

  // --- кормления: 7 штук по расписанию
  const feedHours = [7, 10, 12, 15, 17, 19, 21];
  feedHours.forEach((h, i) => {
    const ms = at(daysAgo, h, (i * 13) % 45);
    if (!past(ms)) return;
    const bottle = i % 3 === 1;
    const u = say(FEED_PHRASES[i % FEED_PHRASES.length], ms);
    add({
      type: 'feed',
      subtype: bottle ? 'bottle' : 'breast',
      started_at: ms,
      ended_at: bottle ? null : ms + (12 + (i % 4) * 3) * MINUTE,
      value_num: bottle ? 110 + (i % 3) * 20 : 12 + (i % 4) * 3,
      value_unit: bottle ? 'ml' : 'min',
      note: bottle ? null : ['left', 'right', 'both'][i % 3],
      source: 'alice-llm',
      confidence: 0.88,
      utterance: u,
    });
  });

  // --- подгузники: 6 штук
  [7, 10, 13, 16, 19, 21].forEach((h, i) => {
    const ms = at(daysAgo, h, 20 + (i * 7) % 30);
    if (!past(ms)) return;
    // «и пописал, и покакал» — отдельный подтип, который на сервере попадает
    // в оба ряда сразу. Без него мок не показывает самый путаный случай.
    const both = i === 3;
    const dirty = i === 1 || i === 4;
    const u = say(both ? 'пописал и покакал' : DIAPER_PHRASES[i % DIAPER_PHRASES.length], ms);
    add({
      type: 'diaper',
      subtype: both ? 'both' : dirty ? 'dirty' : 'wet',
      started_at: ms,
      source: 'alice-llm',
      confidence: 0.92,
      utterance: u,
    });
  });

  // --- дневные сны
  [
    [9, 40, 65],
    [12, 50, 95],
    [16, 15, 45],
  ].forEach(([h, m, dur], i) => {
    const start = at(daysAgo, h, m);
    if (!past(start)) return;
    const end = start + dur * MINUTE;
    const u = say(i === 0 ? 'уложила спать' : 'опять заснул', start);
    add({
      type: 'sleep',
      subtype: 'nap',
      started_at: start,
      ended_at: past(end) ? end : null,
      source: 'alice-fast',
      confidence: 0.94,
      utterance: u,
    });
  });

  // --- купание через день
  if (daysAgo % 2 === 0) {
    const bath = at(daysAgo, 20, 30);
    if (past(bath)) {
      const u = say('покупали', bath);
      add({
        type: 'activity',
        subtype: 'bath',
        started_at: bath,
        ended_at: bath + 15 * MINUTE,
        value_num: 15,
        value_unit: 'min',
        source: 'alice-llm',
        confidence: 0.85,
        utterance: u,
      });
    }
  }

  // --- взвешивания: раз в трое суток и обязательно сегодня
  const ageToday = ageDays(localDateKey(at(daysAgo, 12)));
  if (ageToday % 3 === 0 || daysAgo === 0) {
    const ms = at(daysAgo, 11, 10);
    if (past(ms)) {
      const grams = weightFor(ageToday);
      const u = say(`взвесили, ${(grams / 1000).toFixed(2).replace('.', ',')} килограмма`, ms);
      add({
        type: 'measure',
        subtype: 'weight',
        started_at: ms,
        value_num: grams,
        value_unit: 'g',
        source: 'alice-llm',
        confidence: 0.9,
        utterance: u,
      });
    }
  }
  if (daysAgo === 6 || daysAgo === 0) {
    const ms = at(daysAgo, 11, 14);
    if (past(ms)) {
      const cm = 54.4 + (6 - daysAgo) * 0.22;
      const u = say(`рост ${cm.toFixed(1).replace('.', ',')}`, ms);
      add({
        type: 'measure',
        subtype: 'height',
        started_at: ms,
        value_num: Number(cm.toFixed(1)),
        value_unit: 'cm',
        source: 'alice-llm',
        confidence: 0.9,
        utterance: u,
      });
      add({
        type: 'measure',
        subtype: 'head',
        started_at: ms + MINUTE,
        value_num: 36.2 + (6 - daysAgo) * 0.11,
        value_unit: 'cm',
        source: 'alice-llm',
        confidence: 0.88,
        utterance: u,
      });
    }
  }
}

/**
 * Фразы без событий — четыре штатных и один настоящий пробел.
 * Ровно на этой разнице заказчик и споткнулся: вопрос к Алисе показывался
 * как сбой разбора.
 */
function seedPhrases() {
  say('сколько он сегодня спал', at(0, 16, 10), 'skipped', 'query_state');
  say('что там с андреем', at(0, 14, 5), 'skipped', 'query_state');
  say('андрей проснулся', at(0, 12, 30), 'skipped', 'sleep_end');
  say('хватит', at(0, 12, 31), 'skipped', 'exit');
  // а это уже пробел: матчер не понял, модель не приходила
  say('он какой-то беспокойный и кряхтит', at(0, 15, 40), 'skipped', 'unknown');
}

/**
 * Составные фразы и ошибки разбора — главный материал для админки.
 * Каждая из них выглядит правдоподобно, но что-то в ней хочется поправить руками.
 */
function seedInteresting() {
  // 1. Классика §10.3: fast-path услышал только сон, модель дописала кормление —
  //    и выдумала объём, которого мама не называла. 500 мл видно сразу.
  const t1 = at(0, 14, 12);
  if (past(t1)) {
    const u = say('Андрей покушал и уснул', t1);
    add({
      type: 'feed',
      subtype: 'bottle',
      started_at: t1,
      value_num: 500,
      value_unit: 'ml',
      source: 'alice-llm',
      confidence: 0.41,
      utterance: u,
    });
    add({
      type: 'sleep',
      subtype: 'nap',
      started_at: t1 + 1000,
      ended_at: t1 + 70 * MINUTE,
      source: 'alice-fast',
      confidence: 0.95,
      utterance: u,
    });
  }

  // 2. Три события из одной фразы. «Покакал» уехал в note: подтип не опознан (§10.2).
  const t2 = at(1, 17, 40);
  const u2 = say('поменяли подгузник, покакал, и он опять заснул', t2);
  add({
    type: 'diaper',
    subtype: 'wet',
    started_at: t2,
    source: 'alice-llm',
    confidence: 0.86,
    utterance: u2,
  });
  add({
    type: 'note',
    started_at: t2 + 1000,
    note: 'покакал',
    source: 'alice-llm',
    confidence: 0.35,
    utterance: u2,
  });
  add({
    type: 'sleep',
    subtype: 'nap',
    started_at: t2 + 2000,
    ended_at: t2 + 55 * MINUTE,
    source: 'alice-fast',
    confidence: 0.93,
    utterance: u2,
  });

  // 3. Грудь мерят минутами, а записали миллилитрами — единица не та.
  const t3 = at(1, 6, 50);
  const u3 = say('проснулся, поели грудью минут пятнадцать', t3);
  add({
    type: 'feed',
    subtype: 'breast',
    started_at: t3 + 1000,
    ended_at: t3 + 15 * MINUTE,
    value_num: 15,
    value_unit: 'ml',
    note: 'both',
    source: 'alice-llm',
    confidence: 0.52,
    utterance: u3,
  });

  // 4. Двойная запись: fast-path создал сон, модель создала его же ещё раз.
  //    Один экземпляр уже мягко удалён — есть что вернуть.
  const t4 = at(2, 13, 5);
  const u4 = say('уснул', t4);
  add({
    type: 'sleep',
    subtype: 'nap',
    started_at: t4,
    ended_at: t4 + 80 * MINUTE,
    source: 'alice-fast',
    confidence: 0.95,
    utterance: u4,
  });
  add({
    type: 'sleep',
    subtype: 'nap',
    started_at: t4 + 40 * 1000,
    ended_at: t4 + 80 * MINUTE,
    source: 'alice-llm',
    confidence: 0.6,
    deleted_at: t4 + 3 * DAY,
    utterance: u4,
  });

  // 5. Время названо словами и уехало: «полчаса назад» посчитали от полуночи.
  const t5 = at(0, 11, 40);
  if (past(t5)) {
    const u5 = say('он уснул полчаса назад', t5);
    add({
      type: 'sleep',
      subtype: 'nap',
      started_at: at(0, 0, 30),
      ended_at: at(0, 1, 15),
      source: 'alice-llm',
      confidence: 0.38,
      utterance: u5,
    });
  }

  // 6. Симптом: срыгивание после кормления.
  const t6 = at(2, 19, 25);
  const u6 = say('срыгнул после кормления, немного', t6);
  add({
    type: 'symptom',
    subtype: 'spit_up',
    started_at: t6,
    note: 'немного',
    source: 'alice-llm',
    confidence: 0.8,
    utterance: u6,
  });

  // 7. Запись, добавленная руками: фразы у неё нет, в ленте стоит отдельной строкой.
  const t7 = at(1, 21, 15);
  add({
    type: 'symptom',
    subtype: 'colic',
    started_at: t7,
    ended_at: t7 + 40 * MINUTE,
    note: 'поджимал ножки, успокоился на руках',
    source: 'manual',
  });

  // 8. Фраза, которую разбор не осилил: события нет вовсе. В ленте видно как пробел.
  say('он сегодня какой-то не такой, покряхтывает', at(0, 15, 30), 'failed', 'unknown');

  // 9. И одна фраза прямо сейчас в очереди.
  say('поменяла подгузник и покормила', Date.now() - 4000, 'pending', 'unknown');

  /*
   * 10. Точечное событие с прода: модель ставит ended_at РАВНЫМ started_at.
   *     Длительности у подгузника нет по смыслу, и журнал печатал бессмысленное
   *     «0 мин» — ровно эта строка была на скриншоте заказчика.
   */
  const t10 = at(0, 21, 4);
  if (past(t10)) {
    const u10 = say('что он пописал', t10);
    add({
      type: 'diaper',
      subtype: 'wet',
      started_at: t10,
      ended_at: t10,
      source: 'alice-llm',
      confidence: 0.9,
      utterance: u10,
    });
  }

  // 11. То же самое у взвешивания: точка во времени, а не промежуток.
  const t11 = at(1, 9, 20);
  // Значение — с той же кривой: этот случай про `ended_at`, а не про выброс веса.
  const grams11 = weightFor(ageDays(localDateKey(t11)));
  const u11 = say(`взвесили, ${(grams11 / 1000).toFixed(2).replace('.', ',')}`, t11);
  add({
    type: 'measure',
    subtype: 'weight',
    started_at: t11,
    ended_at: t11,
    value_num: grams11,
    value_unit: 'g',
    source: 'alice-llm',
    confidence: 0.88,
    utterance: u11,
  });

  // 12. Кормление короче полуминуты: длительность настоящая, но округляется в ноль.
  const t12 = at(1, 3, 10);
  const u12 = say('чуть-чуть приложила', t12);
  add({
    type: 'feed',
    subtype: 'breast',
    started_at: t12,
    ended_at: t12 + 20 * 1000,
    note: 'left',
    source: 'alice-llm',
    confidence: 0.6,
    utterance: u12,
  });

  /*
   * 13. Наблюдения-состояния (§10.2): желтизна кожи и белков глаз.
   *
   * Держатся сутками, поэтому у них есть `ended_at`, и «Сводка» показывает
   * не частоту, а протяжённость. Здесь намеренно обе формы сразу: кожа уже
   * прошла (закрытый отрезок), белки ещё нет (открытый) — на экране это
   * «с 5-го по 9-й день» и «с 6-го дня, продолжается».
   *
   * Отметка «стало желтее» лежит ПОВЕРХ открытого состояния точкой: она
   * не закрывает его и не двигает границ.
   */
  const yellowFrom = at(10, 9, 30); // 5-е сутки жизни
  const yellowTo = at(6, 12, 0); // 9-е сутки
  if (past(yellowFrom)) {
    const uy = say('он какой-то желтенький', yellowFrom);
    add({
      type: 'symptom',
      subtype: 'skin_yellow',
      started_at: yellowFrom,
      ended_at: past(yellowTo) ? yellowTo : null,
      note: 'желтенький',
      source: 'alice-llm',
      confidence: 0.85,
      utterance: uy,
    });
  }

  const yellowMore = at(8, 18, 40);
  if (past(yellowMore)) {
    const um = say('кажется стало желтее', yellowMore);
    add({
      type: 'symptom',
      subtype: 'skin_yellow',
      started_at: yellowMore,
      ended_at: yellowMore,
      note: 'стало желтее',
      source: 'alice-llm',
      confidence: 0.7,
      utterance: um,
    });
  }

  const eyesFrom = at(9, 11, 15); // 6-е сутки, до сих пор держится
  if (past(eyesFrom)) {
    const ue = say('у него белки глаз жёлтые', eyesFrom);
    add({
      type: 'symptom',
      subtype: 'eyes_yellow',
      started_at: eyesFrom,
      ended_at: null,
      note: 'белки глаз жёлтые',
      source: 'alice-llm',
      confidence: 0.9,
      utterance: ue,
    });
  }

  /*
   * Сыпь — такое же состояние: держится днями, и врач спрашивает про неё
   * то же самое. Здесь закрытый отрезок: появилась и прошла.
   * Место («на щеках») лежит в note — отдельных подтипов по месту нет.
   */
  const rashFrom = at(7, 20, 10);
  const rashTo = at(4, 9, 0);
  if (past(rashFrom)) {
    const ur = say('у него сыпь на щеках', rashFrom);
    add({
      type: 'symptom',
      subtype: 'rash',
      started_at: rashFrom,
      ended_at: past(rashTo) ? rashTo : null,
      note: 'сыпь на щеках',
      source: 'alice-llm',
      confidence: 0.85,
      utterance: ur,
    });
  }

  /*
   * Температура — из ОБОИХ мест, где она может лежать: замером и жаром,
   * записанным симптомом. Ровно эта пара и показывает починку: раньше
   * сводка читала только `measure/temp`, и вторая запись пропадала.
   */
  const tempAt = at(5, 21, 30);
  if (past(tempAt)) {
    const ut = say('померили температуру, тридцать семь и две', tempAt);
    add({
      type: 'measure',
      subtype: 'temp',
      started_at: tempAt,
      ended_at: tempAt,
      value_num: 37.2,
      value_unit: 'c',
      source: 'alice-llm',
      confidence: 0.95,
      utterance: ut,
    });
  }

  const feverAt = at(5, 23, 50);
  if (past(feverAt)) {
    const uf = say('ночью было тридцать восемь и четыре', feverAt);
    add({
      type: 'symptom',
      subtype: 'fever',
      started_at: feverAt,
      ended_at: feverAt,
      value_num: 38.4,
      value_unit: 'c',
      note: 'ночью',
      source: 'alice-llm',
      confidence: 0.85,
      utterance: uf,
    });
  }

  const tempBack = at(4, 8, 20);
  if (past(tempBack)) {
    const ub = say('утром тридцать шесть и восемь', tempBack);
    add({
      type: 'measure',
      subtype: 'temp',
      started_at: tempBack,
      ended_at: tempBack,
      value_num: 36.8,
      value_unit: 'c',
      source: 'alice-llm',
      confidence: 0.95,
      utterance: ub,
    });
  }
}

// Вес при рождении — точка отсчёта для графика веса. Берётся как самое раннее
// измерение, поэтому просто кладём его первым.
const BIRTH_MS = Date.parse(`${CHILD_BIRTHDATE}T04:35:00`);
add({
  type: 'measure',
  subtype: 'weight',
  started_at: BIRTH_MS,
  value_num: 4620,
  value_unit: 'g',
  note: 'вес при рождении',
  confidence: 0.95,
  utterance: say('вес при рождении 4,62', BIRTH_MS, 'done', 'unknown'),
});

if (!EMPTY) {
  for (let d = RECORDED_DAYS - 1; d >= 0; d--) {
    // Событий до рождения не бывает: широкое окно не повод выдумывать ребёнку
    // лишние сутки жизни.
    if (at(d, 12) < BIRTH_MS) continue;
    seedDay(d);
  }
  // Составные фразы и ошибки разбора живут на сутках 0–3. В разреженном режиме
  // их сеять нельзя: они бы сами закрыли те пробелы, ради которых он и нужен.
  if (RECORDED_DAYS >= 7) seedInteresting();
  if (RECORDED_DAYS >= 1) seedPhrases();
}
events.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));

// ------------------------------------------------------------------ выборки

function ageDays(dateStr) {
  const birth = Date.parse(`${CHILD_BIRTHDATE}T00:00:00Z`);
  const at = dateStr ? Date.parse(`${dateStr}T12:00:00Z`) : Date.now();
  return Math.max(0, Math.floor((at - birth) / DAY));
}

/** §10.1 — ровно та же форма, что отдаёт apps/server/src/taxonomy.ts normsForAge(). */
function normsForAge(age) {
  const day = Math.max(1, Math.floor(age) + 1);
  const wetMin = day >= 5 ? 6 : day;
  return {
    ageDays: Math.max(0, Math.floor(age)),
    feeds: { min: 8, max: 12, note: 'ориентир AAP для новорождённого: 8–12 кормлений за 24 часа' },
    wetDiapers: {
      min: wetMin,
      note:
        day >= 5
          ? 'с 5-го дня — 6 и более мокрых подгузников в сутки'
          : `день ${day}: ориентир — ${wetMin} мокрых подгузника в сутки`,
    },
    dirtyDiapers: { min: 3, max: 4, note: 'после первых дней — 3–4 грязных подгузника в сутки' },
  };
}

function live() {
  return events.filter((e) => !e.deleted_at);
}

function utteranceById(id) {
  return utterances.find((u) => u.id === id) ?? null;
}

/**
 * Событие наружу. Фраза — ПЛОСКИМ полем utterance_text, как в
 * apps/server/src/events.ts (LEFT JOIN u.raw_text). Никакого вложенного объекта:
 * настоящий сервер его не отдаёт, и админка не должна на него рассчитывать.
 */
function toDto(e) {
  const u = e.utterance_id != null ? utteranceById(e.utterance_id) : null;
  return { ...e, utterance_text: u ? u.raw_text : null };
}

function localDateKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Форма — как у dailyStats() на сервере, порядок дней ПО ВОЗРАСТАНИЮ. */
function buildStats(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayMs = at(i, 12);
    const key = localDateKey(dayMs);
    const dayEvents = live().filter((e) => localDateKey(Date.parse(e.started_at)) === key);

    const feeds = dayEvents.filter((e) => e.type === 'feed');
    const volumes = feeds.filter((e) => e.value_unit === 'ml' && e.value_num != null);
    const diapers = dayEvents.filter((e) => e.type === 'diaper');
    /*
     * Сон берётся не «начался в эти сутки», а «пересекается с этими сутками»,
     * и режется по их границам — ровно как sleepSegments на сервере. Мок клал
     * всю ночь в те сутки, где она началась: ночь с 22:10 до 6:35 давала одним
     * суткам 8 ч 25 мин, а следующим — ноль. Ни одно из двух чисел не верно.
     */
    const dayStart = at(i, 0);
    const dayEnd = at(i - 1, 0);
    let totalMin = 0;
    let longestMin = 0;
    let sessions = 0;
    for (const s of live()) {
      if (s.type !== 'sleep') continue;
      const a = Date.parse(s.started_at);
      const b = Math.max(a, s.ended_at ? Date.parse(s.ended_at) : Date.now());
      const lo = Math.max(a, dayStart);
      const hi = Math.min(b, dayEnd);
      if (hi <= lo) continue;
      const min = Math.round((hi - lo) / MINUTE);
      totalMin += min;
      sessions += 1;
      longestMin = Math.max(longestMin, min);
    }

    const lastOf = (subtype, convert = (v) => v) => {
      const rows = dayEvents
        .filter((e) => e.type === 'measure' && e.subtype === subtype && e.value_num != null)
        .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
      const found = rows.at(-1);
      return found ? convert(found.value_num, found.value_unit) : null;
    };

    const age = ageDays(key);
    out.push({
      date: key,
      ageDays: age,
      feeds: {
        total: feeds.length,
        breast: feeds.filter((f) => f.subtype === 'breast').length,
        bottle: feeds.filter((f) => f.subtype === 'bottle').length,
        solid: feeds.filter((f) => f.subtype === 'solid').length,
        // объём необязателен (§10.2): ни одного названного — null, а не 0
        volumeMl:
          volumes.length === 0
            ? null
            : Math.round(volumes.reduce((s, f) => s + f.value_num, 0)),
      },
      // Как на сервере (dailyStats в apps/server/src/events.ts): подгузник,
      // который был И мокрым, И грязным, засчитывается в ОБА ряда. Мок считал
      // его отдельной третьей кучкой — и прятал этим двойной счёт в админке,
      // которая к `wet` прибавляла `both` ещё раз.
      diapers: (() => {
        const both = diapers.filter((d) => d.subtype === 'both').length;
        return {
          wet: diapers.filter((d) => d.subtype === 'wet').length + both,
          dirty: diapers.filter((d) => d.subtype === 'dirty').length + both,
          both,
          total: diapers.length,
        };
      })(),
      sleep: { totalMin, sessions, longestMin },
      measures: {
        weightG: lastOf('weight', (v, u) => (u === 'kg' ? Math.round(v * 1000) : v)),
        heightCm: lastOf('height'),
        headCm: lastOf('head'),
        // Как на сервере (`maxTempC`): ХУДШЕЕ за сутки и из ОБОИХ мест —
        // measure/temp и symptom/fever. Мок, который читает одно место,
        // перестаёт быть заменой сервера ровно там, где чинили поломку.
        tempMaxC: (() => {
          const degrees = dayEvents.filter(
            (e) =>
              e.value_num != null &&
              (e.value_unit === 'c' || e.value_unit == null) &&
              ((e.type === 'measure' && e.subtype === 'temp') ||
                (e.type === 'symptom' && e.subtype === 'fever')),
          );
          return degrees.length === 0 ? null : Math.max(...degrees.map((e) => e.value_num));
        })(),
      },
      norms: normsForAge(age),
    });
  }
  return out;
}

function buildState() {
  const sleeps = live()
    .filter((e) => e.type === 'sleep')
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const open = sleeps.find((s) => !s.ended_at);
  const last = sleeps.find((s) => s.ended_at);
  const now = Date.now();
  const today = buildStats(1)[0];
  return {
    now: iso(now),
    child: { name: CHILD_NAME, birthDate: CHILD_BIRTHDATE, ageDays: ageDays() },
    sleep: {
      status: open ? 'asleep' : 'awake',
      since: open ? open.started_at : (last?.ended_at ?? iso(now)),
      currentDurationMin: open ? Math.round((now - Date.parse(open.started_at)) / MINUTE) : 0,
      lastSleep: last
        ? {
            startedAt: last.started_at,
            endedAt: last.ended_at,
            durationMin: Math.round(
              (Date.parse(last.ended_at) - Date.parse(last.started_at)) / MINUTE,
            ),
          }
        : null,
    },
    today: {
      date: today.date,
      sleepTotalMin: today.sleep.totalMin,
      sleepSessions: today.sleep.sessions,
      longestSleepMin: today.sleep.longestMin,
    },
    pending: utterances.filter((u) => u.status === 'pending').length,
  };
}

// ------------------------------------------------------------ журнал (§9.2)

/** @type {any[]} */
const changeSets = [];
let csSeq = 0;

/**
 * @param utteranceId обязателен для фраз: по нему админка понимает, ЧТО сделала
 *   фраза. Без него «проснулся», закрывший сон, выглядит не сделавшим ничего.
 */
function newChangeSet(summary, rows, utteranceId = null) {
  const cs = {
    id: `cs-${String(++csSeq).padStart(4, '0')}`,
    utterance_id: utteranceId,
    summary,
    created_at: iso(Date.now()),
    reverted_at: null,
    // снимок «до» — из него и восстанавливаем
    before: rows.map((r) => ({ ...r })),
  };
  changeSets.push(cs);
  return cs;
}

/**
 * Событиям, помеченным удалёнными прямо в сиде, нужен набор изменений в журнале —
 * иначе «Вернуть» для старого удаления нечем проверить: ровно этот путь ищет
 * админка через GET /api/change-sets.
 */
for (const row of events.filter((e) => e.deleted_at)) {
  const cs = newChangeSet(`Удаление события ${row.id} моделью`, [{ ...row, deleted_at: null }]);
  cs.created_at = row.deleted_at;
}

/*
 * Живой случай с прода: «андрей проснулся» не создаёт события, а ЗАКРЫВАЕТ начатый
 * ранее сон. Событие принадлежит другой, более ранней фразе, поэтому связь видна
 * только через набор изменений. Без этого случая мок снова спрятал бы дефект.
 */
if (!EMPTY) {
  const openSleep = [...events]
    .reverse()
    .find((e) => e.type === 'sleep' && e.ended_at && !e.deleted_at);
  if (openSleep) {
    const wokeAt = Date.parse(openSleep.ended_at);
    const u = say('андрей проснулся', wokeAt, 'skipped', 'sleep_end');
    const cs = newChangeSet(
      'Быстрый разбор фразы: «андрей проснулся»',
      // снимок «до»: сон ещё шёл
      [{ ...openSleep, ended_at: null }],
      u.id,
    );
    cs.created_at = iso(wokeAt);
  }

  // Фраза, создавшая записи, тоже должна отменяться целиком.
  const composite = events.filter((e) => e.utterance_id != null && e.confidence === 0.41);
  if (composite.length) {
    const cs = newChangeSet(
      'Разбор фразы моделью: «Андрей покушал и уснул»',
      composite.map((e) => ({ ...e })),
      composite[0].utterance_id,
    );
    // созданные записи: снимок «до» пустой, откат их спрячет
    cs.before = cs.before.map((r) => ({ ...r, __created: true }));
    cs.created_at = composite[0].created_at;
  }

  /*
   * Тот же случай, но разобранный МОДЕЛЬЮ, а не быстрым матчером: «что он
   * проснулся» приходит со статусом done, событий не создаёт и закрывает
   * начатый вечером ночной сон. Именно эта строка была на скриншоте заказчика
   * как «странное событие»: в свёрнутом виде она показывала сырую цитату.
   */
  const nightStart = at(1, 22, 5);
  const wokeUp = at(0, 5, 15);
  const nightSleep = add({
    type: 'sleep',
    subtype: 'night',
    started_at: nightStart,
    ended_at: wokeUp,
    source: 'alice-fast',
    confidence: 0.95,
    utterance: say('он заснул', nightStart, 'skipped', 'sleep_start'),
  });
  const uWoke = say('что он проснулся', wokeUp, 'done');
  const csWoke = newChangeSet(
    'Разбор фразы моделью: «что он проснулся»',
    // снимок «до»: сон ещё шёл
    [{ ...nightSleep, ended_at: null }],
    uWoke.id,
  );
  csWoke.created_at = iso(wokeUp);

  // события добавились после общей сортировки — восстанавливаем порядок
  events.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}

function changeSetDto(cs) {
  return {
    id: cs.id,
    utterance_id: cs.utterance_id,
    summary: cs.summary,
    created_at: cs.created_at,
    reverted_at: cs.reverted_at,
    revisions: cs.before.length,
    events: cs.before.map((r) => r.id),
  };
}


// ------------------------------------------------------------------ http

/** Ровно те поля, что принимает patchEventSchema на сервере. deleted_at среди них НЕТ. */
const PATCHABLE = new Set([
  'type',
  'subtype',
  'started_at',
  'ended_at',
  'value_num',
  'value_unit',
  'note',
]);

const EVENT_TYPES = new Set([
  'sleep', 'feed', 'pump', 'diaper', 'measure', 'meds', 'symptom', 'activity', 'note',
]);
const VALUE_UNITS = new Set(['ml', 'g', 'kg', 'c', 'cm', 'min', 'mg']);

/** Повторяет zod-проверки сервера: он тоже отвечает 400, а не «молча чинит». */
function validatePatch(body) {
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!PATCHABLE.has(key)) continue; // неизвестные ключи zod срезает
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) return { error: 'нечего менять: тело пустое' };
  if ('type' in patch && !EVENT_TYPES.has(patch.type)) return { error: 'неизвестный type' };
  if ('value_unit' in patch && patch.value_unit != null && !VALUE_UNITS.has(patch.value_unit)) {
    return { error: 'неизвестный value_unit' };
  }
  if ('value_num' in patch && patch.value_num != null && !Number.isFinite(patch.value_num)) {
    return { error: 'value_num должен быть числом' };
  }
  for (const key of ['started_at', 'ended_at']) {
    if (key in patch && patch[key] != null && Number.isNaN(Date.parse(patch[key]))) {
      return { error: `${key} не разбирается как дата` };
    }
  }
  return { patch };
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Отдаём собранную админку по /dash — так же, как это сделает настоящий сервер. */
function serveDash(pathname, res) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dist не собран: pnpm --filter @babytracker/admin build');
    return;
  }
  const rel = pathname.replace(/^\/dash\/?/, '') || 'index.html';
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (pathname === '/healthz') {
    return json(res, 200, {
      ok: true,
      db: true,
      worker: { alive: true, lastRunAt: iso(Date.now() - 2000), queueDepth: 0 },
    });
  }

  if (pathname.startsWith('/dash')) return serveDash(pathname, res);

  if (!pathname.startsWith('/api/')) {
    return json(res, 404, { error: 'not found' });
  }

  if (FORCE_401) {
    // Как отвечает настоящая дверь (§11): без www-authenticate — окна ввода
    // пароля больше нет, вместо него экран сопряжения.
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'unauthorized', pair: '/pair' }));
  }

  // Экран «Устройства» (§11). В моке сопряжение не имитируется целиком: нужны
  // именно данные для вёрстки — заявка с кодом и пара подключённых устройств.
  if (pathname === '/api/devices') {
    return json(res, 200, {
      pending: [
        {
          id: 1,
          userCode: 'WDJB-MJHT',
          kind: 'tv',
          label: 'Телевизор',
          requestedAt: iso(Date.now() - 40_000),
          expiresAt: iso(Date.now() + 560_000),
          secondsLeft: 560,
        },
      ],
      sessions: [
        {
          id: 'mock-phone',
          kind: 'phone',
          label: 'iPhone',
          createdAt: iso(Date.now() - 86_400_000 * 9),
          lastSeenAt: iso(Date.now() - 120_000),
          expiresAt: iso(Date.now() + 86_400_000 * 90),
          current: true,
        },
        {
          id: 'mock-tv',
          kind: 'tv',
          label: 'Телевизор в детской',
          createdAt: iso(Date.now() - 86_400_000 * 40),
          lastSeenAt: iso(Date.now() - 5_000),
          expiresAt: null,
          current: false,
        },
      ],
      codeTtlSec: 600,
    });
  }

  if (/^\/api\/(devices|auth)\//.test(pathname) && req.method === 'POST') {
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/state') return json(res, 200, buildState());

  if (pathname === '/api/stats/daily') {
    const days = Math.min(90, Math.max(1, Number(parsed.searchParams.get('days') ?? 7)));
    return json(res, 200, { days: buildStats(days) });
  }

  if (pathname === '/api/utterances') {
    if (NO_UTTERANCES) return json(res, 500, { error: 'mock: ручка нарочно сломана' });
    // Сервер режет limit схемой zod и отвечает 400, а не «подрезает молча».
    // Мок обязан вести себя так же — иначе он спрячет ровно эту ошибку.
    const raw = parsed.searchParams.get('limit');
    const limit = raw == null ? 20 : Number(raw);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
      return json(res, 400, {
        error: 'bad_request',
        issues: [{ path: ['limit'], message: 'limit: максимум 200' }],
      });
    }
    const rows = [...utterances]
      .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at))
      .slice(0, limit);
    return json(res, 200, { utterances: rows });
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    const p = parsed.searchParams;
    const from = p.get('from') ? Date.parse(p.get('from')) : null;
    const to = p.get('to') ? Date.parse(p.get('to')) : null;
    const type = p.get('type');
    const includeDeleted = p.get('include_deleted') === 'true';
    const limit = Math.min(1000, Number(p.get('limit') ?? 200));

    const rows = events
      .filter((e) => includeDeleted || !e.deleted_at)
      .filter((e) => !type || e.type === type)
      .filter((e) => {
        const ms = Date.parse(e.started_at);
        if (from != null && ms < from) return false;
        if (to != null && ms > to) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
      .slice(0, limit)
      .map(toDto);
    return json(res, 200, { events: rows });
  }

  if (pathname === '/api/events' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.type || !body.started_at) {
      return json(res, 400, { error: 'нужны type и started_at' });
    }
    const row = add({ ...body, started_at: Date.parse(body.started_at), source: 'manual' });
    return json(res, 201, { event: toDto(row) });
  }

  // --- §9.6: журнал изменений. Единственная дорога вернуть удалённое.
  if (pathname === '/api/change-sets' && req.method === 'GET') {
    const limit = Math.min(200, Number(parsed.searchParams.get('limit') ?? 20));
    const rows = [...changeSets].reverse().slice(0, limit).map(changeSetDto);
    return json(res, 200, { changeSets: rows });
  }

  const csRevert = pathname.match(/^\/api\/change-sets\/([\w-]+)\/revert$/);
  if (csRevert && req.method === 'POST') {
    const cs = changeSets.find((c) => c.id === csRevert[1]);
    if (!cs) return json(res, 404, { error: 'revert_failed', message: 'набор не найден' });
    const alreadyReverted = Boolean(cs.reverted_at);
    const restored = [];
    for (const before of cs.before) {
      const row = events.find((e) => e.id === before.id);
      if (!row) continue;
      if (before.__created) {
        // строку создал этот набор — физически удалить нельзя, значит прячем (§9.1)
        row.deleted_at = row.deleted_at ?? iso(Date.now());
        row.updated_at = iso(Date.now());
      } else {
        const { __created, ...snapshot } = before;
        Object.assign(row, snapshot, { updated_at: iso(Date.now()) });
      }
      restored.push(toDto(row));
    }
    cs.reverted_at = iso(Date.now());
    return json(res, 200, {
      reverted: cs.id,
      revertChangeSetId: `${cs.id}-rev`,
      restored,
      alreadyReverted,
    });
  }

  const match = pathname.match(/^\/api\/events\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    const row = events.find((e) => e.id === id);
    if (!row) return json(res, 404, { error: 'not_found', id });

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { error: 'bad_request', issues: 'тело не разобралось' });
      const { patch, error } = validatePatch(body);
      if (error) return json(res, 400, { error: 'bad_request', issues: error });

      const cs = newChangeSet(`Ручная правка события ${id} через дашборд`, [row]);
      Object.assign(row, patch, { updated_at: iso(Date.now()) });
      return json(res, 200, { event: toDto(row), changeSetId: cs.id });
    }

    if (req.method === 'DELETE') {
      // §9.1: физического удаления не существует, только deleted_at.
      const cs = newChangeSet(`Удаление события ${id} через дашборд`, [row]);
      row.deleted_at = iso(Date.now());
      row.updated_at = row.deleted_at;
      return json(res, 200, { event: toDto(row), changeSetId: cs.id, revertWith: cs.id });
    }
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`mock BabyTracker API  → http://localhost:${PORT}`);
  console.log(`  события: ${events.length}, фразы: ${utterances.length}`);
  if (FORCE_401) console.log('  MOCK_401=1 — /api отвечает 401');
  if (EMPTY) console.log('  MOCK_EMPTY=1 — только вес при рождении');
  if (NO_UTTERANCES) console.log('  MOCK_NO_UTTERANCES=1 — /api/utterances отвечает 500');
  if (fs.existsSync(DIST)) console.log(`  собранная админка → http://localhost:${PORT}/dash`);
});
