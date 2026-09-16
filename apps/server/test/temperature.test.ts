/**
 * Температура: два места хранения, одно чтение (§10.2, §10.4).
 *
 * Поломка, ради которой написан файл. Таксономия разрешает единицу `c` и у
 * `measure/temp`, и у `symptom/fever`, то есть у модели было два законных
 * места для одного числа. А `dailyStats` читала только первое — и жар,
 * записанный симптомом, в сводку не попадал ВООБЩЕ. Не «показывался
 * неточно»: врач не видел его вовсе.
 *
 * Починка двусторонняя, и тесты сторожат обе стороны:
 *
 *   - ЧИТАЕМ оба места. В базе уже лежат записи обоих видов, физического
 *     удаления в `events` нет (§9), и переписывать настоящие данные ради
 *     единообразия нельзя. Запись была верна — неверен был запрос.
 *   - ПИШЕМ в одно: градусы → `measure/temp`, `symptom/fever` остаётся
 *     жаром без числа. Модели это сказано в подсказке таксономии.
 *
 * Оценок здесь нет и быть не может: сводка отдаёт число, а «много это или
 * мало» решает врач.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { testConfig, testDb } from './helpers.ts';
import { dailyStats, insertEvent, softDeleteEvent } from '../src/events.ts';
import { TAXONOMY } from '../src/taxonomy.ts';
import { isTemperatureReading } from '../../../shared/taxonomy.ts';
import type { Db } from '../src/db.ts';

const cfg = testConfig(); // ребёнок родился 2026-03-01, TZ Europe/Moscow
const NOW = new Date('2026-09-15T12:00:00.000Z');

function add(db: Db, type: string, subtype: string | null, extra: Record<string, unknown> = {}): void {
  insertEvent(db, {
    type,
    subtype,
    source: 'manual',
    started_at: '2026-09-15T09:00:00.000Z',
    ...extra,
  });
}

const today = (db: Db) => dailyStats(db, cfg, 1, NOW)[0]!;

/* ------------------------------------------------------------------ */
/* Сводка видит оба источника                                          */
/* ------------------------------------------------------------------ */

test('жар, записанный симптомом, доезжает до сводки', () => {
  const db = testDb();
  add(db, 'symptom', 'fever', { value_num: 38.4, value_unit: 'c' });

  assert.equal(
    today(db).measures.tempMaxC,
    38.4,
    'раньше здесь был null: сводка читала только measure/temp',
  );
  db.close();
});

test('максимум берётся по обоим источникам сразу', () => {
  const db = testDb();
  add(db, 'measure', 'temp', { value_num: 37.2, value_unit: 'c', started_at: '2026-09-15T06:00:00.000Z' });
  add(db, 'symptom', 'fever', { value_num: 38.6, value_unit: 'c', started_at: '2026-09-15T07:00:00.000Z' });
  add(db, 'measure', 'temp', { value_num: 36.9, value_unit: 'c', started_at: '2026-09-15T09:00:00.000Z' });

  assert.equal(
    today(db).measures.tempMaxC,
    38.6,
    'пик может лежать в любом из двух мест — сводится максимум',
  );
  db.close();
});

test('старое поведение не сломано: только measure/temp считается как прежде', () => {
  const db = testDb();
  add(db, 'measure', 'temp', { value_num: 37.2, value_unit: 'c', started_at: '2026-09-15T06:00:00.000Z' });
  add(db, 'measure', 'temp', { value_num: 38.4, value_unit: 'c', started_at: '2026-09-15T07:00:00.000Z' });

  assert.equal(today(db).measures.tempMaxC, 38.4);
  db.close();
});

test('жар без числа температуру не выдумывает', () => {
  const db = testDb();
  // «Он горячий» — факт, но не градусы. Подставлять сюда что-либо нельзя:
  // отсутствующее значение это NULL, а не число.
  add(db, 'symptom', 'fever', { value_num: null, value_unit: null });

  assert.equal(today(db).measures.tempMaxC, null);
  db.close();
});

test('число без единицы у температуры считается градусами', () => {
  const db = testDb();
  add(db, 'symptom', 'fever', { value_num: 37.8, value_unit: null });

  assert.equal(
    today(db).measures.tempMaxC,
    37.8,
    'у fever и temp единица «c» единственная осмысленная — терять число из-за пустого поля нельзя',
  );
  db.close();
});

test('чужая единица за градусы не выдаётся', () => {
  const db = testDb();
  add(db, 'symptom', 'fever', { value_num: 120, value_unit: 'ml' });

  assert.equal(today(db).measures.tempMaxC, null, '120 мл — это не 120 градусов');
  db.close();
});

test('удалённая запись в максимум не попадает', () => {
  const db = testDb();
  add(db, 'measure', 'temp', { value_num: 37.0, value_unit: 'c' });
  const rows = dailyStats(db, cfg, 1, NOW);
  assert.equal(rows[0]!.measures.tempMaxC, 37.0);

  add(db, 'symptom', 'fever', { value_num: 39.5, value_unit: 'c' });
  const wrong = today(db);
  assert.equal(wrong.measures.tempMaxC, 39.5);

  // Ошибочную запись удаляют мягко (§9) — и она перестаёт влиять на сводку.
  const fever = insertEvent(db, {
    type: 'symptom',
    subtype: 'fever',
    source: 'manual',
    started_at: '2026-09-15T10:00:00.000Z',
    value_num: 41.0,
    value_unit: 'c',
  });
  assert.equal(today(db).measures.tempMaxC, 41.0);
  softDeleteEvent(db, fever.event.id);
  assert.equal(today(db).measures.tempMaxC, 39.5, 'удалённое значение из пика ушло');
  db.close();
});

test('температуру не записывали — null, а не ноль', () => {
  const db = testDb();
  add(db, 'feed', 'breast');
  add(db, 'symptom', 'rash');

  assert.equal(today(db).measures.tempMaxC, null);
  db.close();
});

/* ------------------------------------------------------------------ */
/* Правило «где лежат градусы» — одно на репозиторий                    */
/* ------------------------------------------------------------------ */

test('градусами считаются ровно два места', () => {
  const t = (type: string, subtype: string | null) =>
    isTemperatureReading({ type, subtype, value_num: 38, value_unit: 'c' });

  assert.equal(t('measure', 'temp'), true);
  assert.equal(t('symptom', 'fever'), true);
  assert.equal(t('symptom', 'rash'), false);
  assert.equal(t('measure', 'weight'), false);
  assert.equal(t('note', null), false);
});

/* ------------------------------------------------------------------ */
/* Договорённость, которой учат модель                                  */
/* ------------------------------------------------------------------ */

test('подсказка таксономии отправляет градусы в measure/temp', () => {
  assert.match(
    TAXONOMY.symptom.hint,
    /градусы → measure\/temp/,
    'иначе у модели снова два равноправных места для одного числа',
  );
  assert.match(TAXONOMY.symptom.hint, /fever — жар БЕЗ числа/);
  // Единица `c` у symptom оставлена намеренно: в базе уже лежат записи
  // с градусами, и запрет сделал бы их невалидными по таксономии.
  assert.ok(
    TAXONOMY.symptom.units.includes('c'),
    'уже записанное должно оставаться валидным',
  );
});
