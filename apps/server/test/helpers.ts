/** Общая обвязка для тестов: конфиг и БД в памяти. */

import { loadConfig, type Config } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import type { AppContext, WorkerStatus } from '../src/context.ts';
import type { FastifyInstance, InjectOptions } from 'fastify';
import {
  SESSION_COOKIE,
  issueSession,
  type RateLimiter,
  type SessionRow,
} from '../src/device-auth.ts';

export const TEST_SECRET = '0123456789abcdef0123456789abcdef';

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig(
    {
      ALICE_WEBHOOK_SECRET: TEST_SECRET,
      TZ: 'Europe/Moscow',
      CHILD_NAME: 'Андрей',
      CHILD_BIRTHDATE: '2026-03-01',
      WORKER_ENABLED: 'false',
      DB_PATH: ':memory:',
      ...env,
    } as NodeJS.ProcessEnv,
    { cwd: process.cwd() },
  );
}

export function testDb(): Db {
  return openDb({ path: ':memory:' });
}

/**
 * Тип `app.inject` в той единственной форме, в какой им пользуются тесты:
 * объект настроек на входе, ответ промисом на выходе. Берём его у самой
 * Fastify, чтобы не тянуть в зависимости её внутреннюю light-my-request.
 */
type Inject = (options: InjectOptions) => ReturnType<FastifyInstance['inject']>;

/**
 * Выдать приложению сессию и заставить `app.inject` ходить с ней.
 *
 * Для тестов, которые собирают приложение сами (им нужна статика на диске).
 * Возвращает заголовок Cookie — на случай, если запрос собирают руками.
 */
export function authorize(app: FastifyInstance, db: Db): string {
  const issued = issueSession(db, { kind: 'browser', label: 'Тестовое устройство' });
  const cookie = `${SESSION_COOKIE}=${issued.token}`;
  const real = app.inject.bind(app) as Inject;
  (app as unknown as { inject: unknown }).inject = (o: InjectOptions) =>
    real({ ...o, headers: { cookie, ...(o.headers ?? {}) } });
  return cookie;
}

export interface TestApp {
  /**
   * Приложение с ПОДКЛЮЧЁННЫМ устройством: `app.inject` сам подставляет куку
   * сессии (см. ниже, почему). Запрос без сессии — `anon`.
   */
  app: FastifyInstance;
  ctx: AppContext;
  cfg: Config;
  db: Db;
  limiter: RateLimiter;
  /** Сессия, от имени которой ходит `app.inject`. */
  session: SessionRow;
  /** Готовый заголовок Cookie — когда запрос собирают руками. */
  cookie: string;
  /** Запрос БЕЗ сессии: этим проверяется, что дверь закрыта. */
  anon: Inject;
  /** Подключить статус настоящего воркера к /healthz (по умолчанию там заглушка). */
  setWorkerStatus: (fn: () => WorkerStatus) => void;
  close: () => Promise<void>;
}

export interface MakeTestAppOptions {
  /** Не выпускать сессию вовсе: приложение целиком за дверью. */
  authenticated?: boolean;
  /** Раздавать статику (нужно тестам SPA-fallback и двери). */
  serveStatic?: boolean;
  /** Подменяемые часы: проверка истечения кодов и сессий. */
  now?: () => number;
}

/**
 * Поднять приложение с уже подключённым устройством.
 *
 * `app.inject` намеренно подменён обёрткой, которая добавляет куку сессии.
 * Причина: после переезда авторизации из Caddy в приложение (§11) закрытым
 * оказалось ВСЁ, и четыре с половиной сотни тестов API стали бы тестами
 * редиректа на страницу сопряжения. Подмена возвращает их к тому, что они
 * и проверяли, — к поведению API у вошедшего пользователя, то есть к
 * единственному состоянию, в котором API вообще работает в бою.
 *
 * Что дверь закрыта, проверяется отдельно и явно — через `anon`
 * (test/device-auth-guard.test.ts), а не молчаливым отсутствием куки.
 */
export async function makeTestApp(
  env: Record<string, string> = {},
  options: MakeTestAppOptions = {},
): Promise<TestApp> {
  const cfg = testConfig(env);
  const db = testDb();
  const created = createApp({
    cfg,
    db,
    logger: false,
    serveStatic: options.serveStatic ?? false,
    ...(options.now ? { now: options.now } : {}),
  });
  const { app, ctx, sse, limiter, setWorkerStatus } = created;
  await app.ready();

  const anon = app.inject.bind(app) as Inject;

  const issued = issueSession(db, {
    kind: 'browser',
    label: 'Тестовое устройство',
    now: options.now ? options.now() : Date.now(),
  });
  const cookie = `${SESSION_COOKIE}=${issued.token}`;

  if (options.authenticated !== false) {
    // Своя кука в запросе побеждает: тест, проверяющий чужой или битый
    // секрет, должен иметь возможность его подставить.
    const patched: Inject = (o: InjectOptions) =>
      anon({ ...o, headers: { cookie, ...(o.headers ?? {}) } });
    (app as unknown as { inject: unknown }).inject = patched;
  }

  return {
    app,
    ctx,
    cfg,
    db,
    limiter,
    session: issued.session,
    cookie,
    anon,
    setWorkerStatus,
    close: async () => {
      sse.close();
      await app.close();
      db.close();
    },
  };
}

/** Тело запроса Алисы в формате §3.1. */
export function aliceBody(
  command: string,
  extra: {
    isNew?: boolean;
    skillId?: string;
    userId?: string;
    nlu?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    meta: { locale: 'ru-RU', timezone: 'Europe/Moscow', interfaces: {} },
    session: {
      message_id: 0,
      session_id: 'test-session',
      skill_id: extra.skillId ?? 'test-skill',
      user_id: extra.userId ?? 'test-user',
      new: extra.isNew ?? false,
    },
    request: {
      type: 'SimpleUtterance',
      command,
      original_utterance: command,
      nlu: extra.nlu ?? { tokens: [], entities: [], intents: {} },
    },
    version: '1.0',
  };
}
