/** Общая обвязка для тестов: конфиг и БД в памяти. */

import { loadConfig, type Config } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import type { AppContext } from '../src/context.ts';
import type { FastifyInstance } from 'fastify';

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

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  cfg: Config;
  db: Db;
  close: () => Promise<void>;
}

export async function makeTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const cfg = testConfig(env);
  const db = testDb();
  const { app, ctx, sse } = createApp({ cfg, db, logger: false, serveStatic: false });
  await app.ready();
  return {
    app,
    ctx,
    cfg,
    db,
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
