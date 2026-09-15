/**
 * Сборка Fastify-приложения. Вынесено из index.ts, чтобы тесты могли поднять
 * приложение без прослушивания порта (`app.inject`).
 */

import fs from 'node:fs';
import path from 'node:path';

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { SetHeadersResponse } from '@fastify/static';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { AppContext, WorkerStatus } from './context.ts';
import { SseHub } from './sse.ts';
import { registerApiRoutes } from './api.ts';
import { registerAliceRoutes, neutralReply } from './alice.ts';
import { registerAuthGuard } from './auth-guard.ts';
import { registerAuthRoutes } from './auth-routes.ts';
import { RateLimiter } from './device-auth.ts';

/**
 * Секрет вебхука — часть пути. В логи он попасть НЕ ДОЛЖЕН, поэтому маскируем
 * URL в сериализаторе запроса, а не надеемся на аккуратность вызывающих.
 */
export function maskUrl(url: string): string {
  return url.replace(/^\/alice\/[^/?#]+/, '/alice/***');
}

/* ------------------------------------------------------------------ */
/* Заголовки статики админки: она же PWA                               */
/* ------------------------------------------------------------------ */

/** Год — обычный срок для файла, имя которого содержит хеш содержимого. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/**
 * `no-cache` НЕ значит «не кешировать»: браузер положит файл в кеш, но каждый
 * раз переспросит, не изменился ли он. Ровно то, что нужно оболочке приложения,
 * манифесту и service worker'у.
 */
const REVALIDATE_CACHE = 'no-cache';

/**
 * Заголовки для файлов админки (она же PWA под /dash).
 *
 * Оба правила ниже — про отказы, которые происходят МОЛЧА, без единой ошибки
 * в консоли, и потому отлаживаются мучительно:
 *
 *  - манифест с чужим Content-Type браузер просто игнорирует, и предложение
 *    «установить на домашний экран» не появляется;
 *  - service worker, отданный с длинным сроком кеширования, застревает в
 *    браузере вместе со всей старой версией приложения: обновления перестают
 *    доходить, а пользователь видит работающее, но устаревшее приложение.
 *
 * Что кешировать долго, определяем не списком имён, а расположением: Vite
 * кладёт в `assets/` файлы с хешем содержимого в имени, их можно кешировать
 * навсегда. Всё остальное на верхнем уровне сборки — оболочка, манифест,
 * воркер, иконки — имя не меняет, значит должно перепроверяться.
 */
export function setDashHeaders(res: SetHeadersResponse, filePath: string): void {
  const relative = filePath.replace(/\\/g, '/');
  const name = relative.slice(relative.lastIndexOf('/') + 1).toLowerCase();
  const hashedAsset = /\/assets\//.test(relative);

  res.setHeader('Cache-Control', hashedAsset ? IMMUTABLE_CACHE : REVALIDATE_CACHE);

  if (isServiceWorker(name)) {
    // Воркер лежит в /dash/ и по умолчанию управляет только этим путём — ровно
    // та область, которая нужна. Заголовок фиксирует её явно и НЕ расширяет:
    // дашборду телевизора на «/» воркер админки управлять не должен.
    // Content-Type воркеру ставит send: «application/javascript» — валидный
    // для регистрации тип, переопределять его отсюда всё равно не выйдет.
    res.setHeader('Service-Worker-Allowed', '/dash/');
  }
}

/** Файл воркера у Vite PWA называется sw.js или service-worker.js. */
function isServiceWorker(name: string): boolean {
  return name === 'sw.js' || name === 'service-worker.js';
}

export interface CreateAppOptions {
  cfg: Config;
  db: Db;
  /** Статус воркера для /healthz; по умолчанию — «воркера нет». */
  workerStatus?: () => WorkerStatus;
  logger?: boolean | Record<string, unknown>;
  /** Отключить раздачу статики (тесты). */
  serveStatic?: boolean;
  /** Подменяемые часы: тестам нужно проверять истечение кодов и сессий. */
  now?: () => number;
}

export interface CreatedApp {
  app: FastifyInstance;
  ctx: AppContext;
  sse: SseHub;
  /** Ограничитель частоты: тестам нужно его сбрасывать между проверками. */
  limiter: RateLimiter;
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
  /* ДВЕРЬ. Ставится первой и до всего остального — это не стилистика:  */
  /* хук `onRequest` на корневом инстансе видит и статику, и SPA-       */
  /* fallback, и обработчик 404, то есть все пути, которыми ответ может */
  /* уйти мимо маршрута. Любая регистрация выше этой строки означала бы */
  /* дыру ровно того размера, что она раздаёт.                          */
  /* ---------------------------------------------------------------- */
  const limiter = new RateLimiter(options.now);
  registerAuthGuard(app, ctx, options.now ? { now: options.now } : {});

  /* ---------------------------------------------------------------- */
  /* CORS: нужен в dev-режиме, когда Vite крутится на 5173 отдельно.    */
  /* ---------------------------------------------------------------- */
  const allowedOrigins = cfg.dashboardOrigin;
  /*
   * Куку сессии браузер отправит на чужой origin только если сервер явно
   * разрешил учётные данные. Разрешаем — но исключительно поимённому списку:
   * `credentials: true` вместе с «отражать любой Origin» открыл бы чтение
   * истории ребёнка любому сайту, который пользователь откроет в соседней
   * вкладке. Список из одной звёздочки в этом смысле ничем не лучше пустого.
   */
  const namedOrigins = allowedOrigins.length > 0 && !allowedOrigins.includes('*');
  void app.register(cors, {
    origin: namedOrigins
      ? (origin, cb) => {
          // Запросы без Origin (curl, TV WebView с того же origin) пропускаем.
          if (!origin || allowedOrigins.includes(origin)) cb(null, true);
          else cb(null, false);
        }
      : true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: namedOrigins,
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
  /* Админка по /dash. Собрана с base '/dash/' и хэш-роутингом          */
  /* (/dash/#/history), поэтому SPA-fallback ей не нужен: достаточно    */
  /* index.html на /dash и /dash/ плюс ассеты по /dash/assets/*.        */
  /* ---------------------------------------------------------------- */
  const adminIndexHtml = path.join(cfg.adminDist, 'index.html');
  const adminAvailable =
    (options.serveStatic ?? true) && fs.existsSync(cfg.adminDist) && fs.existsSync(adminIndexHtml);

  if (adminAvailable) {
    void app.register(async (scope) => {
      /*
       * Content-Type манифеста приходится чинить здесь, а не в setHeaders:
       * `send` выставляет тип ПОСЛЕ setHeaders и затирает всё, что там задано
       * (проверено фактом — запрошенный charset до ответа не доезжал).
       * onSend же срабатывает последним, поэтому только он даёт гарантию.
       *
       * Гарантия нужна именно здесь: манифест с чужим типом браузер молча
       * игнорирует, установка на домашний экран просто не предлагается,
       * и ни одной ошибки в консоли при этом нет.
       */
      scope.addHook('onSend', async (request, reply, payload) => {
        const pathname = request.url.split('?')[0] ?? '';
        // Только для успешной отдачи файла: 404 — это JSON с ошибкой,
        // и выдавать его за манифест было бы враньём в заголовке.
        if (reply.statusCode === 200 && pathname.endsWith('.webmanifest')) {
          void reply.header('Content-Type', 'application/manifest+json; charset=utf-8');
        }
        return payload;
      });

      await scope.register(fastifyStatic, {
        root: cfg.adminDist,
        prefix: '/dash/',
        index: ['index.html'],
        wildcard: true,
        // sendFile уже добавлен первой регистрацией — второй раз декорировать нельзя
        decorateReply: false,
        // Cache-Control ставим сами: у PWA это часть работоспособности,
        // а не оптимизация — см. setDashHeaders
        cacheControl: false,
        setHeaders: setDashHeaders,
      });
    });

    // /dash без слэша: отдаём оболочку напрямую, без лишнего редиректа.
    // Кеширование задаём руками — сюда setHeaders статики не доходит,
    // а закешированная оболочка означает застрявшую версию приложения.
    app.get('/dash', (_request, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', REVALIDATE_CACHE)
        .send(fs.createReadStream(adminIndexHtml)),
    );

    app.log.info({ dist: cfg.adminDist }, 'статика админки: раздаём по /dash');
  } else if (options.serveStatic ?? true) {
    app.log.warn(
      { dist: cfg.adminDist },
      'статика админки не найдена — /dash отдавать нечем, остальное работает как обычно. ' +
        'Соберите админку (pnpm build) или укажите ADMIN_DIST.',
    );
  }

  /* ---------------------------------------------------------------- */
  registerAuthRoutes(app, ctx, options.now ? { limiter, now: options.now } : { limiter });
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
      !pathname.startsWith('/healthz') &&
      // у админки хэш-роутинг: неизвестный /dash/... — это честный 404,
      // а не повод показать дашборд телевизора
      !pathname.startsWith('/dash');

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
    limiter,
    setWorkerStatus: (fn) => {
      workerStatusFn = fn;
    },
    setWorkerNotify: (fn) => {
      workerNotifyFn = fn;
    },
  };
}
