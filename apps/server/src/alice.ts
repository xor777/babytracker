/**
 * Webhook Яндекс Диалогов (§3.1).
 *
 * Жёсткое требование: Алиса ждёт ответ не дольше 3 секунд, наш бюджет — 200 мс.
 * Поэтому в этом файле нет ни одного `await` на что-либо небыстрое: только
 * синхронные обращения к локальному SQLite. Рассылка по SSE уходит в setImmediate.
 *
 * Секрет вебхука не логируется никогда и ни в каком виде.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.ts';
import type { AliceRequestBody, AliceResponseBody, FastResult } from './types.ts';
import { matchFast } from './fastpath.ts';
import { endSleep, getState, startSleep } from './events.ts';
import { getUtterance, insertUtterance, toUtteranceDto } from './utterances.ts';
import { getEventById } from './db.ts';
import { newChangeSetId, type JournalContext } from './journal.ts';
import { decideQueue } from './queue-policy.ts';
import {
  formatDurationRu,
  formatDurationRuAcc,
  formatTimeLocal,
  pluralRu,
  SLEEPS,
} from './ru.ts';

const MAX_TEXT = 1024;
const PROTOCOL_VERSION = '1.0';

/** Нейтральный ответ на любую неудачу проверки: атакующий не должен различать причины. */
const NEUTRAL_TEXT = 'Извините, сейчас не могу ответить.';

/* ------------------------------------------------------------------ */
/* Безопасность                                                        */
/* ------------------------------------------------------------------ */

/**
 * Сравнение секретов за постоянное время.
 * Сравниваем SHA-256 дайджесты — тогда и разная длина не даёт утечки по времени.
 */
export function secretsEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/* ------------------------------------------------------------------ */
/* Сборка ответа                                                       */
/* ------------------------------------------------------------------ */

function clamp(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

/** TTS читает «17:32» плохо — отдаём «17 32». */
function toTts(text: string): string {
  return clamp(text.replace(/(\d{1,2}):(\d{2})/g, '$1 $2').replace(/«|»/g, ''));
}

export function aliceReply(text: string, endSession = false): AliceResponseBody {
  const safe = clamp(text);
  return {
    response: { text: safe, tts: toTts(safe), end_session: endSession },
    version: PROTOCOL_VERSION,
  };
}

export function neutralReply(): AliceResponseBody {
  return aliceReply(NEUTRAL_TEXT, true);
}

/* ------------------------------------------------------------------ */
/* Тексты                                                              */
/* ------------------------------------------------------------------ */

export function greetingText(childName: string): string {
  return (
    `Привет! Записываю сон и режим — ${childName}. ` +
    'Скажите, например: «заснул», «проснулся» или «сколько сегодня спал».'
  );
}

export const FAREWELL_TEXT = 'Хорошо, записала. До связи!';

/** §3.2 словами — ответ на query_state. */
export function stateSummaryText(ctx: AppContext, now: Date = new Date()): string {
  const state = getState(ctx.db, ctx.cfg, now);
  const name = ctx.cfg.childName;
  const tz = ctx.cfg.tz;
  const parts: string[] = [];

  if (state.sleep.status === 'asleep' && state.sleep.since) {
    parts.push(
      `${name} спит ${formatDurationRuAcc(state.sleep.currentDurationMin)}, ` +
        `с ${formatTimeLocal(state.sleep.since, tz)}.`,
    );
  } else if (state.sleep.since) {
    parts.push(`${name} не спит уже ${formatDurationRuAcc(state.sleep.currentDurationMin)}.`);
    if (state.sleep.lastSleep) {
      parts.push(`Последний сон — ${formatDurationRu(state.sleep.lastSleep.durationMin)}.`);
    }
  } else {
    parts.push(`${name} сейчас не спит, сон ещё не записывали.`);
  }

  if (state.today.sleepSessions > 0) {
    parts.push(
      `Сегодня всего ${formatDurationRu(state.today.sleepTotalMin)} ` +
        `за ${state.today.sleepSessions} ${pluralRu(state.today.sleepSessions, SLEEPS)}.`,
    );
    if (state.today.longestSleepMin > 0) {
      parts.push(`Самый долгий — ${formatDurationRu(state.today.longestSleepMin)}.`);
    }
  } else {
    parts.push('Сегодня сна ещё не было.');
  }

  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Обработка                                                           */
/* ------------------------------------------------------------------ */

function extractCommand(body: AliceRequestBody): string {
  const req = body.request;
  const command = typeof req?.command === 'string' ? req.command : '';
  if (command.trim().length > 0) return command;
  const original = typeof req?.original_utterance === 'string' ? req.original_utterance : '';
  return original;
}

function extractUserId(body: AliceRequestBody): string | null {
  const session = body.session;
  return session?.user_id ?? session?.user?.user_id ?? session?.application?.application_id ?? null;
}

export type RejectReason = 'secret' | 'skill_id' | 'user_id';

export interface AccessCheck {
  ok: boolean;
  reason?: RejectReason;
  userId: string | null;
}

/**
 * Проверки §3.1 по порядку. Любая неудача — 200 OK с нейтральным текстом.
 * В лог пишем ТОЛЬКО причину и user_id; секрет не логируем.
 */
export function checkAccess(ctx: AppContext, secretFromPath: string, body: AliceRequestBody): AccessCheck {
  const userId = extractUserId(body);

  if (!secretsEqual(secretFromPath, ctx.cfg.aliceWebhookSecret)) {
    return { ok: false, reason: 'secret', userId };
  }

  if (ctx.cfg.aliceSkillId !== null && body.session?.skill_id !== ctx.cfg.aliceSkillId) {
    return { ok: false, reason: 'skill_id', userId };
  }

  if (ctx.cfg.aliceAllowedUserIds.length > 0) {
    if (userId === null || !ctx.cfg.aliceAllowedUserIds.includes(userId)) {
      return { ok: false, reason: 'user_id', userId };
    }
  }

  return { ok: true, userId };
}

interface HandleResult {
  body: AliceResponseBody;
  fast: FastResult | null;
}

/**
 * Синхронная обработка запроса. Возвращает тело ответа сразу; всё, что можно
 * отложить (SSE), откладывается через setImmediate.
 */
export function handleAliceRequest(
  ctx: AppContext,
  body: AliceRequestBody,
  userId: string | null,
): HandleResult {
  const { cfg, db } = ctx;
  const now = new Date();
  const command = extractCommand(body);
  const sessionId = body.session?.session_id ?? null;
  const isNew = body.session?.new === true;

  // Приветствие: новая сессия без команды.
  if (isNew && command.trim().length === 0) {
    return { body: aliceReply(greetingText(cfg.childName), false), fast: null };
  }

  if (command.trim().length === 0) {
    return {
      body: aliceReply('Скажите, например: «заснул» или «проснулся».', false),
      fast: null,
    };
  }

  const fast = matchFast(command, body.request?.nlu, { now, tz: cfg.tz });

  // Выход из диалога: событием не является, LLM тут не нужна.
  if (fast.kind === 'exit') {
    const utterance = insertUtterance(db, {
      rawText: command,
      aliceUserId: userId,
      sessionId,
      fastResult: fast,
      status: 'skipped',
      llmError: 'команда выхода из диалога — разбирать нечего',
    });
    scheduleUtteranceBroadcast(ctx, utterance.id);
    return { body: aliceReply(FAREWELL_TEXT, true), fast };
  }

  // Фраза сохраняется ВСЕГДА, но модель зовём по политике §9.4: Opus на каждое
  // уверенно распознанное «заснул» — деньги на ветер. Команды правки данных
  // («убери предыдущую») уходят модели независимо от уверенности матчера.
  const decision = decideQueue({
    policy: cfg.llmQueuePolicy,
    threshold: cfg.llmConfidenceThreshold,
    fast,
    command,
  });

  const utterance = insertUtterance(db, {
    rawText: command,
    aliceUserId: userId,
    sessionId,
    fastResult: fast,
    status: decision.queue ? 'pending' : 'skipped',
    llmError: decision.queue ? null : `не отправлено модели: ${decision.reason}`,
  });

  // Всё, что пишет быстрый матчер, тоже попадает в журнал — иначе «отмени
  // последнее» сразу после «андрей заснул» было бы нечего отменять (§9).
  const journal: JournalContext = {
    changeSetId: newChangeSetId(),
    actor: 'alice-fast',
    utteranceId: utterance.id,
    summary: `Быстрый разбор фразы: «${command.slice(0, 200)}»`,
  };

  let text: string;

  switch (fast.kind) {
    case 'sleep_start': {
      const res = startSleep(db, cfg, {
        at: fast.at ?? now.toISOString(),
        utteranceId: utterance.id,
        source: 'alice-fast',
        confidence: fast.confidence,
        journal,
      });
      if (res.status === 'already_open') {
        // время берётся из уже записанного события, а не из неразобранной фразы,
        // поэтому здесь оно точное
        text =
          `${cfg.childName} уже спит, с ${formatTimeLocal(res.event.started_at, cfg.tz)}. ` +
          `Это ${formatDurationRu(res.durationMin)}`;
      } else if (fast.timeUnresolved) {
        // Время во фразе названо, но не разобрано: называть вслух «в 17:32»
        // нельзя — это и есть та самая правдоподобная неправда. Момент
        // поправит модель, фраза уже ушла ей в очередь.
        text = `Записала: ${cfg.childName} заснул. Время уточню`;
        scheduleEventBroadcast(ctx, 'created', res.event.id);
      } else {
        text = `Записала: ${cfg.childName} заснул в ${formatTimeLocal(res.event.started_at, cfg.tz)}`;
        scheduleEventBroadcast(ctx, 'created', res.event.id);
      }
      break;
    }

    case 'sleep_end': {
      const res = endSleep(db, cfg, {
        at: fast.at ?? now.toISOString(),
        utteranceId: utterance.id,
        source: 'alice-fast',
        confidence: fast.confidence,
        journal,
      });
      if (res.status === 'closed' && fast.timeUnresolved) {
        // длительность посчиталась бы от неверного момента — не озвучиваем
        text = `Записала, что ${cfg.childName} проснулся. Время уточню`;
        scheduleEventBroadcast(ctx, 'updated', res.event.id);
      } else if (res.status === 'closed') {
        text = `${cfg.childName} проснулся. Спал ${formatDurationRuAcc(res.durationMin)}`;
        scheduleEventBroadcast(ctx, 'updated', res.event.id);
      } else {
        text = 'А он и не спал. Записала, что проснулся';
        scheduleEventBroadcast(ctx, 'created', res.event.id);
      }
      break;
    }

    case 'query_state': {
      text = stateSummaryText(ctx, now);
      break;
    }

    default: {
      const quoted = command.length > 120 ? `${command.slice(0, 119)}…` : command;
      text = `Приняла: «${quoted}». Сейчас разберу`;
      break;
    }
  }

  scheduleUtteranceBroadcast(ctx, utterance.id);
  scheduleStateBroadcast(ctx);

  // Воркер стартует немедленно (§9.4), а не ждёт следующего тика.
  if (decision.queue) setImmediate(() => ctx.notifyWorker());

  return { body: aliceReply(text, false), fast };
}

/* ------------------------------------------------------------------ */
/* Отложенные эффекты — всё, что не должно задерживать ответ            */
/* ------------------------------------------------------------------ */

function scheduleStateBroadcast(ctx: AppContext): void {
  setImmediate(() => {
    try {
      ctx.sse.broadcastState(getState(ctx.db, ctx.cfg));
    } catch (err) {
      ctx.log.error({ err }, 'sse: не удалось разослать state');
    }
  });
}

function scheduleEventBroadcast(
  ctx: AppContext,
  action: 'created' | 'updated' | 'deleted',
  eventId: number,
): void {
  setImmediate(() => {
    try {
      const row = getEventById(ctx.db, eventId);
      if (row) ctx.sse.broadcastEvent(action, row);
    } catch (err) {
      ctx.log.error({ err }, 'sse: не удалось разослать event');
    }
  });
}

function scheduleUtteranceBroadcast(ctx: AppContext, utteranceId: number): void {
  setImmediate(() => {
    try {
      const row = getUtterance(ctx.db, utteranceId);
      if (row) ctx.sse.broadcastUtterance(toUtteranceDto(row));
    } catch (err) {
      ctx.log.error({ err }, 'sse: не удалось разослать utterance');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Маршрут                                                             */
/* ------------------------------------------------------------------ */

/** user_id, о которых уже написали в лог в режиме первичной настройки. */
const seenSetupUsers = new Set<string>();

export function registerAliceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/alice/:secret',
    async (
      request: FastifyRequest<{ Params: { secret: string } }>,
      reply: FastifyReply,
    ): Promise<AliceResponseBody> => {
      const started = process.hrtime.bigint();
      reply.type('application/json; charset=utf-8');

      try {
        const body = (request.body ?? {}) as AliceRequestBody;
        const access = checkAccess(ctx, request.params.secret ?? '', body);

        if (!access.ok) {
          ctx.log.warn(
            { reason: access.reason, userId: access.userId, ip: request.ip },
            'alice: запрос отклонён',
          );
          return neutralReply();
        }

        // Режим первичной настройки: список user_id пуст — подсказываем, что вписать.
        if (ctx.cfg.aliceAllowedUserIds.length === 0 && access.userId) {
          if (!seenSetupUsers.has(access.userId)) {
            seenSetupUsers.add(access.userId);
            ctx.log.info(
              { userId: access.userId },
              'alice: ALICE_ALLOWED_USER_IDS пуст, принимаем всех. Впишите этот user_id в env.',
            );
          }
        }

        const result = handleAliceRequest(ctx, body, access.userId);

        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        if (elapsedMs > 200) {
          ctx.log.warn({ elapsedMs, kind: result.fast?.kind }, 'alice: превышен бюджет 200 мс');
        }
        return result.body;
      } catch (err) {
        // Алиса не должна показывать пользователю ошибку — всегда 200 с текстом.
        ctx.log.error({ err }, 'alice: необработанная ошибка');
        return neutralReply();
      }
    },
  );

  // Тот же путь без секрета — отвечаем так же нейтрально, чтобы не подсказывать форму URL.
  app.post('/alice', async (_request, reply): Promise<AliceResponseBody> => {
    reply.type('application/json; charset=utf-8');
    return neutralReply();
  });
}
