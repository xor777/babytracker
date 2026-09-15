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
import { endSleep, getState, insertEvent, startSleep } from './events.ts';
import { getUtterance, insertUtterance, toUtteranceDto } from './utterances.ts';
import { getEventById } from './db.ts';
import { newChangeSetId, type JournalContext } from './journal.ts';
import { decideQueue } from './queue-policy.ts';
import { ROW_ID_HINT, parseRowId } from './http-params.ts';
import {
  ENROLL_DEFAULT_MINUTES,
  SETTING_SKILL_ID,
  closeEnrollWindow,
  countTrusted,
  describeIdentity,
  enrollWindowUntil,
  extractIdentity,
  findIdentity,
  getSetting,
  identityValues,
  isTrustEstablished,
  markTrustEstablished,
  listIdentities,
  openEnrollWindow,
  rememberIdentity,
  revokeIdentityRow,
  setSetting,
  trustIdentityRow,
  type AliceIdentity,
} from './alice-identity.ts';
import {
  formatDurationRu,
  formatDurationRuAcc,
  formatTimeLocal,
  pluralRu,
  SLEEPS,
} from './ru.ts';

const MAX_TEXT = 1024;
const PROTOCOL_VERSION = '1.0';

/** Нейтральный ответ на неверный секрет: атакующий не должен различать причины. */
const NEUTRAL_TEXT = 'Извините, сейчас не могу ответить.';

/**
 * Ответ на незнакомую идентичность. Намеренно ОТЛИЧАЕТСЯ от нейтрального:
 * по голосу должно быть понятно, что это не сбой сервера, а неподключённое
 * устройство, и что делать. Молчаливая блокировка владельца — та самая ошибка,
 * из-за которой заказчика трижды заперло.
 */
const UNKNOWN_DEVICE_TEXT =
  'Это устройство пока не подключено к трекеру. ' +
  'Откройте админку, раздел устройств, и подтвердите его — или включите режим подключения.';

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

export function unknownDeviceReply(): AliceResponseBody {
  return aliceReply(UNKNOWN_DEVICE_TEXT, true);
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

/**
 * Верхняя граница на сырой текст. Тело запроса ограничено мегабайтом, но фраза
 * такого размера не должна ни разбираться, ни попадать в БД и в ленту дашборда:
 * реальная реплика в разы короче предела самой Алисы в 1024 символа.
 */
const MAX_RAW_COMMAND_CHARS = 2048;

function extractCommand(body: AliceRequestBody): string {
  const req = body.request;
  const command = typeof req?.command === 'string' ? req.command : '';
  const chosen =
    command.trim().length > 0
      ? command
      : typeof req?.original_utterance === 'string'
        ? req.original_utterance
        : '';
  return chosen.length > MAX_RAW_COMMAND_CHARS
    ? chosen.slice(0, MAX_RAW_COMMAND_CHARS)
    : chosen;
}

export type RejectReason = 'secret' | 'skill_id' | 'identity';
export type GrantReason = 'env' | 'trusted' | 'promoted' | 'enroll' | 'tofu' | 'disabled';

export interface AccessCheck {
  ok: boolean;
  reason?: RejectReason;
  /** Как именно допустили — нужно логу, чтобы было видно, почему пустили. */
  grantedBy?: GrantReason;
  identity: AliceIdentity;
  /** id строки в alice_identities, если обращение отклонено и ждёт подтверждения. */
  pendingId?: number;
  /** Значение, которым подписывается utterance. */
  userId: string | null;
}

/**
 * Проверки §3.1 плюс модель доверия.
 *
 * Порядок и его смысл:
 *  1. секрет — настоящая защита, 128 бит в пути запроса;
 *  2. skill_id из env — если оператор задал явно, это жёсткий рубеж;
 *  3. идентичность: сначала аккаунт (один на все колонки в доме), потом устройство.
 *
 * Ключевое отличие от прежней версии: незнакомая идентичность НЕ приводит
 * к молчаливой блокировке. Обращение запоминается со статусом pending, попадает
 * в админку и в лог с готовой командой, а ответ звучит отличимо от сбоя сервера.
 */
export function checkAccess(
  ctx: AppContext,
  secretFromPath: string,
  body: AliceRequestBody,
): AccessCheck {
  const { cfg, db } = ctx;
  const identity = extractIdentity(body);
  const base = { identity, userId: identity.key };

  // 1. Секрет. Здесь ответ обязан быть нейтральным: атакующий не должен
  //    различать причины отказа и подбирать URL.
  if (!secretsEqual(secretFromPath, cfg.aliceWebhookSecret)) {
    return { ...base, ok: false, reason: 'secret' };
  }

  // 2. skill_id, заданный переменной окружения, — строгая проверка.
  if (cfg.aliceSkillId !== null && identity.skillId !== cfg.aliceSkillId) {
    return { ...base, ok: false, reason: 'skill_id' };
  }

  // 3. Проверка идентичности выключена — пускаем, но обращение фиксируем.
  if (!cfg.aliceIdentityCheck) {
    touch(db, identity, 'trusted', 'api', 'проверка идентичности выключена');
    return { ...base, ok: true, grantedBy: 'disabled' };
  }

  const grant = (grantedBy: GrantReason): AccessCheck => {
    touch(db, identity, 'trusted', grantedBy === 'env' ? 'api' : 'tofu');
    markTrustEstablished(db);
    // Владелец авторитетен: раз он пришёл с этого навыка, значит навык этот.
    if (identity.skillId) setSetting(db, SETTING_SKILL_ID, identity.skillId);
    return { ...base, ok: true, grantedBy };
  };

  // 4. Совместимость: заданный ALICE_ALLOWED_USER_IDS уважаем как раньше.
  //    Сверяем со ВСЕМИ тремя полями — на проде там лежат значения устаревшего
  //    user_id, и какое именно это поле, мы не знаем.
  if (cfg.aliceAllowedUserIds.length > 0) {
    const hit = identityValues(identity).some((v) => cfg.aliceAllowedUserIds.includes(v));
    if (hit) return grant('env');
  }

  // 5. Доверенный аккаунт — этого достаточно для любой колонки в доме.
  if (identity.accountId && findIdentity(db, 'account', identity.accountId)?.status === 'trusted') {
    return grant('trusted');
  }

  // 6. Доверенное устройство. Если с него пришёл ещё и аккаунт, которого мы
  //    не знали, — запоминаем и его: иначе после входа в аккаунт на уже
  //    доверенной колонке человек оказался бы заперт.
  const deviceTrusted = [identity.applicationId, identity.legacyUserId].some(
    (v) => v !== null && findIdentity(db, 'device', v)?.status === 'trusted',
  );
  if (deviceTrusted) {
    if (identity.accountId) {
      rememberIdentity(db, {
        identity,
        kind: 'account',
        value: identity.accountId,
        status: 'trusted',
        source: 'promoted',
        note: 'аккаунт увиден с уже доверенного устройства',
      });
      return grant('promoted');
    }
    return grant('trusted');
  }

  // 7. Открытое окно добавления устройства (кнопка в админке).
  if (enrollWindowUntil(db) !== null && identity.key !== null) {
    closeEnrollWindow(db); // окно одноразовое: добавили устройство — закрыли
    touch(db, identity, 'trusted', 'enroll', 'добавлено через окно подключения');
    markTrustEstablished(db);
    if (identity.skillId) setSetting(db, SETTING_SKILL_ID, identity.skillId);
    return { ...base, ok: true, grantedBy: 'enroll' };
  }

  // 8. Доверие первому — РОВНО ОДИН РАЗ за жизнь установки. Проверять только
  //    countTrusted() нельзя: сняв доверие у единственного устройства, мы бы
  //    снова открыли дверь, и отзыв не работал бы.
  if (
    identity.key !== null &&
    cfg.aliceAllowedUserIds.length === 0 &&
    countTrusted(db) === 0 &&
    !isTrustEstablished(db)
  ) {
    touch(db, identity, 'trusted', 'tofu', 'первый увиденный владелец');
    markTrustEstablished(db);
    if (identity.skillId) setSetting(db, SETTING_SKILL_ID, identity.skillId);
    return { ...base, ok: true, grantedBy: 'tofu' };
  }

  // 9. Незнакомая идентичность. Не запираем молча: запоминаем и показываем.
  const row = identity.key === null ? null : touch(db, identity, 'pending', 'api');
  return { ...base, ok: false, reason: 'identity', ...(row ? { pendingId: row.id } : {}) };
}

/** Фиксирует факт обращения. Ошибку БД глотаем: она не повод отказать в записи сна. */
function touch(
  db: AppContext['db'],
  identity: AliceIdentity,
  status: 'trusted' | 'pending',
  source: 'tofu' | 'api' | 'enroll' | 'promoted',
  note?: string,
): { id: number } | null {
  if (identity.key === null) return null;
  try {
    return rememberIdentity(db, {
      identity,
      kind: identity.kind,
      value: identity.key,
      status,
      source,
      note: note ?? null,
    });
  } catch {
    return null;
  }
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

  /*
   * Держать ли микрофон после ответа (§3.1 + разбор прод-инцидента).
   *
   * Что случилось: на «Алиса, скажи дневнику Андрея, что он закончил есть грудь»
   * мы записали событие и оставили сессию открытой. Следующая фраза человека —
   * «включи свет в гостиной» — прилетела НАМ вместо Алисы. В дневнике появился
   * мусор, а свет не включился. Это хуже грязи в ленте: навык сломал бытовое
   * пользование колонкой.
   *
   * Различаем по документации Яндекса: при простом запуске («запусти дневник»)
   * request.command ПУСТОЙ, при запуске с командой («скажи дневнику, что…»)
   * в него попадает весь текст, кроме активационной фразы. Отсюда:
   *
   *   new=true  + команда пустая  -> человек открыл диалог, чтобы диктовать -> держим
   *   new=true  + команда есть    -> сказал всё одной фразой -> отвечаем и ОТПУСКАЕМ
   *   new=false + любая команда   -> он внутри диктовки -> держим до «хватит»
   *
   * Если поля session.new нет вовсе, считаем сессию новой: отпустить микрофон
   * безопаснее, чем удержать. Именно удержание и стоило заказчику света.
   */
  const isContinuation = body.session?.new === false;
  const hasCommand = command.trim().length > 0;
  const oneShot = !isContinuation && hasCommand;
  /** Держим микрофон только там, где человек явно собрался диктовать дальше. */
  const keepOpen = !oneShot;

  // Приветствие: явный запуск навыка без команды — человек собрался диктовать.
  if (!isContinuation && !hasCommand) {
    return { body: aliceReply(greetingText(cfg.childName), false), fast: null };
  }

  if (!hasCommand) {
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

    case 'diaper': {
      const { event } = insertEvent(
        db,
        {
          type: 'diaper',
          subtype: fast.subtype,
          started_at: fast.at ?? now.toISOString(),
          ended_at: fast.at ?? now.toISOString(),
          source: 'alice-fast',
          utterance_id: utterance.id,
          confidence: fast.confidence,
        },
        'close-previous',
        journal,
      );
      text = fast.subtype === 'dirty' ? 'Записала: покакал' : 'Записала: пописал';
      scheduleEventBroadcast(ctx, 'created', event.id);
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

  return { body: aliceReply(text, !keepOpen), fast };
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

/** Идентичности, о которых уже писали в лог — чтобы не спамить на каждый запрос. */
const loggedIdentities = new Set<string>();

/**
 * Одна понятная строка на незнакомое обращение — со всеми тремя полями
 * идентичности и готовой командой подключения. Повторы того же устройства
 * в лог не идут.
 */
function logUnknownIdentity(ctx: AppContext, access: AccessCheck, ip: string): void {
  const key = access.identity.key ?? 'без-идентификатора';
  if (loggedIdentities.has(key)) return;
  loggedIdentities.add(key);

  ctx.log.warn(
    {
      ip,
      // все три поля: по ним видно, авторизовано устройство или нет
      accountId: access.identity.accountId,
      applicationId: access.identity.applicationId,
      legacyUserId: access.identity.legacyUserId,
      skillId: access.identity.skillId,
      pendingId: access.pendingId,
      подключить: access.pendingId
        ? `POST /api/alice/pending/${access.pendingId}/trust`
        : 'POST /api/alice/enroll, затем повторить фразу',
    },
    `alice: незнакомое обращение (${describeIdentity(access.identity)}). ` +
      'Владелец НЕ заблокирован навсегда: подтвердите устройство в админке ' +
      '(раздел устройств) или откройте режим подключения.',
  );
}

/** Сообщаем, когда доверие выдано не по обычному совпадению — это важные события. */
function logGrant(ctx: AppContext, access: AccessCheck): void {
  const key = `${access.grantedBy}:${access.identity.key ?? '-'}`;
  if (loggedIdentities.has(key)) return;
  loggedIdentities.add(key);

  const messages: Record<string, string> = {
    tofu: 'первое обращение — запомнили как владельца (доверие первому)',
    enroll: 'устройство подключено через окно подключения',
    promoted: 'аккаунт увиден с доверенного устройства и тоже стал доверенным',
    env: 'пропущено по ALICE_ALLOWED_USER_IDS',
    disabled: 'проверка идентичности выключена (ALICE_IDENTITY_CHECK=false)',
  };

  ctx.log.info(
    {
      accountId: access.identity.accountId,
      applicationId: access.identity.applicationId,
      skillId: access.identity.skillId,
      grantedBy: access.grantedBy,
    },
    `alice: ${messages[access.grantedBy ?? ''] ?? 'доступ разрешён'} — ${describeIdentity(access.identity)}`,
  );
}

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
          if (access.reason === 'identity') {
            logUnknownIdentity(ctx, access, request.ip);
            // Отличимый ответ: человек должен понять, что делать.
            return unknownDeviceReply();
          }
          ctx.log.warn(
            { reason: access.reason, ip: request.ip },
            'alice: запрос отклонён',
          );
          return neutralReply();
        }

        if (access.grantedBy && access.grantedBy !== 'trusted') {
          logGrant(ctx, access);
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

  registerIdentityRoutes(app, ctx);
}

/* ------------------------------------------------------------------ */
/* Управление устройствами из админки (за Basic Auth на уровне Caddy)   */
/* ------------------------------------------------------------------ */

function toIdentityDto(row: ReturnType<typeof listIdentities>[number]): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    identity: row.identity,
    status: row.status,
    accountId: row.account_id,
    applicationId: row.application_id,
    legacyUserId: row.legacy_user_id,
    skillId: row.skill_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    seenCount: row.seen_count,
    source: row.source,
    note: row.note,
  };
}

export function registerIdentityRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  /** Все известные устройства и аккаунты — лента для админки. */
  app.get('/api/alice/identities', async () => ({
    identities: listIdentities(db).map(toIdentityDto),
    enrollOpenUntil: enrollWindowUntil(db),
    identityCheck: ctx.cfg.aliceIdentityCheck,
    knownSkillId: getSetting(db, SETTING_SKILL_ID),
  }));

  /** Неопознанные обращения: их видно, а не «где-то в логах». */
  app.get('/api/alice/pending', async () => ({
    pending: listIdentities(db, 'pending').map(toIdentityDto),
    enrollOpenUntil: enrollWindowUntil(db),
  }));

  /** Подтвердить устройство одним нажатием с телефона. */
  app.post(
    '/api/alice/pending/:id/trust',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = parseRowId(request.params.id);
      if (id === null) {
        return reply.code(400).send({ error: 'bad_request', message: ROW_ID_HINT });
      }
      const row = trustIdentityRow(db, id, 'api');
      if (!row) return reply.code(404).send({ error: 'not_found', id });
      ctx.log.info({ id, identity: row.identity, kind: row.kind }, 'alice: устройство подтверждено');
      return { identity: toIdentityDto(row) };
    },
  );

  /** Снять доверие (например, продали колонку). */
  app.delete(
    '/api/alice/identities/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = parseRowId(request.params.id);
      if (id === null) {
        return reply.code(400).send({ error: 'bad_request', message: ROW_ID_HINT });
      }
      const row = revokeIdentityRow(db, id);
      if (!row) return reply.code(404).send({ error: 'not_found', id });
      ctx.log.warn({ id, identity: row.identity }, 'alice: доверие устройству снято');
      return { identity: toIdentityDto(row) };
    },
  );

  /**
   * Режим подключения: открыть окно и сказать что-нибудь новой колонке.
   * Нужен, когда устройства ещё нет в списке неопознанных — первая же фраза
   * с него станет доверенной, и окно сразу закроется.
   */
  app.post('/api/alice/enroll', async (request: FastifyRequest, reply) => {
    const body = (request.body ?? {}) as { minutes?: unknown };
    const minutes =
      typeof body.minutes === 'number' && Number.isFinite(body.minutes)
        ? body.minutes
        : ENROLL_DEFAULT_MINUTES;

    const until = openEnrollWindow(db, minutes);
    ctx.log.info({ until }, 'alice: открыто окно подключения устройства');
    reply.code(202);
    return {
      enrollOpenUntil: until,
      hint: 'Скажите что-нибудь новой колонке — первая фраза с неё станет доверенной.',
    };
  });

  /** Закрыть окно досрочно. */
  app.delete('/api/alice/enroll', async () => {
    closeEnrollWindow(db);
    return { enrollOpenUntil: null };
  });
}
