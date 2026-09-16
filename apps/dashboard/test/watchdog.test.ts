import { strict as assert } from 'node:assert';
import test, { mock } from 'node:test';
import {
  RELOAD_COOLDOWN_MS,
  REQUEST_TIMEOUT_MS,
  STUCK_MS,
  shouldReload,
} from '../src/lib/watchdog.ts';

const base = { now: 0, lastOkAt: 0, startedAt: 0, lastReloadAt: null as number | null };
const NOW = 1_000_000_000;

test('связь жива — перезагружать нечего', () => {
  assert.equal(
    shouldReload({ ...base, now: NOW, lastOkAt: NOW - 1000, startedAt: NOW - STUCK_MS * 2 }),
    false,
  );
});

test('молчание дольше порога на давно живущей странице — перезагружаем', () => {
  assert.equal(
    shouldReload({
      ...base,
      now: NOW,
      lastOkAt: NOW - STUCK_MS - 1,
      startedAt: NOW - STUCK_MS * 2,
    }),
    true,
  );
});

test('страница только что загрузилась — ждём, а не перезагружаемся', () => {
  // Иначе экран, поднятый при лежащем сервере, ушёл бы в цикл перезагрузок
  // ещё до первой попытки достучаться.
  assert.equal(
    shouldReload({
      ...base,
      now: NOW,
      lastOkAt: NOW - STUCK_MS - 1,
      startedAt: NOW - 10_000,
    }),
    false,
  );
});

test('перезагружались только что — второй раз не пробуем', () => {
  assert.equal(
    shouldReload({
      now: NOW,
      lastOkAt: NOW - STUCK_MS - 1,
      startedAt: NOW - STUCK_MS * 2,
      lastReloadAt: NOW - RELOAD_COOLDOWN_MS + 1000,
    }),
    false,
  );
});

test('прошлая перезагрузка была давно — пробуем снова', () => {
  assert.equal(
    shouldReload({
      now: NOW,
      lastOkAt: NOW - STUCK_MS - 1,
      startedAt: NOW - STUCK_MS * 2,
      lastReloadAt: NOW - RELOAD_COOLDOWN_MS - 1,
    }),
    true,
  );
});

test('повисший запрос становится ошибкой, а не ждёт вечно', async () => {
  // Ровно та поломка, из-за которой телевизор писал «подключение к телеметрии»
  // сутками: fetch, который не отвечает и не падает.
  (globalThis as unknown as { window: unknown }).window = { location: { search: '' } };
  const { fetchState } = await import('../src/api.ts');

  let aborted = false;
  mock.method(globalThis, 'fetch', (_url: string, init: { signal: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('AbortError'));
      });
    });
  });

  const started = Date.now();
  await assert.rejects(fetchState());
  assert.equal(aborted, true, 'запрос должен быть прерван по сроку');
  assert.ok(
    Date.now() - started >= REQUEST_TIMEOUT_MS - 500,
    'прерывать раньше срока тоже нельзя',
  );
  mock.restoreAll();
});
