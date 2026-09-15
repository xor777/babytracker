/**
 * Управление доступом с сервера — то, чем развязывается замкнутый круг.
 *
 * Круг такой: одобрять устройства можно только из админки, а админка сама за
 * дверью. Первое устройство одобрять некому.
 *
 * Развязка — не лазейка в HTTP, а команда здесь. Разница принципиальная:
 * лазейка в приложении остаётся открытой всегда и для всех, кто нашёл её
 * адрес, а эта команда требует ssh на сервер. Тот, у кого есть ssh, и так
 * может открыть файл БД — новых прав команда не даёт, она лишь избавляет
 * от необходимости писать SQL руками.
 *
 * Запуск (из ~/babytracker/apps/server):
 *   node --env-file-if-exists=.env src/auth-cli.ts <команда>
 * или через pnpm:
 *   pnpm --filter @babytracker/server auth <команда>
 */

import process from 'node:process';
import { ConfigError, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import {
  CODE_TTL_SEC,
  DEVICE_KINDS,
  PHONE_SESSION_TTL_DAYS,
  approveCode,
  denyCode,
  findPendingByUserCode,
  formatUserCode,
  isWellFormedUserCode,
  issueSession,
  listPendingCodes,
  listSessions,
  normalizeUserCode,
  parseDeviceKind,
  revokeSession,
  type DeviceKind,
} from './device-auth.ts';

const USAGE = `
Управление доступом устройств (§11 контракта).

  pending                       кто ждёт одобрения прямо сейчас
  approve <КОД|id>              одобрить заявку — по коду с экрана или по id
  deny <id>                     отклонить заявку
  list [--all]                  подключённые устройства (--all: и отозванные)
  revoke <id>                   отозвать устройство
  issue [--kind K] [--label L]  выпустить сессию напрямую, БЕЗ кода

Первый вход после переезда на новую схему:

  1. Открой дневник на телефоне — увидишь код сопряжения.
  2. ssh на сервер и:  pnpm --filter @babytracker/server auth approve XXXX-XXXX
  3. Телефон подхватит сессию сам, в течение пяти секунд.

Дальше все остальные устройства одобряются с телефона, без ssh.
`.trim();

/* ------------------------------------------------------------------ */

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function fail(text: string): never {
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

/** Локальное время: человек за ssh читает вывод глазами, а не парсером. */
function when(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString('ru-RU');
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

function flag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1] ?? null;
}

/* ------------------------------------------------------------------ */

export function runAuthCli(argv: string[]): void {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(USAGE);
    return;
  }

  let cfg;
  try {
    // Секрет вебхука этой команде не нужен: она не принимает запросов Алисы.
    cfg = loadConfig(process.env, { requireWebhookSecret: false });
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }

  const db = openDb({ path: cfg.dbPath });

  try {
    switch (command) {
      case 'pending':
        return cmdPending(db);
      case 'approve':
        return cmdApprove(db, argv[1]);
      case 'deny':
        return cmdDeny(db, argv[1]);
      case 'list':
        return cmdList(db, argv.includes('--all'));
      case 'revoke':
        return cmdRevoke(db, argv[1]);
      case 'issue':
        return cmdIssue(db, argv, cfg.sessionTtlDays);
      default:
        fail(`Неизвестная команда «${command}».\n\n${USAGE}`);
    }
  } finally {
    db.close();
  }
}

type Database = ReturnType<typeof openDb>;

function cmdPending(db: Database): void {
  const rows = listPendingCodes(db);
  if (rows.length === 0) {
    out('Никто не ждёт одобрения.');
    out('');
    out(`Откройте дневник на устройстве — оно покажет код (он живёт ${CODE_TTL_SEC / 60} минут).`);
    return;
  }
  out(`Ждут одобрения (${rows.length}):`);
  out('');
  for (const row of rows) {
    const left = Math.max(0, Math.round((Date.parse(row.expires_at) - Date.now()) / 1000));
    out(`  id=${row.id}  ${formatUserCode(row.user_code)}  ${row.label ?? row.kind}`);
    out(`      запрошено ${when(row.created_at)} (${ago(row.created_at)}), осталось ${left} с`);
  }
  out('');
  out('Одобрить:  auth approve <КОД>   (или auth approve <id>)');
}

function cmdApprove(db: Database, raw: string | undefined): void {
  if (!raw) fail('Нужен код или id заявки: auth approve XXXX-XXXX');

  // Сначала пробуем как код — так им и пользуются: код виден на экране.
  const code = normalizeUserCode(raw);
  let row = isWellFormedUserCode(code) ? findPendingByUserCode(db, code) : null;

  // Голое число — это id из вывода `pending`.
  if (!row && /^[1-9][0-9]*$/.test(raw)) {
    const byId = approveCode(db, Number(raw), 'cli');
    if (byId) {
      out(`Одобрено: ${formatUserCode(byId.user_code)} (${byId.label ?? byId.kind}).`);
      out('Устройство подхватит сессию в течение нескольких секунд.');
      return;
    }
    fail(`Заявка id=${raw} не найдена, уже разобрана или истекла.`);
  }

  if (!row) {
    fail(
      `Код «${raw}» не ждёт одобрения.\n` +
        'Проверьте, что код набран верно и не истёк: auth pending',
    );
  }

  const approved = approveCode(db, row.id, 'cli');
  if (!approved) fail('Заявка исчезла прямо во время одобрения — попробуйте ещё раз.');

  out(`Одобрено: ${formatUserCode(approved.user_code)} (${approved.label ?? approved.kind}).`);
  out('Устройство подхватит сессию в течение нескольких секунд.');
}

function cmdDeny(db: Database, raw: string | undefined): void {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) fail('Нужен id заявки: auth deny 3');
  const row = denyCode(db, Number(raw));
  if (!row) fail(`Заявка id=${raw} не найдена.`);
  out(`Отклонено: id=${row.id}.`);
}

function cmdList(db: Database, all: boolean): void {
  const rows = listSessions(db, all);
  if (rows.length === 0) {
    out('Подключённых устройств нет.');
    return;
  }
  out(`Устройства (${rows.length}):`);
  out('');
  for (const row of rows) {
    const state = row.revoked_at ? `ОТОЗВАНО ${when(row.revoked_at)}` : 'активно';
    const expiry = row.expires_at ? `до ${when(row.expires_at)}` : 'бессрочно';
    out(`  id=${row.id}  ${row.label ?? row.kind}  [${row.kind}]  ${state}`);
    out(`      вошло ${when(row.created_at)}, видели ${ago(row.last_seen_at)}, ${expiry}`);
  }
  out('');
  out('Отозвать:  auth revoke <id>');
}

function cmdRevoke(db: Database, id: string | undefined): void {
  if (!id) fail('Нужен id устройства: auth revoke a1b2c3d4e5f6a7b8');
  const row = revokeSession(db, id);
  if (!row) fail(`Устройство id=${id} не найдено.`);
  out(`Отозвано: ${row.label ?? row.kind} (id=${row.id}).`);
  out('');
  out('ВАЖНО: уже открытый поток событий рвёт работающий сервер, а не эта команда.');
  out('Если сервер сейчас запущен, отзывайте из админки — там разрыв мгновенный.');
  out('Иначе перезапустите сервер: systemctl --user restart babytracker');
}

function cmdIssue(db: Database, argv: string[], defaultTtlDays: number): void {
  const kindRaw = flag(argv, 'kind') ?? 'browser';
  if (!(DEVICE_KINDS as readonly string[]).includes(kindRaw)) {
    fail(`--kind должен быть одним из: ${DEVICE_KINDS.join(', ')}`);
  }
  const kind: DeviceKind = parseDeviceKind(kindRaw);
  const label = flag(argv, 'label') ?? 'Выпущено с сервера';

  const { token, session } = issueSession(db, {
    kind,
    label,
    ttlDays: defaultTtlDays || PHONE_SESSION_TTL_DAYS,
  });

  out(`Сессия выпущена: id=${session.id}, тип ${session.kind}, ${label}`);
  out(session.expires_at ? `Истекает: ${when(session.expires_at)}` : 'Бессрочно (до отзыва)');
  out('');
  out('СЕКРЕТ (показывается один раз, в базе его нет — только sha256):');
  out('');
  out(`  ${token}`);
  out('');
  out('Проверить curl-ом:');
  out(`  curl -s --cookie "bt_session=${token}" https://<домен>/api/state`);
  out('');
  out('Обычный путь входа — код сопряжения (auth approve). Эта команда нужна');
  out('для отладки и на случай, когда браузера под рукой нет вовсе.');
}

/* ------------------------------------------------------------------ */

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  runAuthCli(process.argv.slice(2));
}
