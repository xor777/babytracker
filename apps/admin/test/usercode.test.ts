/**
 * Короткий код сопряжения на стороне того, кто его набирает (§11.3).
 *
 * Проверяется не форматирование ради форматирования: от этих функций зависит,
 * когда включится кнопка «Одобрить». Ошибка здесь стоит дорого с двух сторон —
 * кнопка, включившаяся рано, тратит одну из пяти попыток за окно, а кнопка,
 * не включившаяся вовремя, оставляет человека с набранным кодом и без
 * возможности его отправить.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  charsLeft,
  formatUserCode,
  isCompleteUserCode,
  normalizeUserCode,
} from '../src/lib/usercode';

test('код принимается в том виде, в каком его реально набирают', () => {
  // С экрана списывают вместе с тире — сервер сам его и нарисовал.
  assert.equal(normalizeUserCode('WDJB-MJHT'), 'WDJBMJHT');
  // Без тире — тоже.
  assert.equal(normalizeUserCode('WDJBMJHT'), 'WDJBMJHT');
  // Строчными: на телефоне заглавные включать лишнее движение.
  assert.equal(normalizeUserCode('wdjb-mjht'), 'WDJBMJHT');
  // Пробел от автодополнения по краям и внутри.
  assert.equal(normalizeUserCode('  wdjb mjht '), 'WDJBMJHT');
  // Всё сразу.
  assert.equal(normalizeUserCode(' Wdjb — mJhT '), 'WDJBMJHT');
});

test('гласные и цифры не превращаются молча в другие буквы — их просто нет', () => {
  /*
   * В алфавите §6.1 нет ни гласных, ни цифр. Значит `O` и `0` подставить
   * некуда: «исправив» их на что-то похожее, мы отправили бы на сервер код,
   * которого человек не набирал, и сожгли бы попытку. Правильное поведение —
   * отбросить, чтобы стало видно, что букв не хватает.
   */
  assert.equal(normalizeUserCode('WOJB'), 'WJB');
  assert.equal(normalizeUserCode('W0JB'), 'WJB');
  assert.equal(normalizeUserCode('123'), '');
  assert.equal(normalizeUserCode('привет'), '');

  for (const ch of USER_CODE_ALPHABET) {
    assert.equal(normalizeUserCode(ch), ch, `${ch} из алфавита обязан пройти`);
  }
  for (const ch of 'AEIOUY0123456789') {
    assert.equal(normalizeUserCode(ch), '', `${ch} в алфавите §6.1 не бывает`);
  }
});

test('лишние символы сверх длины кода отсекаются', () => {
  // Иначе поле молча копило бы девятый символ, которого не видно,
  // а сервер отвечал бы отказом на внешне верный код.
  assert.equal(normalizeUserCode('WDJBMJHTX'), 'WDJBMJHT');
  assert.equal(normalizeUserCode('WDJBMJHTXXXXX').length, USER_CODE_LENGTH);
});

test('тире появляется само и только после четвёртой буквы', () => {
  assert.equal(formatUserCode(''), '');
  assert.equal(formatUserCode('WDJ'), 'WDJ');
  assert.equal(formatUserCode('WDJB'), 'WDJB', 'на границе тире ещё не нужно');
  assert.equal(formatUserCode('WDJBM'), 'WDJB-M');
  assert.equal(formatUserCode('WDJBMJHT'), 'WDJB-MJHT');
});

test('показанное и набранное — одно и то же: форматирование обратимо', () => {
  // Поле показывает formatUserCode, а читает обратно normalizeUserCode.
  // Если эта пара не сходится, символы начнут теряться при каждом нажатии.
  for (const code of ['W', 'WDJB', 'WDJBM', 'WDJBMJHT']) {
    assert.equal(normalizeUserCode(formatUserCode(code)), code);
  }
});

test('кнопка «Одобрить» включается ровно на восьмой букве', () => {
  assert.equal(isCompleteUserCode(''), false);
  assert.equal(isCompleteUserCode('WDJBMJH'), false, 'семи мало');
  assert.equal(isCompleteUserCode('WDJBMJHT'), true);

  // Осталось набрать — подпись под полем, иначе неактивная кнопка молчит
  // о том, чего от человека ждут.
  assert.equal(charsLeft(''), USER_CODE_LENGTH);
  assert.equal(charsLeft('WDJBMJH'), 1);
  assert.equal(charsLeft('WDJBMJHT'), 0);
});

test('правила совпадают с серверными — иначе кнопка обещает то, чего сервер не примет', () => {
  /*
   * Клиент нормализует только затем, чтобы кнопка включалась тогда же, когда
   * сервер согласится код принять. Разойдись эти два алфавита — и человек
   * жал бы «Одобрить» на коде, который сервер отвергает, теряя попытку.
   *
   * Значения сверяются с apps/server/src/device-auth.ts (§11.3 контракта).
   */
  assert.equal(USER_CODE_ALPHABET, 'BCDFGHJKLMNPQRSTVWXZ');
  assert.equal(USER_CODE_ALPHABET.length, 20, 'base-20 из RFC 8628 §6.1');
  assert.equal(USER_CODE_LENGTH, 8);
});
