/**
 * Дверь. Единственная точка проверки доступа во всём приложении.
 *
 * Раньше сторожил Caddy, и сторожил всё скопом: «если не /alice и не /healthz —
 * спроси пароль». Теперь защита — дело приложения, и это главное место риска
 * во всей затее: у Fastify много способов отдать ответ мимо обработчика
 * маршрута (статика, SPA-fallback, обработчик 404), и забыть любой из них
 * означает открыть историю ребёнка всему интернету.
 *
 * Поэтому здесь ровно один хук `onRequest`, повешенный на корневой инстанс
 * ДО регистрации чего бы то ни было. Опытом проверено (см. тесты
 * device-auth-guard), что он видит и файлы статики, и SPA-fallback, и
 * несуществующие пути: всё, что доходит до сервера.
 *
 * Список открытого — явный перечень, а не правило вида «всё, кроме». Правило
 * «всё, кроме» ошибается в сторону открытости, перечень — в сторону закрытости.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.ts';
import { lookupSessionFromCookies, touchSession, type SessionRow } from './device-auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Сессия устройства, если запрос прошёл дверь. null — открытый путь. */
    deviceSession: SessionRow | null;
  }
}

/** Страница сопряжения. Короткая и запоминающаяся — RFC 8628 §3.2. */
export const PAIR_PATH = '/pair';

/**
 * Признаки того, что путь пытается сойти с места.
 *
 * Появилось не из осторожности, а по факту: `GET /alice/../index.html`
 * отдавал собранный дашборд без всякой сессии. Механизм такой — дверь
 * сверяла СЫРОЙ путь и видела открытый префикс `/alice/`, а дальше
 * маршрутизатор и раздача статики работали с ДЕКОДИРОВАННЫМ и
 * НОРМАЛИЗОВАННЫМ путём, в котором `..` уже схлопнулся в `/index.html`.
 * Работали все три написания: `..`, `%2e%2e` и `..%2f`.
 *
 * Отсюда правило: путь, в котором есть `..` или процентное кодирование
 * точки либо слеша, открытым не считается никогда. Ни один законный адрес
 * проекта такого не содержит — секрет Алисы это 32 hex-символа.
 */
const TRAVERSAL = /(\.\.)|(%2e)|(%2f)|(%5c)|\\/i;

/**
 * Что открыто без сессии. Больше здесь не будет ничего:
 *
 *  - `/healthz` — нужен выкатке и мониторингу, отдаёт только «жив/не жив»;
 *  - `/alice` и `/alice/<секрет>` — вебхук Алисы. Не трогаем вовсе: там
 *    общаются машины, Алиса не умеет ни кук, ни basic auth, и защищает её
 *    32-символьный секрет в самом адресе плюс сверка идентичности (§3.1).
 *    Ровно ОДИН сегмент после `/alice/`: префиксное правило шире адреса,
 *    который оно должно открывать, и эта разница уже стоила утечки статики;
 *  - `/pair` — страница сопряжения. Показать код и опросить сервер нужно
 *    ровно тому, у кого сессии ещё нет;
 *  - `/api/device/code` и `/api/device/token` — два эндпоинта самого потока.
 *
 * Сверка идёт по СЫРОМУ пути, без декодирования процентов. Это не лень:
 * маршрутизатор Fastify получает тот же сырой путь, и если декодировать
 * здесь, а там нет, то `/%68ealthz` открылся бы дверью как `/healthz`,
 * а отдался бы SPA-fallback'ом — то есть дашбордом. Сырая сверка ошибается
 * только в сторону лишнего запрета, и именно поэтому всё, что хоть
 * отдалённо похоже на кодирование, закрыто целиком.
 */
export function isOpenPath(method: string, rawPath: string, isPreflight = false): boolean {
  /*
   * Предполётный запрос CORS тела не несёт и данных не отдаёт, а заблокировать
   * его значит сломать разработку с отдельным Vite. Но пропускаем не «метод
   * OPTIONS», а именно preflight — по обязательному для него заголовку
   * `Access-Control-Request-Method`. Исключение по одному методу пережило бы
   * появление первого же прикладного маршрута, отвечающего на OPTIONS,
   * и тот оказался бы снаружи двери молча.
   */
  if (method === 'OPTIONS' && isPreflight) return true;

  // Проверяется ПЕРВОЙ и для всех путей сразу: если бы она стояла внутри
  // ветки про Алису, следующее префиксное правило завело бы дыру заново.
  if (TRAVERSAL.test(rawPath)) return false;

  if (rawPath === '/healthz') return true;
  if (rawPath === PAIR_PATH) return true;
  if (rawPath === '/api/device/code' || rawPath === '/api/device/token') return true;

  // `/alice` и `/alice/<один сегмент>` — и ничего глубже.
  if (rawPath === '/alice') return true;
  if (rawPath.startsWith('/alice/') && !rawPath.includes('/', '/alice/'.length)) return true;

  return false;
}

/** Путь без строки запроса. `?` и `#` в сыром URL отрезаем сами. */
export function pathOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Куда вернуть после сопряжения. Список закрытый: принимать сюда что угодно
 * из запроса — это открытый редирект, а `//evil.example` выглядит как путь,
 * но браузером читается как чужой хост.
 */
export function safeNext(rawPath: string): string {
  return rawPath === '/dash' || rawPath.startsWith('/dash/') ? '/dash' : '/';
}

/**
 * Это переход по адресу (человек смотрит в браузер) или запрос данных?
 *
 * Человеку правильно показать страницу сопряжения, а коду — честный 401:
 * редирект в ответ на fetch за JSON превратился бы в «неожиданный HTML
 * вместо данных», который отлаживают полдня.
 */
export function isNavigation(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers['sec-fetch-mode'];
  if (typeof mode === 'string') return mode === 'navigate';
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

export interface AuthGuardOptions {
  /** Подменяемые часы для тестов. */
  now?: () => number;
}

export function registerAuthGuard(
  app: FastifyInstance,
  ctx: AppContext,
  options: AuthGuardOptions = {},
): void {
  const now = options.now ?? (() => Date.now());

  // Декорируем ДО хука: иначе в обработчиках поле может оказаться
  // неопределённым, и `request.deviceSession` начнёт врать.
  app.decorateRequest('deviceSession', null);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawPath = pathOf(request.url);

    // Настоящий preflight всегда несёт этот заголовок — он и отличает его от
    // обычного OPTIONS, который мог бы что-то отдать.
    const preflight = typeof request.headers['access-control-request-method'] === 'string';

    if (isOpenPath(request.method, rawPath, preflight)) return;

    const session = lookupSessionFromCookies(ctx.db, request.headers.cookie, now());

    if (!session) {
      if (isNavigation(request)) {
        // 303, а не 302: после POST редирект обязан стать GET, иначе браузер
        // повторит POST на страницу сопряжения.
        return reply
          .code(303)
          .header('Cache-Control', 'no-store')
          .header('Location', `${PAIR_PATH}?next=${encodeURIComponent(safeNext(rawPath))}`)
          .send();
      }
      return reply
        .code(401)
        .header('Cache-Control', 'no-store')
        .send({ error: 'unauthorized', pair: PAIR_PATH });
    }

    request.deviceSession = session;

    // Отметка «видели» нужна экрану отзыва: по ней понятно, какой из телефонов
    // в списке живой, а какой забыт полгода назад. Пишем не чаще раза в минуту.
    try {
      touchSession(ctx.db, session, now(), ctx.cfg.sessionTtlDays);
    } catch (err) {
      // Не повод отказывать в доступе: сессия проверена, а отметка времени —
      // удобство. База может быть занята записью воркера.
      ctx.log.debug({ err }, 'не удалось обновить last_seen_at сессии');
    }
  });
}
