/**
 * Лента суток: правила, которые видно только на телевизоре с трёх метров,
 * а сломать можно одной строчкой в компоненте.
 *
 * Запуск: pnpm --filter @babytracker/dashboard test
 * (встроенный раннер node, типы снимаются на лету — новых зависимостей нет).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampCenter,
  FEED_TOP,
  marksInWindow,
  RIBBON,
  TRACK_BOTTOM,
} from '../src/lib/ribbon.ts';

const { W, SHELF_Y, FEED_W, FEED_H, DIAPER_R, DIAPER_CY, LABEL_TOP, TRACK_H } = RIBBON;

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-16T20:41:00+03:00');
const FROM = NOW - 24 * HOUR;

test('метка у правого края суток целиком остаётся на ленте', () => {
  // Самая свежая запись приходится ровно на «сейчас» — правый край.
  const cx = clampCenter(W, FEED_W / 2);
  assert.ok(cx + FEED_W / 2 <= W, 'столбик еды вылез за правый край');
  assert.ok(cx - FEED_W / 2 >= 0);
});

test('метка у левого края суток целиком остаётся на ленте', () => {
  const cx = clampCenter(0, DIAPER_R + 1);
  assert.ok(cx - DIAPER_R >= 0, 'кружок подгузника обрезан слева');
  assert.ok(cx + DIAPER_R <= W);
});

test('метка посреди суток не сдвигается', () => {
  assert.equal(clampCenter(400, FEED_W / 2), 400);
});

test('еда и подгузники не пересекаются по вертикали', () => {
  // Их различают не цветом, а тем, по какую сторону полки они стоят.
  const feedBottom = FEED_TOP + FEED_H;
  const diaperTop = DIAPER_CY - DIAPER_R;
  assert.equal(feedBottom, SHELF_Y, 'столбик еды должен стоять на полке');
  assert.ok(diaperTop >= SHELF_Y, 'кружок подгузника залез выше полки');
});

test('метки не наезжают на подписи часов и на дорожку сна', () => {
  assert.ok(DIAPER_CY + DIAPER_R <= LABEL_TOP, 'кружок наехал на подписи часов');
  assert.ok(FEED_TOP >= TRACK_BOTTOM, 'столбик еды наехал на дорожку сна');
});

test('сон остаётся самым крупным на ленте', () => {
  // Заказчик просил: кормления и подгузники не должны спорить со сном.
  assert.ok(TRACK_H > FEED_H * 2, 'дорожка сна перестала доминировать');
  assert.ok(TRACK_H > DIAPER_R * 2 * 2);
});

test('метки шире прежних семи пикселей — иначе их не видно с дивана', () => {
  assert.ok(FEED_W >= 12, 'столбик еды снова стал волосяным');
  assert.ok(DIAPER_R * 2 >= 12, 'кружок подгузника снова стал точкой');
});

test('в окно попадают события от начала суток до «сейчас» включительно', () => {
  const marks = marksInWindow([FROM - 1, FROM, NOW - HOUR, NOW, NOW + 1], FROM, NOW);
  assert.deepEqual(marks, [FROM, NOW - HOUR, NOW]);
});

test('метки отдаются по возрастанию времени', () => {
  const marks = marksInWindow([NOW - HOUR, NOW - 5 * HOUR, NOW - 3 * HOUR], FROM, NOW);
  assert.deepEqual(marks, [NOW - 5 * HOUR, NOW - 3 * HOUR, NOW - HOUR]);
});

test('сутки без единой записи дают пустую полку, а не сбой', () => {
  assert.deepEqual(marksInWindow([], FROM, NOW), []);
});
