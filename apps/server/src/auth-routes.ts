/**
 * Эндпоинты авторизации устройств.
 *
 * Делятся на две неравные части:
 *
 *  - ОТКРЫТЫЕ (перечислены в auth-guard.ts): страница сопряжения и два
 *    эндпоинта потока. Это всё, что доступно устройству без сессии;
 *  - ЗАКРЫТЫЕ: одобрение, отзыв, выход. Они за дверью, как и всё остальное.
 *
 * Отсюда и замкнутый круг с первым устройством: одобрять некому, пока никто
 * не вошёл. Развязывает его не лазейка в этом файле, а команда на сервере —
 * см. auth-cli.ts и docs/DEPLOY.md. Лазейка в коде осталась бы навсегда,
 * а доступ по ssh и так равносилен доступу к базе.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import { PAIR_PAGE_HTML } from './pair-page.ts';
import { PAIR_PATH, safeNext } from './auth-guard.ts';
import { ROW_ID_HINT, parseRowId } from './http-params.ts';
import {
  CODE_TTL_SEC,
  DEVICE_KINDS,
  LIMITS,
  RateLimiter,
  approveCode,
  buildSessionCookie,
  clearSessionCookie,
  denyCode,
  findPendingByUserCode,
  formatUserCode,
  getCodeById,
  isWellFormedUserCode,
  listLiveSessions,
  listPendingCodes,
  normalizeUserCode,
  pollForSession,
  parseDeviceKind,
  revokeSession,
  startPairing,
  toPendingDto,
  toSessionDto,
} from './device-auth.ts';

/* ------------------------------------------------------------------ */
/* Схемы входа                                                         */
/* ------------------------------------------------------------------ */

const startSchema = z.object({
  kind: z.enum(DEVICE_KINDS as unknown as [string, ...string[]]).optional(),
  next: z.string().max(200).optional(),
});

const tokenSchema = z.object({
  // Длина с запасом: 32 байта в base64url — 43 символа.
  device_code: z.string().min(16).max(200),
});

const approveSchema = z.object({
  user_code: z.string().min(1).max(64),
});

/* ------------------------------------------------------------------ */
/* Подпись устройства                                                  */
/* ------------------------------------------------------------------ */

/**
 * Человеческая подпись по User-Agent.
 *
 * Специально грубая. Заказчик сказал прямо: «проблемы отличать нет, я всех
 * знаю по именам, так как это семья». Значит опознание устройства — не
 * задача безопасности, а подпись в списке, чтобы глазами отличить телевизор
 * от телефона при отзыве. Отпечатки, геолокация и прочая криминалистика
 * здесь были бы бюрократией вместо пользы.
 */
export function describeUserAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  const s = ua.toLowerCase();
  if (/android\s*tv|googletv|smarttv|smart-tv|bravia|aft[a-z]|web0s|webos|tizen|crkey/.test(s)) {
    return 'Телевизор';
  }
  if (/ipad/.test(s)) return 'iPad';
  if (/iphone|ipod/.test(s)) return 'iPhone';
  if (/android/.test(s)) return 'Телефон Android';
  if (/macintosh|mac os x/.test(s)) return 'Компьютер Mac';
  if (/windows/.test(s)) return 'Компьютер Windows';
  if (/linux/.test(s)) return 'Компьютер Linux';
  return null;
}

/** Ключ ограничителя. За Caddy и Cloudflare честный адрес даёт trustProxy. */
function clientKey(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

function tooMany(reply: FastifyReply, retryAfterSec: number, message: string): FastifyReply {
  return reply
    .code(429)
    .header('Retry-After', String(Math.max(1, retryAfterSec)))
    .send({ error: 'too_many_requests', message });
}

/* ------------------------------------------------------------------ */

export interface AuthRoutesOptions {
  limiter: RateLimiter;
  /** Подменяемые часы для тестов. */
  now?: () => number;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  options: AuthRoutesOptions,
): void {
  const { cfg, db, sse } = ctx;
  const limiter = options.limiter;
  const now = options.now ?? (() => Date.now());
  const cookieOptions = { secure: cfg.authCookieSecure };

  /* ================================================================ */
  /* ОТКРЫТО: страница сопряжения                                     */
  /* ================================================================ */

  app.get(PAIR_PATH, async (_request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      // Закешированная страница сопряжения — это застрявший код, который
      // никогда не сработает. Ровно тот пустой экран, от которого уходим.
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(PAIR_PAGE_HTML),
  );

  /* ================================================================ */
  /* ОТКРЫТО: завести заявку (RFC 8628 §3.1–3.2)                      */
  /* ================================================================ */

  app.post('/api/device/code', async (request: FastifyRequest, reply) => {
    const key = `start:${clientKey(request)}`;
    if (!limiter.take(key, LIMITS.start.limit, LIMITS.start.windowMs)) {
      return tooMany(reply, limiter.retryAfterSec(key), 'Слишком много запросов кода.');
    }

    const parsed = startSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });

    const ua = request.headers['user-agent'];
    // Тип берём от клиента, но если браузер выдал себя телевизором заголовком,
    // верим заголовку: он честнее подсказки из JS.
    const sniffed = describeUserAgent(ua);
    const kind = sniffed === 'Телевизор' ? 'tv' : parseDeviceKind(parsed.data.kind);

    const started = startPairing(db, {
      kind,
      label: sniffed,
      userAgent: ua ?? null,
      now: now(),
      ttlSec: cfg.pairCodeTtlSec,
    });

    ctx.log.info(
      { kind, userCode: formatUserCode(started.userCode) },
      'сопряжение: выдан код, ждём одобрения',
    );

    return reply.header('Cache-Control', 'no-store').send({
      // Секрет опроса. Пользователю он не показывается никогда (RFC §3.3).
      device_code: started.deviceCode,
      user_code: started.userCode,
      user_code_display: formatUserCode(started.userCode),
      verification_uri: PAIR_PATH,
      expires_in: started.expiresIn,
      interval: started.interval,
    });
  });

  /* ================================================================ */
  /* ОТКРЫТО: обменять device_code на сессию (RFC 8628 §3.4–3.5)      */
  /* ================================================================ */

  app.post('/api/device/token', async (request: FastifyRequest, reply) => {
    const key = `poll:${clientKey(request)}`;
    if (!limiter.take(key, LIMITS.poll.limit, LIMITS.poll.windowMs)) {
      return tooMany(reply, limiter.retryAfterSec(key), 'Слишком частый опрос.');
    }

    const parsed = tokenSchema.safeParse(request.body ?? {});
    // Даже на кривое тело отвечаем языком протокола: клиент и так умеет только
    // четыре ошибки RFC, а «issues» от zod ему не о чем сказать.
    if (!parsed.success) {
      return reply.code(400).send({ error: 'expired_token', interval: 5 });
    }

    const result = pollForSession(db, parsed.data.device_code, {
      now: now(),
      ttlDays: cfg.sessionTtlDays,
    });

    if (!result.ok) {
      return reply
        .code(400)
        .header('Cache-Control', 'no-store')
        .send({ error: result.error, interval: result.interval });
    }

    ctx.log.info(
      { sessionId: result.session.id, kind: result.session.kind },
      'сопряжение: устройство получило сессию',
    );

    return reply
      .header('Set-Cookie', buildSessionCookie(result.token, cookieOptions))
      .header('Cache-Control', 'no-store')
      .send({
        ok: true,
        redirect: result.session.kind === 'phone' ? '/dash' : '/',
        session: toSessionDto(result.session, result.session.id),
      });
  });

  /* ================================================================ */
  /* ЗАКРЫТО: кто я                                                   */
  /* ================================================================ */

  app.get('/api/auth/session', async (request) => ({
    session: request.deviceSession
      ? toSessionDto(request.deviceSession, request.deviceSession.id)
      : null,
  }));

  /* ================================================================ */
  /* ЗАКРЫТО: выход                                                   */
  /* ================================================================ */

  app.post('/api/auth/logout', async (request, reply) => {
    const session = request.deviceSession;
    if (session) {
      revokeSession(db, session.id, now());
      sse.closeSession(session.id);
      ctx.log.info({ sessionId: session.id }, 'сессия завершена по запросу устройства');
    }
    return reply
      .header('Set-Cookie', clearSessionCookie(cookieOptions))
      .header('Cache-Control', 'no-store')
      .send({ ok: true, pair: PAIR_PATH });
  });

  /* ================================================================ */
  /* ЗАКРЫТО: экран устройств                                         */
  /* ================================================================ */

  /**
   * Один запрос на весь экран: и кто ждёт одобрения, и кто уже подключён.
   * Экран показывает их вместе, разделять их на два запроса значило бы
   * два состояния загрузки там, где смысл один.
   */
  app.get('/api/devices', async (request) => {
    const current = request.deviceSession?.id ?? null;
    const ts = now();
    return {
      pending: listPendingCodes(db, ts).map((row) => toPendingDto(row, ts)),
      sessions: listLiveSessions(db, ts).map((row) => toSessionDto(row, current)),
      codeTtlSec: cfg.pairCodeTtlSec || CODE_TTL_SEC,
    };
  });

  /** Одобрение из списка: человек видит код на экране телевизора и сверяет глазами. */
  app.post(
    '/api/devices/pending/:id/approve',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = parseRowId(request.params.id);
      if (id === null) return reply.code(400).send({ error: 'bad_request', message: ROW_ID_HINT });

      const row = approveCode(db, id, request.deviceSession?.id ?? 'unknown', now());
      if (!row) {
        // Заявки нет, она истекла или её уже разобрали. Разница для человека
        // одна и та же: одобрять нечего.
        return reply.code(404).send({ error: 'not_found', message: 'Заявка уже недоступна.' });
      }

      ctx.log.info(
        { codeId: id, by: request.deviceSession?.id },
        'сопряжение: заявка одобрена из админки',
      );
      return { ok: true, approved: toPendingDto(row, now()) };
    },
  );

  app.post(
    '/api/devices/pending/:id/deny',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = parseRowId(request.params.id);
      if (id === null) return reply.code(400).send({ error: 'bad_request', message: ROW_ID_HINT });

      const row = denyCode(db, id, now());
      if (!row) return reply.code(404).send({ error: 'not_found', message: 'Заявка уже недоступна.' });

      ctx.log.info({ codeId: id }, 'сопряжение: заявка отклонена');
      return { ok: true };
    },
  );

  /**
   * Одобрение по набранному коду.
   *
   * Ограничитель здесь главный: короткий код — это 20^8, и без счётчика
   * попыток его можно перебрать. Пять попыток за окно — ровно та цифра, при
   * которой RFC 8628 §5.1 считает перебор бессмысленным. Счётчик тратится
   * ТОЛЬКО на неудачных попытках: человек, набравший верный код, не должен
   * упираться в лимит из-за того, что раньше ошибся.
   */
  app.post('/api/devices/approve', async (request: FastifyRequest, reply) => {
    const parsed = approveSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }

    const key = `guess:${clientKey(request)}`;
    if (!limiter.take(key, LIMITS.guess.limit, LIMITS.guess.windowMs)) {
      ctx.log.warn({ ip: request.ip }, 'сопряжение: перебор кода упёрся в ограничитель');
      return tooMany(
        reply,
        limiter.retryAfterSec(key),
        'Слишком много попыток. Подождите и попробуйте снова.',
      );
    }

    const code = normalizeUserCode(parsed.data.user_code);
    const found = isWellFormedUserCode(code) ? findPendingByUserCode(db, code, now()) : null;
    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Такой код не ждёт одобрения.' });
    }

    const row = approveCode(db, found.id, request.deviceSession?.id ?? 'unknown', now());
    if (!row) {
      return reply.code(404).send({ error: 'not_found', message: 'Такой код не ждёт одобрения.' });
    }

    // Верный код — попытка не в счёт: возвращаем её в окно.
    limiter.reset(key);

    ctx.log.info({ codeId: row.id }, 'сопряжение: заявка одобрена по набранному коду');
    return { ok: true, approved: toPendingDto(row, now()) };
  });

  /* ================================================================ */
  /* ЗАКРЫТО: отзыв устройства                                        */
  /* ================================================================ */

  /**
   * Главная практическая ценность всей затеи: потерянный телефон отзывается
   * одним нажатием. Поэтому отзыв обязан действовать немедленно и целиком —
   * и на новые запросы (дверь), и на уже открытый поток событий.
   */
  app.post(
    '/api/devices/:id/revoke',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = request.params.id;
      if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
        return reply.code(400).send({ error: 'bad_request', message: 'id устройства некорректен' });
      }

      const row = revokeSession(db, id, now());
      if (!row) return reply.code(404).send({ error: 'not_found', id });

      const closed = sse.closeSession(id);
      const self = request.deviceSession?.id === id;

      ctx.log.info({ sessionId: id, streamsClosed: closed, self }, 'устройство отозвано');

      const res = reply.header('Cache-Control', 'no-store');
      // Отозвали сами себя — заодно убираем куку, иначе браузер будет носить
      // мёртвый секрет и получать 401 на каждый чих.
      if (self) res.header('Set-Cookie', clearSessionCookie(cookieOptions));
      return res.send({ ok: true, self, streamsClosed: closed });
    },
  );

  /* ================================================================ */

  /** Сведения о заявке по id — нужны экрану одобрения после действия. */
  app.get(
    '/api/devices/pending/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = parseRowId(request.params.id);
      if (id === null) return reply.code(400).send({ error: 'bad_request', message: ROW_ID_HINT });
      const row = getCodeById(db, id);
      if (!row) return reply.code(404).send({ error: 'not_found', id });
      return { pending: toPendingDto(row, now()), status: row.status };
    },
  );
}

/** Переэкспорт: приложению и тестам удобно брать оба имени из одного места. */
export { safeNext };
