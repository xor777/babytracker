/**
 * REST + SSE эндпоинты (§3 контракта).
 * Валидация входа — zod; ошибки отдаём честным JSON, а не HTML.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import { isDbAlive } from './db.ts';
import {
  DAILY_DAYS_DEFAULT,
  EVENTS_LIMIT_DEFAULT,
  EVENTS_LIMIT_MAX,
  clampLimit,
  dailySleep,
  getState,
  insertEvent,
  queryEvents,
} from './events.ts';
import {
  UTTERANCES_LIMIT_DEFAULT,
  UTTERANCES_LIMIT_MAX,
  listUtterances,
  toUtteranceDto,
} from './utterances.ts';
import {
  listChangeSets,
  listRevisions,
  newChangeSetId,
  revertChangeSet,
  type JournalContext,
} from './journal.ts';

const isoish = z
  .string()
  .min(4)
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'не разбирается как дата' });

const boolish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => ['true', '1', 'yes'].includes(v));

const eventsQuerySchema = z.object({
  from: isoish.optional(),
  to: isoish.optional(),
  type: z.enum(['sleep', 'feed', 'diaper', 'measure', 'meds', 'note']).optional(),
  limit: z.coerce.number().int().positive().max(EVENTS_LIMIT_MAX).optional(),
  include_deleted: boolish.optional(),
});

const changeSetsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const dailyQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(90).optional(),
});

const utterancesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(UTTERANCES_LIMIT_MAX).optional(),
});

/** §3.7: тело — Event без id/created_at/updated_at; source принудительно 'manual'. */
const createEventSchema = z.object({
  child_id: z.string().min(1).max(64).optional(),
  type: z.enum(['sleep', 'feed', 'diaper', 'measure', 'meds', 'note']),
  subtype: z.string().max(200).nullish(),
  started_at: isoish.optional(),
  ended_at: isoish.nullish(),
  value_num: z.number().finite().nullish(),
  value_unit: z.enum(['ml', 'g', 'kg', 'c', 'cm', 'min', 'mg']).nullish(),
  note: z.string().max(4000).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
});

function badRequest(reply: FastifyReply, issues: unknown): FastifyReply {
  return reply.code(400).send({ error: 'bad_request', issues });
}

/**
 * Отложенная рассылка по SSE: ответ клиенту не ждёт её.
 * Обязательно в try/catch — при остановке сервера БД может закрыться раньше,
 * чем выполнится отложенный колбэк, и ронять процесс из-за этого нельзя.
 */
function defer(ctx: AppContext, fn: () => void): void {
  setImmediate(() => {
    try {
      fn();
    } catch (err) {
      ctx.log.debug({ err }, 'sse: отложенная рассылка не удалась');
    }
  });
}

export function registerApiRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { cfg, db, sse } = ctx;

  /* -------------------------------------------------------------- */
  app.get('/healthz', async (_request, reply) => {
    const worker = ctx.workerStatus();
    const dbOk = isDbAlive(db);
    reply.code(dbOk ? 200 : 503);
    return {
      ok: dbOk,
      db: dbOk,
      worker: {
        alive: worker.alive,
        lastRunAt: worker.lastRunAt,
        queueDepth: worker.queueDepth,
        // сверх контракта, но без этого невозможно понять, почему всё skipped
        enabled: worker.enabled,
        claudeAvailable: worker.claudeAvailable,
        claudeProblem: worker.claudeProblem,
        // лимит подписки — отдельное состояние: лечится ожиданием, а не починкой
        rateLimited: worker.rateLimited,
        rateLimitedUntil: worker.rateLimitedUntil,
        rateLimitReason: worker.rateLimitReason,
      },
    };
  });

  /* -------------------------------------------------------------- */
  app.get('/api/state', async () => getState(db, cfg));

  /* -------------------------------------------------------------- */
  app.get('/api/events', async (request: FastifyRequest, reply) => {
    const parsed = eventsQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const { from, to, type, limit, include_deleted: includeDeleted } = parsed.data;
    return {
      events: queryEvents(db, {
        from: from ?? null,
        to: to ?? null,
        type: type ?? null,
        limit: clampLimit(limit, EVENTS_LIMIT_DEFAULT, EVENTS_LIMIT_MAX),
        includeDeleted: includeDeleted ?? false,
      }),
    };
  });

  /* -------------------------------------------------------------- */
  app.post('/api/events', async (request: FastifyRequest, reply) => {
    const parsed = createEventSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    try {
      const journal: JournalContext = {
        changeSetId: newChangeSetId(),
        actor: 'api',
        summary: `Ручная запись через API: ${parsed.data.type}`,
      };
      const { event, closedPrevious } = insertEvent(
        db,
        {
          ...parsed.data,
          source: 'manual', // §3.7: перебиваем что бы ни прислали
        },
        'close-previous',
        journal,
      );
      defer(ctx, () => {
        if (closedPrevious) sse.broadcastEvent('updated', closedPrevious);
        sse.broadcastEvent('created', event);
        sse.broadcastState(getState(db, cfg));
      });
      reply.code(201);
      return { event, closedPrevious };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: 'conflict', message });
    }
  });

  /* -------------------------------------------------------------- */
  app.get('/api/sleep/daily', async (request: FastifyRequest, reply) => {
    const parsed = dailyQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    return { days: dailySleep(db, cfg, parsed.data.days ?? DAILY_DAYS_DEFAULT) };
  });

  /* -------------------------------------------------------------- */
  app.get('/api/utterances', async (request: FastifyRequest, reply) => {
    const parsed = utterancesQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const limit = parsed.data.limit ?? UTTERANCES_LIMIT_DEFAULT;
    return { utterances: listUtterances(db, limit).map(toUtteranceDto) };
  });

  /* -------------------------------------------------------------- */
  /** §9.6: история изменений. */
  app.get('/api/change-sets', async (request: FastifyRequest, reply) => {
    const parsed = changeSetsQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    return { changeSets: listChangeSets(db, parsed.data.limit ?? 20) };
  });

  /** §9.6: содержимое одного набора — что именно поменялось. */
  app.get(
    '/api/change-sets/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = request.params.id;
      const [changeSet] = listChangeSets(db, 200).filter((cs) => cs.id === id);
      if (!changeSet) return reply.code(404).send({ error: 'not_found', id });
      return { changeSet, revisions: listRevisions(db, id) };
    },
  );

  /** §9.6: откат из веба — той же дорогой, что и у модели. */
  app.post(
    '/api/change-sets/:id/revert',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const result = revertChangeSet(db, request.params.id, 'api');
      if (!result.ok) return reply.code(404).send({ error: 'revert_failed', message: result.error });

      defer(ctx, () => {
        for (const event of result.restored) sse.broadcastEvent('updated', event);
        sse.broadcastState(getState(db, cfg));
      });

      return {
        reverted: result.changeSetId,
        revertChangeSetId: result.revertChangeSetId,
        restored: result.restored,
        alreadyReverted: result.alreadyReverted,
      };
    },
  );

  /* -------------------------------------------------------------- */
  /** §3.6 SSE. Сразу после подключения шлём снимок состояния — дашборд не ждёт. */
  app.get('/api/stream', async (_request, reply) => {
    const id = sse.attach(reply);
    try {
      sse.sendTo(id, 'state', getState(db, cfg));
    } catch (err) {
      ctx.log.error({ err }, 'sse: не удалось отправить первичное состояние');
    }
  });

  /* -------------------------------------------------------------- */
  /** Честный 404 для несуществующих /api/*: SPA-fallback сюда не лезет. */
  app.get('/api/*', async (request, reply) =>
    reply.code(404).send({ error: 'not_found', path: request.url }),
  );

}
