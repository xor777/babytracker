/**
 * Сборка Fastify-приложения. Вынесено из index.ts, чтобы тесты могли поднять
 * приложение без прослушивания порта (`app.inject`).
 */

import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { AppContext, WorkerStatus } from './context.ts';
import { SseHub } from './sse.ts';
import { registerApiRoutes } from './api.ts';
import { registerAliceRoutes, neutralReply } from './alice.ts';

/**
 * Секрет вебхука — часть пути. В логи он попасть НЕ ДОЛЖЕН, поэтому маскируем
 * URL в сериализаторе запроса, а не надеемся на аккуратность вызывающих.
 */
export function maskUrl(url: string): string {
  return url.replace(/^\/alice\/[^/?#]+/, '/alice/***');
}

export interface CreateAppOptions {
  cfg: Config;
  db: Db;
  /** Статус воркера для /healthz; по умолчанию — «воркера нет». */
  workerStatus?: () => WorkerStatus;
  logger?: boolean | Record<string, unknown>;
  /** Отключить раздачу статики (тесты). */
  serveStatic?: boolean;
}

export interface CreatedApp {
  app: FastifyInstance;
  ctx: AppContext;
  sse: SseHub;
  setWorkerStatus: (fn: () => WorkerStatus) => void;
  setWorkerNotify: (fn: () => void) => void;
}

const IDLE_WORKER: WorkerStatus = {
  enabled: false,
  alive: false,
  lastRunAt: null,
  queueDepth: 0,
  claudeAvailable: false,
  claudeProblem: null,
  rateLimited: false,
  rateLimitedUntil: null,
  rateLimitReason: null,
};

export function createApp(options: CreateAppOptions): CreatedApp {
  const { cfg, db } = options;

  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: {
        req(request: { method: string; url: string; ip?: string; hostname?: string }) {
          return {
            method: request.method,
            url: maskUrl(request.url),
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        remove: true,
      },
    },
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  const sse = new SseHub({
    onError: (err) => app.log.debug({ err }, 'sse: клиент отвалился'),
  });

  let workerStatusFn: () => WorkerStatus = options.workerStatus ?? (() => IDLE_WORKER);
  let workerNotifyFn: () => void = () => {};

  const ctx: AppContext = {
    cfg,
    db,
    sse,
    log: app.log,
    workerStatus: () => workerStatusFn(),
    notifyWorker: () => workerNotifyFn(),
  };

  /* ---------------------------------------------------------------- */
  /* CORS: нужен в dev-режиме, когда Vite крутится на 5173 отдельно.    */
  /* ---------------------------------------------------------------- */
  const allowedOrigins = cfg.dashboardOrigin;
  void app.register(cors, {
    origin:
      allowedOrigins.length === 0 || allowedOrigins.includes('*')
        ? true
        : (origin, cb) => {
            // Запросы без Origin (curl, TV WebView с того же origin) пропускаем.
            if (!origin || allowedOrigins.includes(origin)) cb(null, true);
            else cb(null, false);
          },
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  });

  /* ---------------------------------------------------------------- */
  /* Статика собранного дашборда.                                      */
  /* Каталога нет (обычный dev) — это НЕ повод падать: API важнее.      */
  /* ---------------------------------------------------------------- */
  const indexHtml = path.join(cfg.dashboardDist, 'index.html');
  const staticAvailable =
    (options.serveStatic ?? true) && fs.existsSync(cfg.dashboardDist) && fs.existsSync(indexHtml);

  if (staticAvailable) {
    void app.register(fastifyStatic, {
      root: cfg.dashboardDist,
      prefix: '/',
      index: ['index.html'],
      // wildcard:true — иначе список файлов фиксируется на момент старта и
      // пересборка дашборда с новыми хешами в именах требует рестарта сервера.
      // Не найденный файл уходит в notFoundHandler, то есть в SPA-fallback.
      wildcard: true,
      cacheControl: true,
      maxAge: '5m',
    });
    app.log.info({ dist: cfg.dashboardDist }, 'статика дашборда: раздаём');
  } else if (options.serveStatic ?? true) {
    app.log.warn(
      { dist: cfg.dashboardDist },
      'статика дашборда не найдена — отдаём только API. Соберите дашборд (pnpm build) ' +
        'или укажите DASHBOARD_DIST. Это нормально, если дашборд запущен на Vite отдельно.',
    );
  }

  /* ---------------------------------------------------------------- */
  registerApiRoutes(app, ctx);
  registerAliceRoutes(app, ctx);

  /* ---------------------------------------------------------------- */
  /* SPA-fallback: неизвестный GET вне /api, /alice, /healthz -> index. */
  /* /api/* сюда не доходит: для него в api.ts есть свой честный 404.   */
  /* ---------------------------------------------------------------- */
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '';
    const isAppRoute =
      !pathname.startsWith('/api') &&
      !pathname.startsWith('/alice') &&
      !pathname.startsWith('/healthz');

    if (request.method === 'GET' && staticAvailable && isAppRoute) {
      return reply.type('text/html; charset=utf-8').send(fs.createReadStream(indexHtml));
    }

    return reply.code(404).send({ error: 'not_found', path: maskUrl(request.url) });
  });

  /* ---------------------------------------------------------------- */
  /* Ошибки: Алисе — всегда 200 с нейтральным текстом (§3.1).           */
  /* ---------------------------------------------------------------- */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const pathname = request.url.split('?')[0] ?? '';
    if (pathname.startsWith('/alice')) {
      request.log.warn({ err: error }, 'alice: ошибка обработки, отвечаем нейтрально');
      return reply.code(200).type('application/json; charset=utf-8').send(neutralReply());
    }

    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'необработанная ошибка');
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? 'Внутренняя ошибка' : error.message,
    });
  });

  return {
    app,
    ctx,
    sse,
    setWorkerStatus: (fn) => {
      workerStatusFn = fn;
    },
    setWorkerNotify: (fn) => {
      workerNotifyFn = fn;
    },
  };
}
