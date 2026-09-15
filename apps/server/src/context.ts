/** Общий контекст приложения: то, что нужно всем слоям. Явная передача вместо синглтонов. */

import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { SseHub } from './sse.ts';

export interface WorkerStatus {
  enabled: boolean;
  alive: boolean;
  lastRunAt: string | null;
  queueDepth: number;
  claudeAvailable: boolean;
  claudeProblem: string | null;
  /**
   * Лимит подписки исчерпан. Намеренно отдельно от claudeAvailable: причины
   * разные и лечатся по-разному — тут надо просто подождать.
   */
  rateLimited: boolean;
  /** Когда собираемся попробовать снова, ISO UTC. */
  rateLimitedUntil: string | null;
  rateLimitReason: string | null;
}

export interface AppContext {
  cfg: Config;
  db: Db;
  sse: SseHub;
  log: FastifyBaseLogger;
  /** Ставится после запуска воркера; до этого /healthz честно говорит alive:false. */
  workerStatus: () => WorkerStatus;
  /**
   * Сигнал «в очереди появилась фраза» (§9.4): воркер стартует немедленно,
   * а не ждёт следующего тика. До запуска воркера — no-op.
   */
  notifyWorker: () => void;
}
