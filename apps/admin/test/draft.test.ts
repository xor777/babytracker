/**
 * Ручной ввод времени в карточке правки.
 *
 * Жалоба с прода дословно: «я в журнале открыл запись и руками вписал цифру
 * времени окончания сна и кнопка сохранить не открылась. только если я пикером
 * выбираю открывается».
 *
 * Причина не в React, а в самом `<input type="datetime-local">`, и проверена
 * живьём в Chrome: пока в поле не заполнены обе половины — и дата, и время, —
 * `value` остаётся пустой строкой, а событие `input` не приходит вообще.
 * Набранные цифры человек видит, приложение — нет. Пикер же ставит дату и
 * время разом, поэтому «работает только пикером».
 *
 * Поэтому здесь два героя: модель нативного инпута (DateTimeInput) и чистая
 * часть карточки (reviewDraft). Кнопка «Сохранить» — это review.dirty.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { reviewDraft, suggestEnd, toDraft } from '../src/lib/draft';
import { msToLocalInput, parseTs } from '../src/lib/format';
import type { TrackerEvent } from '../src/types';

/**
 * Что делает нативный `datetime-local`, когда в него набирают цифры.
 * Сегменты заполняются сразу, а приложению значение достаётся только целиком.
 */
class DateTimeInput {
  date: string;
  time: string;

  constructor(value: string) {
    const [date = '', time = ''] = value ? value.split('T') : [];
    this.date = date;
    this.time = time;
  }

  get value(): string {
    return this.date && this.time ? `${this.date}T${this.time}` : '';
  }

  /**
   * Набор времени с клавиатуры.
   * @returns значение, пришедшее в onChange, или null — события не было вовсе.
   */
  typeTime(hhmm: string): string | null {
    const before = this.value;
    this.time = hhmm;
    const after = this.value;
    if (after === before) return null;
    return after;
  }
}

/** Ночной сон, ещё не закрытый: конца нет, у начала — секунды от Алисы. */
const openSleep: TrackerEvent = {
  id: 132,
  type: 'sleep',
  subtype: 'night',
  started_at: new Date(2026, 8, 15, 22, 10, 37).toISOString(),
  ended_at: null,
  source: 'alice-fast',
};

/** Тот же сон, но уже закрытый: поле конца непустое. */
const closedSleep: TrackerEvent = {
  ...openSleep,
  id: 117,
  ended_at: new Date(2026, 8, 16, 6, 35, 4).toISOString(),
};

/** Утро следующего дня: сон идёт одиннадцать часов, родитель только проснулся. */
const NOW = new Date(2026, 8, 16, 9, 20, 0).getTime();

test('жалоба заказчика: в пустое поле конца набрали время, а приложение об этом не узнало', () => {
  const input = new DateTimeInput(''); // конца нет — поле пустое
  const fired = input.typeTime('06:35');

  assert.equal(fired, null, 'браузер не отдаёт значение, пока пуста дата');
  assert.equal(input.value, '', 'и value остаётся пустым, сколько ни набирай');

  // Раз события не было, черновик остался прежним — кнопка так и стоит серой.
  const review = reviewDraft(openSleep, toDraft(openSleep));
  assert.equal(review.dirty, false, 'кнопка «Без изменений» — ровно то, на что жаловались');
});

test('подставленная дата делает ручной ввод равным пикеру', () => {
  const draft = toDraft(openSleep);

  // Человек коснулся поля: дату и время подставили за него.
  const seeded = suggestEnd(openSleep.started_at, NOW);
  const input = new DateTimeInput(seeded);

  // И только теперь он набирает своё время.
  const fired = input.typeTime('06:35');
  assert.equal(fired, `${seeded.split('T')[0]}T06:35`, 'теперь onChange получает значение');

  const review = reviewDraft(openSleep, { ...draft, ended: fired! }, false);
  assert.equal(review.dirty, true, 'кнопка «Сохранить» открылась');
  assert.equal(review.valid, true);
  assert.equal(
    parseTs(review.patch.ended_at),
    new Date(2026, 8, 16, 6, 35, 0).getTime(),
    'сохраняется ровно набранная минута сегодняшнего утра',
  );
});

test('одно касание поля не закрывает идущий сон', () => {
  const draft = toDraft(openSleep);
  const seeded = suggestEnd(openSleep.started_at, NOW);

  // Поле уже показывает подсказку, но человек не набрал ни цифры.
  const review = reviewDraft(openSleep, { ...draft, ended: seeded }, true);

  assert.equal(review.dirty, false, 'касание — это не правка');
  assert.equal('ended_at' in review.patch, false, 'в патч подсказка не попадает');
});

test('кнопка «Сейчас» закрывает сон текущей минутой', () => {
  const draft = toDraft(openSleep);
  const review = reviewDraft(openSleep, { ...draft, ended: msToLocalInput(NOW) }, false);

  assert.equal(review.dirty, true);
  assert.equal(review.valid, true);
  assert.equal(parseTs(review.patch.ended_at), new Date(2026, 8, 16, 9, 20, 0).getTime());
});

test('в непустом поле конца правка одной цифры работала и работает', () => {
  const draft = toDraft(closedSleep);
  const input = new DateTimeInput(draft.ended);

  const fired = input.typeTime('07:35');
  assert.notEqual(fired, null, 'у заполненного поля события приходили всегда');

  const review = reviewDraft(closedSleep, { ...draft, ended: fired! }, false);
  assert.equal(review.dirty, true);
  assert.equal(parseTs(review.patch.ended_at), new Date(2026, 8, 16, 7, 35, 0).getTime());
});

test('поле начала правится как прежде — и не трогается, когда его не трогали', () => {
  const draft = toDraft(closedSleep);

  const untouched = reviewDraft(closedSleep, draft);
  assert.equal(untouched.dirty, false);

  const input = new DateTimeInput(draft.started);
  const fired = input.typeTime('21:40');
  const moved = reviewDraft(closedSleep, { ...draft, started: fired! });
  assert.equal(parseTs(moved.patch.started_at), new Date(2026, 8, 15, 21, 40, 0).getTime());
});

test('сохранение «без правок» не срезает секунды у started_at (§10.3)', () => {
  // Инпут показывает 22:10, в базе 22:10:37. Патч не должен содержать времени вовсе:
  // иначе порядок событий внутри одной фразы поедет на ровном месте.
  const review = reviewDraft(closedSleep, toDraft(closedSleep));

  assert.equal('started_at' in review.patch, false);
  assert.equal('ended_at' in review.patch, false);
  assert.deepEqual(review.patch, {});
});

test('подсказка для конца: у идущего события — текущая минута, а не дата начала', () => {
  // Ночной сон с вечера закрывают утром следующего дня: дата начала тут соврала бы.
  assert.equal(suggestEnd(openSleep.started_at, NOW), msToLocalInput(NOW));
});

test('подсказка для конца: у давней записи без конца — время её начала', () => {
  // Кормление трёхдневной давности так и осталось без конца. Текущая минута
  // растянула бы его на трое суток; человеку тут править часы внутри своего дня.
  const old = new Date(2026, 8, 13, 7, 13, 0);
  assert.equal(suggestEnd(old.toISOString(), NOW), msToLocalInput(old.getTime()));
});

test('конец раньше начала остаётся ошибкой, а не молчаливой правкой', () => {
  const draft = toDraft(openSleep);
  // Начало 15-го в 22:10, человек набрал 06:35 того же дня.
  const ended = msToLocalInput(new Date(2026, 8, 15, 6, 35, 0).getTime());
  const review = reviewDraft(openSleep, { ...draft, ended }, false);

  assert.equal(review.valid, false);
  assert.equal(review.problems[0], 'Конец раньше начала.');
});
