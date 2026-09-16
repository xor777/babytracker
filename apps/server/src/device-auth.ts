/**
 * Авторизация устройств по коду (§11 контракта) — device flow в духе RFC 8628.
 *
 * Мы не OAuth-сервер: ни client_id, ни bearer-токенов, ни scope здесь нет.
 * Заимствована форма потока и, что важнее, её защитные свойства:
 *
 *  - ДВА кода вместо одного. `device_code` — 256-битный секрет, его никто не
 *    видит и по нему идёт опрос. `user_code` — короткий, его читают с экрана
 *    телевизора через комнату. Опрос по короткому коду означал бы, что перебор
 *    восьми символов отдаёт чужую сессию (RFC 8628 §5.1 против §5.2);
 *  - короткий код одноразовый и живёт минуты, а не часы (§5.4: чем дольше он
 *    жив, тем полезнее он тому, кто подсмотрел его или выманил);
 *  - алфавит base-20 из §6.1 — латиница без гласных. Гласные выброшены не
 *    только чтобы не складывались слова: вместе с ними уходят O и I, а цифр
 *    в наборе нет вовсе, поэтому спутать 0 с O и 1 с I или l физически не на чем.
 *
 * Сессии хранятся хешами. Утечка файла БД не даёт войти: в таблице лежит
 * sha256, а не то, что отправляет браузер.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { all, get, p, run, type Db, type SqlParam } from './db.ts';

/* ------------------------------------------------------------------ */
/* Константы протокола                                                 */
/* ------------------------------------------------------------------ */

/**
 * RFC 8628 §6.1: A–Z без гласных. Ровно 20 символов, отсюда «base-20».
 * 8 значимых символов дают 20^8 ≈ 34.5 бита — столько же, сколько в примере
 * самого RFC («WDJB-MJHT»).
 */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const USER_CODE_LENGTH = 8;

/** Длинный секрет для опроса: 32 байта = 256 бит (RFC 8628 §5.2 — «very high entropy»). */
const DEVICE_CODE_BYTES = 32;
/** Секрет сессии той же длины: он живёт дольше кода и стоит дороже. */
const SESSION_TOKEN_BYTES = 32;

/**
 * Срок жизни короткого кода. RFC §5.4 требует компромисса: достаточно, чтобы
 * дойти до телефона и одобрить, и достаточно мало, чтобы код, подсмотренный
 * или выманенный, быстро протух. Десять минут — с запасом на то и другое.
 */
export const CODE_TTL_SEC = 600;

/** RFC 8628 §3.2: если сервер не назвал интервал, клиент обязан взять 5 секунд. */
export const POLL_INTERVAL_SEC = 5;

/** RFC 8628 §3.5: `slow_down` увеличивает интервал на 5 секунд — накопительно. */
export const SLOW_DOWN_STEP_SEC = 5;

/** Потолок интервала: дальше наращивать бессмысленно, клиент и так наказан. */
const MAX_INTERVAL_SEC = 60;

/** Допуск к интервалу опроса: сеть и таймеры не обязаны попадать в миллисекунду. */
const POLL_TOLERANCE_MS = 500;

/**
 * Срок жизни сессии телефона — скользящий, от последнего обращения.
 * Телевизор живёт бессрочно, см. `sessionExpiry`.
 */
export const PHONE_SESSION_TTL_DAYS = 90;

/**
 * Как часто обновлять `last_seen_at`. Писать на каждый запрос нельзя: дашборд
 * телевизора ходит за состоянием десятки раз в минуту, и это была бы запись
 * в базу на каждый его вздох.
 */
const TOUCH_THROTTLE_MS = 60_000;

/**
 * Имя куки сессии.
 *
 * Их два, и это не прихоть. Префикс `__Host-` — это обещание браузеру и
 * требование к нему одновременно: такую куку нельзя поставить ни с соседнего
 * поддомена, ни с другим `Path`, ни без `Secure`. Без него сосед по домену
 * (что-нибудь ещё на nuanu.ai) мог бы подбросить `bt_session=…; Path=/dash`,
 * и браузер отправил бы ЕЁ вперёд настоящей — по RFC 6265 более длинный Path
 * идёт первым. Это фиксация сессии, и `__Host-` закрывает её на корню.
 *
 * Но требование `Secure` жёсткое: по http браузер такую куку просто выбросит.
 * Поэтому при выключенном `Secure` (только локальная разработка без TLS)
 * имя обычное — иначе вход на localhost перестал бы работать вовсе.
 */
export const SESSION_COOKIE_HOST = '__Host-bt_session';
export const SESSION_COOKIE_PLAIN = 'bt_session';

/** Как называется кука при таких настройках. */
export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_HOST : SESSION_COOKIE_PLAIN;
}

/** Совместимость: имя по умолчанию для тестов и старого кода. */
export const SESSION_COOKIE = SESSION_COOKIE_PLAIN;

/* ------------------------------------------------------------------ */
/* Типы                                                                */
/* ------------------------------------------------------------------ */

/**
 * Тип устройства — только подпись в списке, не проверка. Заказчик знает всех
 * по именам, поэтому опознавать устройство по отпечаткам незачем (и вредно:
 * это была бы бюрократия вместо защиты).
 */
export type DeviceKind = 'tv' | 'phone' | 'browser';

export const DEVICE_KINDS: readonly DeviceKind[] = ['tv', 'phone', 'browser'];

export interface SessionRow {
  id: string;
  token_hash: string;
  kind: string;
  label: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface DeviceCodeRow {
  id: number;
  device_code_hash: string;
  user_code: string;
  kind: string;
  label: string | null;
  user_agent: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  approved_by: string | null;
  claimed_at: string | null;
  session_id: string | null;
  last_polled_at: string | null;
  interval_sec: number;
}

const SESSION_COLUMNS =
  'id, token_hash, kind, label, user_agent, created_at, last_seen_at, expires_at, revoked_at';

const CODE_COLUMNS =
  'id, device_code_hash, user_code, kind, label, user_agent, status, created_at, expires_at, ' +
  'approved_at, approved_by, claimed_at, session_id, last_polled_at, interval_sec';

/* ------------------------------------------------------------------ */
/* Коды                                                                */
/* ------------------------------------------------------------------ */

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Длинный секрет: base64url без набивки, 32 байта энтропии. */
export function newDeviceCode(): string {
  return randomBytes(DEVICE_CODE_BYTES).toString('base64url');
}

export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * Короткий код. `randomBytes` вместо Math.random — не из суеверия: это
 * единственное, что стоит между чужим устройством и журналом ребёнка.
 *
 * Модуль от байта дал бы перекос (256 не делится на 20 нацело), поэтому
 * байты вне кратного диапазона отбрасываем.
 */
export function newUserCode(length = USER_CODE_LENGTH): string {
  const alphabet = USER_CODE_ALPHABET;
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Код для показа: тире посередине (RFC §6.1 — «dashes added for end-user
 * readability»). С трёх метров группа из четырёх читается заметно легче.
 */
export function formatUserCode(code: string): string {
  if (code.length !== USER_CODE_LENGTH) return code;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Нормализация введённого кода — дословно по RFC §6.1: убрать пунктуацию,
 * которую сервер сам и добавил, привести к верхнему регистру, выбросить всё,
 * чего в алфавите нет (иначе случайный пробел делает верный код неверным).
 */
export function normalizeUserCode(raw: string): string {
  const upper = raw.toUpperCase();
  let out = '';
  for (const ch of upper) {
    if (USER_CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

export function isWellFormedUserCode(normalized: string): boolean {
  return normalized.length === USER_CODE_LENGTH;
}

/* ------------------------------------------------------------------ */
/* Время                                                               */
/* ------------------------------------------------------------------ */

export function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

function plusSec(now: number, sec: number): string {
  return new Date(now + sec * 1000).toISOString();
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* Ограничитель частоты                                                */
/* ------------------------------------------------------------------ */

/**
 * Фиксированные окна в памяти процесса.
 *
 * Почему не в БД: счётчик попыток — не данные о ребёнке, терять его не жалко,
 * а запись в SQLite на каждый запрос ради этого — плохой размен. Слабое место
 * честное: перезапуск сервера обнуляет окна. Это приемлемо, потому что
 * перезапуск — событие редкое и не подконтрольное тому, кто перебирает код,
 * а сам код живёт десять минут и после одобрения гаснет.
 */
export class RateLimiter {
  #hits = new Map<string, { count: number; resetAt: number }>();
  #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  /** true — запрос разрешён; false — окно исчерпано. */
  take(key: string, limit: number, windowMs: number): boolean {
    const now = this.#clock();
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + windowMs });
      this.#sweep(now);
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  /** Сколько секунд ждать до открытия окна (для заголовка Retry-After). */
  retryAfterSec(key: string): number {
    const entry = this.#hits.get(key);
    if (!entry) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - this.#clock()) / 1000));
  }

  /**
   * Вернуть одну попытку в окно.
   *
   * Не то же самое, что `reset`: сброс окна целиком превратил бы жёсткий
   * предел в амортизированный. Имея возможность завести себе заявку (эндпоинт
   * открыт), перебирающий получал бы схему «пять неверных, одно верное своё,
   * снова пять» — то есть впятеро больше попыток, чем задумано.
   */
  refund(key: string): void {
    const entry = this.#hits.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  reset(key?: string): void {
    if (key === undefined) this.#hits.clear();
    else this.#hits.delete(key);
  }

  /** Без уборки карта растёт на каждый новый ip и живёт до перезапуска. */
  #sweep(now: number): void {
    if (this.#hits.size < 512) return;
    for (const [key, entry] of this.#hits) {
      if (entry.resetAt <= now) this.#hits.delete(key);
    }
  }
}

/** Ориентиры RFC 8628 §5.1: за время жизни кода — единицы попыток, не тысячи. */
export const LIMITS = {
  /** Заводить новые коды: защита от заваливания экрана одобрения мусором. */
  start: { limit: 10, windowMs: 5 * 60_000 },
  /** Опрос: интервал держит `slow_down`, это лишь грубый потолок сверху. */
  poll: { limit: 120, windowMs: 60_000 },
  /**
   * Ввод короткого кода руками. Пять попыток за окно — ровно та цифра, при
   * которой RFC §5.1 считает перебор 20^8 бессмысленным.
   */
  guess: { limit: 5, windowMs: 15 * 60_000 },
} as const;

/* ------------------------------------------------------------------ */
/* Сессии                                                              */
/* ------------------------------------------------------------------ */

export function parseDeviceKind(raw: unknown): DeviceKind {
  return typeof raw === 'string' && (DEVICE_KINDS as readonly string[]).includes(raw)
    ? (raw as DeviceKind)
    : 'browser';
}

/**
 * Когда сессия истекает сама.
 *
 * Телевизор — `null`, то есть никогда. Он висит на стене и показывает
 * дневник сутками; протухшая сессия означала бы, что однажды утром вместо
 * журнала там код сопряжения. Единственный способ его отключить — отзыв.
 *
 * Телефон — скользящее окно от последнего обращения. Телефон теряют и
 * продают, телевизор со стены — нет. При этом окно скользящее, а не
 * абсолютное: телефон, которым пользуются каждый день, не разлогинится
 * никогда, а забытый планшет сам перестанет быть ключом. Отзыв остаётся
 * главным инструментом, срок — лишь страховка на случай «потерял и молчу».
 */
export function sessionExpiry(kind: DeviceKind, now: number, ttlDays: number): string | null {
  if (kind === 'tv') return null;
  return new Date(now + ttlDays * 86_400_000).toISOString();
}

export interface IssueSessionOptions {
  kind: DeviceKind;
  label?: string | null;
  userAgent?: string | null;
  ttlDays?: number;
  now?: number;
}

export interface IssuedSession {
  /** Секрет для куки. В базе его нет — только sha256. */
  token: string;
  session: SessionRow;
}

export function issueSession(db: Db, options: IssueSessionOptions): IssuedSession {
  const now = options.now ?? Date.now();
  const token = newSessionToken();
  const id = randomBytes(8).toString('hex');
  const iso = nowIso(now);
  const expiresAt = sessionExpiry(options.kind, now, options.ttlDays ?? PHONE_SESSION_TTL_DAYS);

  run(
    db,
    `INSERT INTO device_sessions
       (id, token_hash, kind, label, user_agent, created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      sha256(token),
      options.kind,
      p(options.label ?? null),
      p(clip(options.userAgent, 300)),
      iso,
      iso,
      p(expiresAt),
    ],
  );

  const session = getSessionById(db, id);
  if (!session) throw new Error('сессия не записалась');
  return { token, session };
}

export function getSessionById(db: Db, id: string): SessionRow | undefined {
  return get<SessionRow>(db, `SELECT ${SESSION_COLUMNS} FROM device_sessions WHERE id = ?`, [id]);
}

/**
 * Найти живую сессию по секрету из куки.
 *
 * Поиск идёт по хешу, поэтому в базе нечего красть, а сравнение выполняет
 * индекс SQLite. Отдельный constant-time-сравниватель здесь не нужен: по
 * времени поиска в индексе 256-битный секрет не восстанавливают.
 */
export function lookupSession(db: Db, token: string, now: number = Date.now()): SessionRow | null {
  if (!token) return null;
  const row = get<SessionRow>(
    db,
    `SELECT ${SESSION_COLUMNS} FROM device_sessions WHERE token_hash = ?`,
    [sha256(token)],
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  const expires = ms(row.expires_at);
  if (expires !== null && expires <= now) return null;
  return row;
}

/**
 * Отметить, что сессию только что видели, и подвинуть скользящий срок.
 * Возвращает true, если действительно писали в базу.
 */
export function touchSession(
  db: Db,
  session: SessionRow,
  now: number = Date.now(),
  ttlDays = PHONE_SESSION_TTL_DAYS,
): boolean {
  const seen = ms(session.last_seen_at) ?? 0;
  if (now - seen < TOUCH_THROTTLE_MS) return false;

  const iso = nowIso(now);
  // Бессрочной сессии (телевизор) срок не трогаем: null так и остаётся null.
  const expiresAt =
    session.expires_at === null
      ? null
      : sessionExpiry(parseDeviceKind(session.kind), now, ttlDays);

  run(db, 'UPDATE device_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [
    iso,
    p(expiresAt),
    session.id,
  ]);
  return true;
}

export function revokeSession(db: Db, id: string, now: number = Date.now()): SessionRow | null {
  const row = getSessionById(db, id);
  if (!row) return null;
  if (row.revoked_at) return row;
  run(db, 'UPDATE device_sessions SET revoked_at = ? WHERE id = ?', [nowIso(now), id]);
  return getSessionById(db, id) ?? null;
}

export function listSessions(db: Db, includeRevoked = false): SessionRow[] {
  const where = includeRevoked ? '' : 'WHERE revoked_at IS NULL';
  return all<SessionRow>(
    db,
    `SELECT ${SESSION_COLUMNS} FROM device_sessions ${where} ORDER BY last_seen_at DESC`,
  );
}

/** Живые сессии: не отозваны и не просрочены. Для списка «кто сейчас имеет доступ». */
export function listLiveSessions(db: Db, now: number = Date.now()): SessionRow[] {
  return listSessions(db, false).filter((row) => {
    const expires = ms(row.expires_at);
    return expires === null || expires > now;
  });
}

/* ------------------------------------------------------------------ */
/* Заявки на сопряжение                                                */
/* ------------------------------------------------------------------ */

export interface StartPairingOptions {
  kind: DeviceKind;
  label?: string | null;
  userAgent?: string | null;
  now?: number;
  ttlSec?: number;
}

export interface StartedPairing {
  /** Секрет для опроса. Пользователю не показывается никогда (RFC §3.3). */
  deviceCode: string;
  userCode: string;
  row: DeviceCodeRow;
  expiresIn: number;
  interval: number;
}

export function startPairing(db: Db, options: StartPairingOptions): StartedPairing {
  const now = options.now ?? Date.now();
  const ttl = options.ttlSec ?? CODE_TTL_SEC;
  const deviceCode = newDeviceCode();

  /*
   * Столкновение коротких кодов при 20^8 маловероятно, но «маловероятно» —
   * не «невозможно»: два одновременно ждущих устройства с одним кодом означали
   * бы, что одобрение уходит не тому.
   *
   * Судья здесь — частичный UNIQUE-индекс по `pending`, а не предварительный
   * SELECT. Проверка чтением и индекс расходятся в одном месте: просроченная
   * заявка остаётся `pending` в таблице, пока её кто-нибудь не опросит, — для
   * чтения она «свободна», для индекса занята. Поэтому не спрашиваем, а
   * пробуем вставить и ловим отказ.
   */
  let userCode = '';
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = newUserCode();
    try {
      run(
        db,
        `INSERT INTO device_codes
           (device_code_hash, user_code, kind, label, user_agent, status, created_at, expires_at,
            approved_at, approved_by, claimed_at, session_id, last_polled_at, interval_sec)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
        [
          sha256(deviceCode),
          candidate,
          options.kind,
          p(options.label ?? null),
          p(clip(options.userAgent, 300)),
          nowIso(now),
          plusSec(now, ttl),
          POLL_INTERVAL_SEC,
        ],
      );
      userCode = candidate;
      break;
    } catch (err) {
      lastError = err;
      // Занятым может оказаться только короткий код: длинный — 256 бит.
      if (!/UNIQUE|constraint/i.test(String(err))) throw err;
    }
  }
  if (!userCode) {
    throw new Error(`не удалось выдать свободный код сопряжения: ${String(lastError)}`);
  }

  const row = get<DeviceCodeRow>(
    db,
    `SELECT ${CODE_COLUMNS} FROM device_codes WHERE device_code_hash = ?`,
    [sha256(deviceCode)],
  );
  if (!row) throw new Error('заявка на сопряжение не записалась');

  return {
    deviceCode,
    userCode,
    row,
    expiresIn: ttl,
    interval: POLL_INTERVAL_SEC,
  };
}

/**
 * Сколько ЖДУЩИХ заявок разрешено держать одновременно.
 *
 * Это единственный предел, который нельзя обойти подделкой адреса: ограничитель
 * частоты ключуется по `X-Forwarded-For`, а он за доверенным прокси приходит
 * от клиента. Здесь же счёт идёт по самой таблице, и сколько бы адресов ни
 * перебрал заваливающий, экран одобрения не превратится в простыню, а таблица
 * не станет расти без края.
 *
 * Двадцать — с большим запасом: в семье устройств единицы, а заявка живёт
 * десять минут.
 */
export const MAX_PENDING_CODES = 20;

/**
 * Прибраться в таблице заявок.
 *
 * Делает две вещи: помечает просроченные ждущие как `expired` (иначе они
 * занимают короткий код в частичном индексе, хотя давно мертвы) и удаляет
 * старые завершённые. Удаление здесь безопасно — это не `events`, и триггера
 * §9 на этой таблице нет: заявка на сопряжение не история ребёнка.
 */
export function pruneCodes(db: Db, now: number = Date.now(), keepDays = 7): number {
  run(db, `UPDATE device_codes SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`, [
    nowIso(now),
  ]);
  const cutoff = new Date(now - keepDays * 86_400_000).toISOString();
  const res = run(
    db,
    `DELETE FROM device_codes WHERE status IN ('claimed', 'denied', 'expired') AND created_at < ?`,
    [cutoff],
  );
  return res.changes;
}

/** Сколько заявок ждёт одобрения прямо сейчас (после уборки просроченных). */
export function countPendingCodes(db: Db, now: number = Date.now()): number {
  return listPendingCodes(db, now).length;
}

export function getCodeById(db: Db, id: number): DeviceCodeRow | undefined {
  return get<DeviceCodeRow>(db, `SELECT ${CODE_COLUMNS} FROM device_codes WHERE id = ?`, [id]);
}

/**
 * Найти ждущую заявку по короткому коду.
 *
 * Только `pending` и только не просроченные: одобрить можно лишь то, что
 * прямо сейчас кто-то ждёт. Уже одобренная или погашенная заявка по коду
 * не находится — это и делает короткий код одноразовым.
 */
export function findPendingByUserCode(
  db: Db,
  userCode: string,
  now: number = Date.now(),
): DeviceCodeRow | null {
  const row = get<DeviceCodeRow>(
    db,
    `SELECT ${CODE_COLUMNS} FROM device_codes WHERE user_code = ? AND status = 'pending'`,
    [userCode],
  );
  if (!row) return null;
  const expires = ms(row.expires_at);
  if (expires !== null && expires <= now) return null;
  return row;
}

export function listPendingCodes(db: Db, now: number = Date.now()): DeviceCodeRow[] {
  return all<DeviceCodeRow>(
    db,
    `SELECT ${CODE_COLUMNS} FROM device_codes WHERE status = 'pending' ORDER BY created_at DESC`,
  ).filter((row) => {
    const expires = ms(row.expires_at);
    return expires === null || expires > now;
  });
}

export function approveCode(
  db: Db,
  id: number,
  approvedBy: string,
  now: number = Date.now(),
): DeviceCodeRow | null {
  const row = getCodeById(db, id);
  if (!row || row.status !== 'pending') return null;
  const expires = ms(row.expires_at);
  if (expires !== null && expires <= now) return null;

  run(
    db,
    `UPDATE device_codes SET status = 'approved', approved_at = ?, approved_by = ?
     WHERE id = ? AND status = 'pending'`,
    [nowIso(now), approvedBy, id],
  );
  return getCodeById(db, id) ?? null;
}

export function denyCode(db: Db, id: number, now: number = Date.now()): DeviceCodeRow | null {
  const row = getCodeById(db, id);
  if (!row || (row.status !== 'pending' && row.status !== 'approved')) return null;
  run(db, `UPDATE device_codes SET status = 'denied', approved_at = ? WHERE id = ?`, [
    nowIso(now),
    id,
  ]);
  return getCodeById(db, id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Опрос устройством                                                   */
/* ------------------------------------------------------------------ */

/** Коды ошибок — дословно RFC 8628 §3.5. */
export type PollError = 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token';

export type PollResult =
  | { ok: true; token: string; session: SessionRow; code: DeviceCodeRow }
  | { ok: false; error: PollError; interval: number };

export interface PollOptions {
  now?: number;
  ttlDays?: number;
}

/**
 * Обмен `device_code` на сессию.
 *
 * Всё, что не «одобрено прямо сейчас», отвечает одной из четырёх ошибок RFC и
 * НИЧЕГО не рассказывает сверх этого: несуществующий код и протухший код
 * отвечают одинаково, иначе перебор получил бы подсказку «такой код есть».
 */
export function pollForSession(db: Db, deviceCode: string, options: PollOptions = {}): PollResult {
  const now = options.now ?? Date.now();
  const row = get<DeviceCodeRow>(
    db,
    `SELECT ${CODE_COLUMNS} FROM device_codes WHERE device_code_hash = ?`,
    [sha256(deviceCode)],
  );

  // Кода нет вовсе — отвечаем как на протухший. Разница видна только тому,
  // кто подбирает, и подсказывать ему нечего.
  if (!row) return { ok: false, error: 'expired_token', interval: POLL_INTERVAL_SEC };

  const interval = Math.max(POLL_INTERVAL_SEC, row.interval_sec || POLL_INTERVAL_SEC);

  /*
   * Истечение проверяем ПЕРВЫМ. Иначе мёртвый код при частом опросе отвечал бы
   * `slow_down` вместо `expired_token` — и клиент, послушно замедляясь, ждал бы
   * у заведомо закрытой двери вместо того, чтобы взять новый код.
   */
  const expires = ms(row.expires_at);
  if (expires !== null && expires <= now) {
    if (row.status === 'pending') {
      run(db, `UPDATE device_codes SET status = 'expired' WHERE id = ?`, [row.id]);
    }
    return { ok: false, error: 'expired_token', interval };
  }

  /*
   * Слишком частый опрос: RFC §3.5 требует не отказать, а замедлить, и
   * увеличение интервала остаётся навсегда, а не только на этот запрос.
   *
   * Допуск в полсекунды — не послабление. Мы сами назвали клиенту интервал,
   * а сеть и таймеры дают разброс: пришедший на 4990 мс вместо 5000 выполнил
   * договор, и наказывать его постоянной прибавкой не за что. Без допуска
   * аккуратный клиент разгонял бы себе интервал до потолка на ровном месте.
   */
  const lastPolled = ms(row.last_polled_at);
  if (lastPolled !== null && now - lastPolled < interval * 1000 - POLL_TOLERANCE_MS) {
    const next = Math.min(MAX_INTERVAL_SEC, interval + SLOW_DOWN_STEP_SEC);
    run(db, 'UPDATE device_codes SET interval_sec = ?, last_polled_at = ? WHERE id = ?', [
      next,
      nowIso(now),
      row.id,
    ]);
    return { ok: false, error: 'slow_down', interval: next };
  }

  run(db, 'UPDATE device_codes SET last_polled_at = ? WHERE id = ?', [nowIso(now), row.id]);

  if (row.status === 'denied') return { ok: false, error: 'access_denied', interval };
  if (row.status === 'expired') return { ok: false, error: 'expired_token', interval };

  // Заявка уже обменена на сессию. Второй раз — нет: иначе подсмотренный
  // однажды device_code давал бы новую сессию когда угодно.
  if (row.status === 'claimed') return { ok: false, error: 'expired_token', interval };

  if (row.status !== 'approved') {
    return { ok: false, error: 'authorization_pending', interval };
  }

  const issued = issueSession(db, {
    kind: parseDeviceKind(row.kind),
    label: row.label,
    userAgent: row.user_agent,
    ttlDays: options.ttlDays ?? PHONE_SESSION_TTL_DAYS,
    now,
  });

  const changed = run(
    db,
    `UPDATE device_codes SET status = 'claimed', claimed_at = ?, session_id = ?
     WHERE id = ? AND status = 'approved'`,
    [nowIso(now), issued.session.id, row.id],
  );
  // Кто-то успел забрать заявку между чтением и записью — сессию отзываем,
  // чтобы одна заявка не породила две.
  if (changed.changes === 0) {
    revokeSession(db, issued.session.id, now);
    return { ok: false, error: 'expired_token', interval };
  }

  const code = getCodeById(db, row.id);
  return { ok: true, token: issued.token, session: issued.session, code: code ?? row };
}

/* ------------------------------------------------------------------ */
/* Мелочи                                                              */
/* ------------------------------------------------------------------ */

function clip(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Сравнение секретов постоянного времени. В самом потоке не используется
 * (поиск идёт по хешу в индексе), но нужно там, где секрет приходится
 * сверять напрямую — например, в CLI.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Все значения куки с данным именем, в порядке присылки.
 *
 * Именно ВСЕ, а не первое. Браузер вправе прислать несколько кук с одним
 * именем — например, если кто-то подбросил свою с другим `Path`, — и по
 * RFC 6265 вперёд идёт более специфичная. Возвращая только первую, мы бы
 * позволили мусорной куке заслонить настоящую сессию, и человек получил бы
 * необъяснимое «сессия завершена» на ровном месте.
 *
 * Отдельная зависимость ради этого разбора не нужна.
 */
export function readCookies(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const found: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      found.push(decodeURIComponent(raw));
    } catch {
      found.push(raw);
    }
  }
  return found;
}

/** Первое значение куки. Оставлено для мест, где множественность не важна. */
export function readCookie(header: string | undefined, name: string): string | null {
  return readCookies(header, name)[0] ?? null;
}

/**
 * Найти живую сессию по любому из предъявленных секретов.
 *
 * Перебираются оба имени куки (с префиксом `__Host-` и без) и все значения
 * каждого: устройство могло войти до смены настроек `Secure`, а чужая кука
 * не должна заслонять свою.
 */
export function lookupSessionFromCookies(
  db: Db,
  header: string | undefined,
  now: number = Date.now(),
): SessionRow | null {
  for (const name of [SESSION_COOKIE_HOST, SESSION_COOKIE_PLAIN]) {
    for (const token of readCookies(header, name)) {
      const session = lookupSession(db, token, now);
      if (session) return session;
    }
  }
  return null;
}

export interface CookieOptions {
  secure: boolean;
  maxAgeSec?: number | null;
}

/**
 * Сборка Set-Cookie.
 *
 * HttpOnly — чтобы скрипт на странице не мог прочитать сессию;
 * SameSite=Lax — чтобы чужой сайт не сходил по ссылке от нашего имени,
 *   но переход по обычной ссылке на дашборд работал;
 * Secure — чтобы кука не ушла по http. Отключается только для локальной
 *   разработки, и сервер об этом громко предупреждает на старте.
 */
export function buildSessionCookie(token: string, options: CookieOptions): string {
  const parts = [
    `${sessionCookieName(options.secure)}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  if (options.maxAgeSec === null || options.maxAgeSec === undefined) {
    // Без Max-Age кука сессионная и умрёт вместе с окном браузера. Телевизору
    // это не годится, поэтому срок ставим всегда — просто очень длинный.
    parts.push(`Max-Age=${10 * 365 * 86_400}`);
  } else {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`);
  }
  return parts.join('; ');
}

/**
 * Гашение куки.
 *
 * Гасим ОБА имени: устройство могло войти до того, как поменялась настройка
 * `Secure`, и оставшаяся кука под вторым именем означала бы «вышел, но всё
 * ещё внутри». Возвращается список — на один ответ ставится несколько
 * заголовков Set-Cookie.
 */
export function clearSessionCookies(options: CookieOptions): string[] {
  return [SESSION_COOKIE_HOST, SESSION_COOKIE_PLAIN].map((name) => {
    const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    // `__Host-` без Secure браузер не примет — значит и не погасит.
    if (options.secure || name === SESSION_COOKIE_HOST) parts.push('Secure');
    return parts.join('; ');
  });
}

/** Гашение одной куки — той, которой пользуются при текущих настройках. */
export function clearSessionCookie(options: CookieOptions): string {
  const parts = [
    `${sessionCookieName(options.secure)}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Ответ списку устройств: без хешей и без секретов. */
export interface SessionDto {
  id: string;
  kind: string;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  current: boolean;
}

export function toSessionDto(row: SessionRow, currentId: string | null): SessionDto {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    current: row.id === currentId,
  };
}

/**
 * Ждущая заявка глазами одобряющего: тип, время и сколько ей осталось.
 *
 * Кода здесь НЕТ, и это главное свойство этой структуры, а не экономия полей.
 *
 * Одобрение требует набрать код с экрана устройства (RFC 8628 §3.3: сервер
 * «prompts the end user to identify the device authorization session by
 * entering the user_code»). Смысл у этого ровно один: чтобы одобрить, надо
 * было ФИЗИЧЕСКИ ВИДЕТЬ экран того, кого одобряешь. Стоит отдать код в этом
 * ответе — и свойство исчезает: код можно списать из списка и одобрить чужое
 * устройство, ни разу на него не взглянув. Тогда набор кода превращается в
 * ту же кнопку «Одобрить», только в три движения вместо одного.
 *
 * Поэтому список отвечает на единственный вопрос, который у ждущего человека
 * есть: «заявка вообще дошла?» — и молчит о том, какой у неё код.
 */
export interface PendingDto {
  id: number;
  kind: string;
  label: string | null;
  requestedAt: string;
  expiresAt: string;
  secondsLeft: number;
}

export function toPendingDto(row: DeviceCodeRow, now: number = Date.now()): PendingDto {
  const expires = ms(row.expires_at) ?? now;
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    requestedAt: row.created_at,
    expiresAt: row.expires_at,
    secondsLeft: Math.max(0, Math.round((expires - now) / 1000)),
  };
}

export type { SqlParam };
