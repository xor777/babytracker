import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { TrackerEvent } from '../src/types.ts';

/*
 * Модуль подписей лежит рядом с временем суток, а оно читает зону из адреса
 * страницы. Тесты гоняет сам node, окна тут нет — подставляем пустой адрес,
 * иначе импорт падает ещё до первой проверки.
 */
(globalThis as unknown as { window: unknown }).window = { location: { search: '' } };
const { feedHeadline } = await import('../src/lib/day.ts');

const ev = (subtype: string | null, extra: Partial<TrackerEvent> = {}): TrackerEvent =>
  ({
    id: 1,
    child_id: 'andrey',
    type: 'feed',
    subtype,
    started_at: '2026-09-16T09:16:55.214Z',
    ended_at: '2026-09-16T10:00:26.808Z',
    value_num: null,
    value_unit: null,
    note: null,
    source: 'alice-llm',
    utterance_id: null,
    confidence: 0.9,
    created_at: '2026-09-16T09:16:55.214Z',
    updated_at: '2026-09-16T09:16:55.214Z',
    deleted_at: null,
    ...extra,
  }) as TrackerEvent;

/*
 * Живой случай с прода: на «начал есть» и «закончил кушать» модель записала
 * кормление, а вид оставила пустым — назвать его было нечем. На экране
 * получалось «ПОСЛЕДНИЙ РАЗ ЕЛ · КОРМЛЕНИЕ».
 */
test('без вида кормления подпись меняется, а не слово', () => {
  const h = feedHeadline(ev(null), 'последний раз ел', 'последнее');
  assert.equal(h.label, 'последнее');
  assert.equal(h.word, 'КОРМЛЕНИЕ');
  assert.doesNotMatch(`${h.label} ${h.word}`.toLowerCase(), /ел кормление/);
});

test('пустая строка в виде кормления считается отсутствием вида', () => {
  assert.equal(feedHeadline(ev('   '), 'последний раз ел', 'последнее').label, 'последнее');
});

test('известный вид оставляет обычную подпись', () => {
  const h = feedHeadline(ev('breast'), 'последний раз ел', 'последнее');
  assert.equal(h.label, 'последний раз ел');
  assert.equal(h.word, 'ГРУДЬ');
});

test('объём остаётся в слове и при неизвестном виде', () => {
  const h = feedHeadline(ev(null, { value_num: 30, value_unit: 'ml' }), 'последний раз ел', 'последнее');
  assert.equal(h.label, 'последнее');
  assert.equal(h.word, 'КОРМЛЕНИЕ 30 МЛ');
});

test('нет события — подпись для пустого случая', () => {
  assert.equal(feedHeadline(null, 'последний раз ел', 'последнее').label, 'последнее');
});
