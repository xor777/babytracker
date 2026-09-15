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
  dailyStats,
  getState,
  insertEvent,
  queryEventsWithUtterance,
  softDeleteEvent,
  updateEvent,
} from './events.ts';
import { EVENT_TYPES, VALUE_UNITS } from './taxonomy.ts';
import {
  UTTERANCES_LIMIT_DEFAULT,
  UTTERANCES_LIMIT_MAX,
  listUtterances,
  reparseUtterance,
  toUtteranceDto,
} from './utterances.ts';
import {
  getChangeSet,
  listChangeSets,
  listRevisions,
  newChangeSetId,
  revertChangeSet,
  type JournalContext,
} from './journal.ts';
import {
  OPAQUE_ID_HINT,
  ROW_ID_HINT,
  parseOpaqueId,
  parseRowId,
} from './http-params.ts';

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
  type: z.enum(EVENT_TYPES as unknown as [string, ...string[]]).optional(),
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
const eventTypeEnum = z.enum(EVENT_TYPES as unknown as [string, ...string[]]);
const valueUnitEnum = z.enum(VALUE_UNITS as unknown as [string, ...string[]]);

const createEventSchema = z.object({
  child_id: z.string().min(1).max(64).optional(),
  type: eventTypeEnum,
  subtype: z.string().max(200).nullish(),
  started_at: isoish.optional(),
  ended_at: isoish.nullish(),
  value_num: z.number().finite().nullish(),
  value_unit: valueUnitEnum.nullish(),
  note: z.string().max(4000).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
});

/** §10.4: правка руками из админ-дашборда. Все поля необязательны. */
const patchEventSchema = z
  .object({
    type: eventTypeEnum.optional(),
    subtype: z.string().max(200).nullish(),
    started_at: isoish.optional(),
    ended_at: isoish.nullish(),
    value_num: z.number().finite().nullish(),
    value_unit: valueUnitEnum.nullish(),
    note: z.string().max(4000).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'нечего менять: тело пустое' });

const statsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(90).optional(),
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
    // §10.4: рядом с каждым событием — исходная фраза, чтобы было видно,
    // как речь превратилась в запись, и можно было поймать ошибку разбора.
    return {
      events: queryEventsWithUtterance(db, {
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
  /**
   * Переразбор фразы: кнопка «разобрать заново» в админке.
   *
   * Человек видит в ленте, что фраза разобрана неверно или неполно, и чинит
   * это одним нажатием — без ssh и без повторения вслух. Полезнее любого
   * словаря: там, где автоматика ошиблась, решает тот, кто видит ошибку.
   *
   * Фраза уходит в очередь независимо от политики. Дубли не появятся: модель
   * получает в промпте события, уже созданные по этой фразе, и тем же
   * механизмом, что и с матчером, дополняет их, а не создаёт заново.
   */
  app.post(
    '/api/utterances/:id/reparse',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = parseRowId(request.params.id);
      if (id === null) return badRequest(reply, ROW_ID_HINT);

      const row = reparseUtterance(db, id);
      if (!row) return reply.code(404).send({ error: 'not_found', id });

      const dto = toUtteranceDto(row);
      defer(ctx, () => {
        sse.broadcastUtterance(dto);
        ctx.notifyWorker();
      });

      ctx.log.info(
        { utteranceId: id, reparseCount: dto.reparse_count },
        'фраза отправлена на повторный разбор',
      );
      reply.code(202);
      return { utterance: dto };
    },
  );

  /* -------------------------------------------------------------- */
  /** §10.4: правка руками. Через журнал — ручные правки так же обратимы. */
  app.patch(
    '/api/events/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      // Строгий разбор: «1abc» и «1.5» обязаны быть отказом, а не правкой события 1.
      const id = parseRowId(request.params.id);
      if (id === null) return badRequest(reply, ROW_ID_HINT);

      const parsed = patchEventSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error.issues);

      const journal: JournalContext = {
        changeSetId: newChangeSetId(),
        actor: 'manual',
        summary: `Ручная правка события ${id} через дашборд`,
      };

      let updated;
      try {
        updated = updateEvent(db, id, parsed.data, journal);
      } catch (err) {
        return badRequest(reply, err instanceof Error ? err.message : String(err));
      }
      if (!updated) return reply.code(404).send({ error: 'not_found', id });

      defer(ctx, () => {
        sse.broadcastEvent('updated', updated);
        sse.broadcastState(getState(db, cfg));
      });

      return { event: updated, changeSetId: journal.changeSetId };
    },
  );

  /** §10.4: удаление мягкое и обратимое. Физического удаления не существует (§9.1). */
  app.delete(
    '/api/events/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = parseRowId(request.params.id);
      if (id === null) return badRequest(reply, ROW_ID_HINT);

      const journal: JournalContext = {
        changeSetId: newChangeSetId(),
        actor: 'manual',
        summary: `Удаление события ${id} через дашборд`,
      };

      const deleted = softDeleteEvent(db, id, journal);
      if (!deleted) return reply.code(404).send({ error: 'not_found', id });

      defer(ctx, () => {
        sse.broadcastEvent('deleted', deleted);
        sse.broadcastState(getState(db, cfg));
      });

      return { event: deleted, changeSetId: journal.changeSetId, revertWith: journal.changeSetId };
    },
  );

  /** §10.4: суточная аналитика с нормами для текущего возраста (§10.1). */
  app.get('/api/stats/daily', async (request: FastifyRequest, reply) => {
    const parsed = statsQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    return { days: dailyStats(db, cfg, parsed.data.days ?? DAILY_DAYS_DEFAULT) };
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
      const id = parseOpaqueId(request.params.id);
      if (id === null) return badRequest(reply, OPAQUE_ID_HINT);

      // Раньше здесь сканировались последние 200 наборов, и старый набор
      // возвращал 404, хотя лежал в базе. Ищем сразу по ключу.
      const row = getChangeSet(db, id);
      if (!row) return reply.code(404).send({ error: 'not_found', id });

      const revisions = listRevisions(db, id);
      return {
        changeSet: {
          ...row,
          revisions: revisions.length,
          events: [...new Set(revisions.map((r) => r.event_id))].sort((a, b) => a - b),
        },
        revisions,
      };
    },
  );

  /** §9.6: откат из веба — той же дорогой, что и у модели. */
  app.post(
    '/api/change-sets/:id/revert',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = parseOpaqueId(request.params.id);
      if (id === null) return badRequest(reply, OPAQUE_ID_HINT);

      const result = revertChangeSet(db, id, 'api');
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
