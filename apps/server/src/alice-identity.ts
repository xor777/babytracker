/**
 * Опознание владельца навыка: аккаунт, а не устройство.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
 *
 * Белый список читал `session.user_id` и трижды заблокировал заказчика.
 * По документации Яндекс Диалогов это поле **устарело** и идентифицирует
 * экземпляр приложения: «даже если пользователь вошёл в один и тот же аккаунт
 * в приложение Яндекс для Android и iOS, Яндекс Диалоги присвоят отдельный
 * user_id каждому из этих приложений». То есть консоль разработчика, телефон
 * и каждая колонка в доме дают РАЗНЫЕ значения — ровно те три, что видел
 * заказчик (черновик, повторная попытка, публикация).
 *
 * Правильное поле — `session.user.user_id`: «идентификатор пользователя Яндекса,
 * единый для всех приложений и устройств», приходит только для авторизованного
 * пользователя. `session.application.application_id` — актуальная замена
 * устаревшего `user_id`, но это по-прежнему идентификатор УСТРОЙСТВА.
 *
 * Отсюда модель: опознаём по аккаунту, если он есть; иначе по устройству,
 * честно понимая, что это слабее. И главное — никогда не запираем человека
 * молча: незнакомая идентичность даёт отличимый ответ, одну понятную строку
 * в лог и запись, видимую в админке.
 */

import type { Db } from './db.ts';
import { all, get, p, run } from './db.ts';
import type { AliceRequestBody } from './types.ts';
import { nowIso } from './time.ts';

export type IdentityKind = 'account' | 'device';
export type IdentityStatus = 'trusted' | 'pending';
export type IdentitySource = 'tofu' | 'api' | 'enroll' | 'promoted';

export interface AliceIdentity {
  /** `session.user.user_id` — аккаунт Яндекса, один на все устройства в доме. */
  accountId: string | null;
  /** `session.application.application_id` — устройство (актуальное поле). */
  applicationId: string | null;
  /** `session.user_id` — устаревшее, тоже устройство. Храним для диагностики. */
  legacyUserId: string | null;
  skillId: string | null;
  /** По чему опознаём: аккаунт надёжнее, устройство — запасной вариант. */
  kind: IdentityKind;
  /** Значение, по которому сверяем. null — в запросе не было вообще ничего. */
  key: string | null;
}

export interface IdentityRow {
  id: number;
  kind: string;
  identity: string;
  status: string;
  account_id: string | null;
  application_id: string | null;
  legacy_user_id: string | null;
  skill_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  source: string;
  note: string | null;
}

const COLUMNS =
  'id, kind, identity, status, account_id, application_id, legacy_user_id, skill_id, ' +
  'first_seen_at, last_seen_at, seen_count, source, note';

export const SETTING_SKILL_ID = 'alice_skill_id';
export const SETTING_ENROLL_UNTIL = 'alice_enroll_until';
/**
 * Отметка «владелец уже определён». Нужна, чтобы доверие первому срабатывало
 * РОВНО ОДИН РАЗ за жизнь установки: иначе снятие доверия у единственного
 * устройства обнуляло бы счётчик доверенных, и оно тут же доверялось снова —
 * отзыв не работал бы вовсе.
 */
export const SETTING_TRUST_ESTABLISHED = 'alice_trust_established';

/** Сколько минут держать открытым окно добавления устройства по умолчанию. */
export const ENROLL_DEFAULT_MINUTES = 10;
export const ENROLL_MAX_MINUTES = 60;

/* ------------------------------------------------------------------ */
/* Разбор запроса                                                      */
/* ------------------------------------------------------------------ */

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function extractIdentity(body: AliceRequestBody): AliceIdentity {
  const session = body.session;
  const accountId = str(session?.user?.user_id);
  const applicationId = str(session?.application?.application_id);
  const legacyUserId = str(session?.user_id);

  // Аккаунт стабилен между устройствами — предпочитаем его.
  // Устаревший user_id берём последним: это то же устройство, но старым полем.
  const deviceKey = applicationId ?? legacyUserId;

  return {
    accountId,
    applicationId,
    legacyUserId,
    skillId: str(session?.skill_id),
    kind: accountId !== null ? 'account' : 'device',
    key: accountId ?? deviceKey,
  };
}

/** Все значения идентичности из запроса — для сверки со старым ALICE_ALLOWED_USER_IDS. */
export function identityValues(identity: AliceIdentity): string[] {
  return [identity.accountId, identity.applicationId, identity.legacyUserId].filter(
    (v): v is string => v !== null,
  );
}

/** Короткое описание для лога и админки. */
export function describeIdentity(identity: AliceIdentity): string {
  return identity.kind === 'account'
    ? `аккаунт ${identity.accountId}`
    : `устройство ${identity.key ?? 'без идентификатора'}`;
}

/* ------------------------------------------------------------------ */
/* Настройки (key-value)                                               */
/* ------------------------------------------------------------------ */

export function getSetting(db: Db, key: string): string | null {
  return get<{ value: string }>(db, 'SELECT value FROM app_settings WHERE key = ?', [key])?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  run(
    db,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [p(key), p(value), p(nowIso())],
  );
}

/* ------------------------------------------------------------------ */
/* Хранилище идентичностей                                             */
/* ------------------------------------------------------------------ */

/** Доверие уже кому-то выдавалось? Тогда «первого встречного» больше не пускаем. */
export function isTrustEstablished(db: Db): boolean {
  return getSetting(db, SETTING_TRUST_ESTABLISHED) !== null;
}

export function markTrustEstablished(db: Db): void {
  if (!isTrustEstablished(db)) setSetting(db, SETTING_TRUST_ESTABLISHED, nowIso());
}

export function findIdentity(db: Db, kind: IdentityKind, value: string): IdentityRow | null {
  return (
    get<IdentityRow>(
      db,
      `SELECT ${COLUMNS} FROM alice_identities WHERE kind = ? AND identity = ?`,
      [kind, value],
    ) ?? null
  );
}

export function listIdentities(db: Db, status?: IdentityStatus): IdentityRow[] {
  return status
    ? all<IdentityRow>(
        db,
        `SELECT ${COLUMNS} FROM alice_identities WHERE status = ? ORDER BY last_seen_at DESC`,
        [status],
      )
    : all<IdentityRow>(db, `SELECT ${COLUMNS} FROM alice_identities ORDER BY last_seen_at DESC`);
}

export function countTrusted(db: Db): number {
  const row = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM alice_identities WHERE status = 'trusted'`,
  );
  return Number(row?.n ?? 0);
}

export interface RememberInput {
  identity: AliceIdentity;
  kind: IdentityKind;
  value: string;
  status: IdentityStatus;
  source: IdentitySource;
  note?: string | null;
}

/**
 * Записывает (или обновляет) идентичность. Повторная встреча только обновляет
 * счётчик и время — уже доверенную запись в pending не понижаем.
 */
export function rememberIdentity(db: Db, input: RememberInput): IdentityRow {
  const now = nowIso();
  const existing = findIdentity(db, input.kind, input.value);

  if (existing) {
    // trusted -> pending не откатываем: доверие снимается только явно
    const status = existing.status === 'trusted' ? 'trusted' : input.status;
    run(
      db,
      `UPDATE alice_identities
          SET status = ?, last_seen_at = ?, seen_count = seen_count + 1,
              account_id = COALESCE(?, account_id),
              application_id = COALESCE(?, application_id),
              legacy_user_id = COALESCE(?, legacy_user_id),
              skill_id = COALESCE(?, skill_id)
        WHERE id = ?`,
      [
        p(status),
        p(now),
        p(input.identity.accountId),
        p(input.identity.applicationId),
        p(input.identity.legacyUserId),
        p(input.identity.skillId),
        p(existing.id),
      ],
    );
    return findIdentity(db, input.kind, input.value) as IdentityRow;
  }

  run(
    db,
    `INSERT INTO alice_identities
       (kind, identity, status, account_id, application_id, legacy_user_id, skill_id,
        first_seen_at, last_seen_at, seen_count, source, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      p(input.kind),
      p(input.value),
      p(input.status),
      p(input.identity.accountId),
      p(input.identity.applicationId),
      p(input.identity.legacyUserId),
      p(input.identity.skillId),
      p(now),
      p(now),
      p(input.source),
      p(input.note ?? null),
    ],
  );
  return findIdentity(db, input.kind, input.value) as IdentityRow;
}

export function trustIdentityRow(db: Db, id: number, source: IdentitySource = 'api'): IdentityRow | null {
  const row = get<IdentityRow>(db, `SELECT ${COLUMNS} FROM alice_identities WHERE id = ?`, [id]);
  if (!row) return null;
  run(db, `UPDATE alice_identities SET status = 'trusted', source = ? WHERE id = ?`, [
    p(source),
    p(id),
  ]);
  markTrustEstablished(db);
  // Навык, с которого пришло доверенное устройство, тоже запоминаем: иначе
  // после пересоздания навыка в консоли человек снова окажется заперт.
  if (row.skill_id) setSetting(db, SETTING_SKILL_ID, row.skill_id);
  return get<IdentityRow>(db, `SELECT ${COLUMNS} FROM alice_identities WHERE id = ?`, [id]) ?? null;
}

export function revokeIdentityRow(db: Db, id: number): IdentityRow | null {
  const row = get<IdentityRow>(db, `SELECT ${COLUMNS} FROM alice_identities WHERE id = ?`, [id]);
  if (!row) return null;
  run(db, `UPDATE alice_identities SET status = 'pending' WHERE id = ?`, [p(id)]);
  return get<IdentityRow>(db, `SELECT ${COLUMNS} FROM alice_identities WHERE id = ?`, [id]) ?? null;
}

/* ------------------------------------------------------------------ */
/* Окно добавления устройства                                          */
/* ------------------------------------------------------------------ */

export function openEnrollWindow(db: Db, minutes: number, now: Date = new Date()): string {
  const clamped = Math.min(Math.max(1, Math.trunc(minutes)), ENROLL_MAX_MINUTES);
  const until = new Date(now.getTime() + clamped * 60_000).toISOString();
  setSetting(db, SETTING_ENROLL_UNTIL, until);
  return until;
}

export function closeEnrollWindow(db: Db): void {
  setSetting(db, SETTING_ENROLL_UNTIL, new Date(0).toISOString());
}

export function enrollWindowUntil(db: Db, now: Date = new Date()): string | null {
  const raw = getSetting(db, SETTING_ENROLL_UNTIL);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms) || ms <= now.getTime()) return null;
  return raw;
}
