/**
 * Чтение и валидация окружения (§8 контракта).
 *
 * Принципы:
 *  - падаем на старте с понятным текстом, а не в рантайме на первом запросе;
 *  - секрет вебхука НИКОГДА не попадает в логи и в сообщения об ошибках;
 *  - конфиг — обычный объект, который явно прокидывается в модули (удобно для тестов).
 */

import path from 'node:path';
import process from 'node:process';

export interface Config {
  port: number;
  host: string;
  tz: string;
  dbPath: string;
  aliceWebhookSecret: string;
  aliceSkillId: string | null;
  aliceAllowedUserIds: string[];
  /**
   * Сверять ли идентичность вызывающего. Настоящая защита вебхука — 32-символьный
   * секрет в пути; идентичность это второй рубеж на случай его утечки. Если он
   * начнёт мешать больше, чем защищать, его можно выключить одной переменной,
   * не выкатывая код: обращения продолжат записываться и будут видны в админке.
   */
  aliceIdentityCheck: boolean;
  childName: string;
  childBirthDate: string;
  claudeBin: string;
  claudeModel: string;
  workerEnabled: boolean;
  dashboardOrigin: string[];
  /** Собранный дашборд для телевизора — раздаётся по «/». */
  dashboardDist: string;
  /** Собранная админка — раздаётся по «/dash». */
  adminDist: string;
  llmQueuePolicy: LlmQueuePolicy;
  llmConfidenceThreshold: number;

  /* --- §11: авторизация устройств по коду --------------------------- */
  /**
   * Ставить ли на куку сессии флаг Secure. По умолчанию да, и менять это
   * в бою нельзя: без Secure кука уходит по http в открытом виде.
   * Выключается только для локальной разработки без TLS, и сервер об этом
   * предупреждает в лог при каждом старте.
   */
  authCookieSecure: boolean;
  /** Срок жизни короткого кода сопряжения, секунды (RFC 8628 §5.4). */
  pairCodeTtlSec: number;
  /**
   * Скользящий срок сессии телефона в днях. Сессия телевизора бессрочна
   * независимо от этого значения — см. `sessionExpiry` в device-auth.ts.
   */
  sessionTtlDays: number;
}

/** §9.4: когда вообще звать модель. */
export type LlmQueuePolicy = 'smart' | 'all' | 'unknown';

export const LLM_QUEUE_POLICIES: readonly LlmQueuePolicy[] = ['smart', 'all', 'unknown'];

export interface LoadConfigOptions {
  /** MCP-серверу секрет вебхука не нужен и не передаётся. */
  requireWebhookSecret?: boolean;
  /** Базовая директория для относительных путей (по умолчанию — cwd процесса). */
  cwd?: string;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      'Некорректная конфигурация окружения:\n' +
        problems.map((p) => `  • ${p}`).join('\n') +
        '\nСм. .env.example в корне репозитория и §8 docs/CONTRACT.md.',
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const HEX32 = /^[0-9a-fA-F]{32}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

function list(env: NodeJS.ProcessEnv, key: string): string[] {
  return str(env, key, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): Config {
  const requireSecret = options.requireWebhookSecret ?? true;
  const cwd = options.cwd ?? process.cwd();
  const problems: string[] = [];

  const portRaw = str(env, 'PORT', '8787');
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT="${portRaw}" — ожидается целое число 1..65535`);
  }

  const tz = str(env, 'TZ', 'Europe/Moscow');
  if (!isValidTimeZone(tz)) {
    problems.push(`TZ="${tz}" — неизвестная таймзона IANA (например: Europe/Moscow)`);
  }

  const secret = str(env, 'ALICE_WEBHOOK_SECRET', '');
  if (requireSecret) {
    if (secret === '') {
      problems.push(
        'ALICE_WEBHOOK_SECRET не задан. Сгенерировать: openssl rand -hex 16',
      );
    } else if (!HEX32.test(secret)) {
      // В тексте ошибки — только длина, сам секрет не показываем.
      problems.push(
        `ALICE_WEBHOOK_SECRET должен быть 32 hex-символа (получено символов: ${secret.length})`,
      );
    }
  }

  const birthDate = str(env, 'CHILD_BIRTHDATE', '2026-03-01');
  if (!ISO_DATE.test(birthDate) || Number.isNaN(Date.parse(`${birthDate}T00:00:00Z`))) {
    problems.push(`CHILD_BIRTHDATE="${birthDate}" — ожидается дата в формате YYYY-MM-DD`);
  }

  const workerRaw = str(env, 'WORKER_ENABLED', 'true').toLowerCase();
  if (!['true', 'false', '1', '0', 'yes', 'no'].includes(workerRaw)) {
    problems.push(`WORKER_ENABLED="${workerRaw}" — ожидается true/false`);
  }

  const policyRaw = str(env, 'LLM_QUEUE_POLICY', 'all').toLowerCase();
  if (!LLM_QUEUE_POLICIES.includes(policyRaw as LlmQueuePolicy)) {
    problems.push(
      `LLM_QUEUE_POLICY="${policyRaw}" — ожидается ${LLM_QUEUE_POLICIES.join(' | ')}`,
    );
  }

  const thresholdRaw = str(env, 'LLM_CONFIDENCE_THRESHOLD', '0.8');
  const threshold = Number.parseFloat(thresholdRaw);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    problems.push(`LLM_CONFIDENCE_THRESHOLD="${thresholdRaw}" — ожидается число от 0 до 1`);
  }

  const codeTtlRaw = str(env, 'PAIR_CODE_TTL_SEC', '600');
  const codeTtl = Number.parseInt(codeTtlRaw, 10);
  // Нижняя граница не придирка: за минуту человек не успеет дойти до телефона,
  // и сопряжение превратится в бесконечную смену кодов на экране.
  if (!Number.isInteger(codeTtl) || codeTtl < 60 || codeTtl > 3600) {
    problems.push(`PAIR_CODE_TTL_SEC="${codeTtlRaw}" — ожидается целое число секунд 60..3600`);
  }

  const sessionTtlRaw = str(env, 'SESSION_TTL_DAYS', '90');
  const sessionTtl = Number.parseInt(sessionTtlRaw, 10);
  if (!Number.isInteger(sessionTtl) || sessionTtl < 1 || sessionTtl > 3650) {
    problems.push(`SESSION_TTL_DAYS="${sessionTtlRaw}" — ожидается целое число дней 1..3650`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const dbPathRaw = str(env, 'DB_PATH', './data/babytracker.db');
  const dashboardDistRaw = str(
    env,
    'DASHBOARD_DIST',
    path.resolve(cwd, '..', 'dashboard', 'dist'),
  );
  const adminDistRaw = str(env, 'ADMIN_DIST', path.resolve(cwd, '..', 'admin', 'dist'));

  return {
    port,
    host: str(env, 'HOST', '0.0.0.0'),
    tz,
    // ':memory:' — особый путь SQLite, резолвить его нельзя
    dbPath:
      dbPathRaw === ':memory:' || path.isAbsolute(dbPathRaw)
        ? dbPathRaw
        : path.resolve(cwd, dbPathRaw),
    aliceWebhookSecret: secret,
    aliceSkillId: str(env, 'ALICE_SKILL_ID', '') || null,
    aliceAllowedUserIds: list(env, 'ALICE_ALLOWED_USER_IDS'),
    aliceIdentityCheck: !['false', '0', 'no'].includes(
      str(env, 'ALICE_IDENTITY_CHECK', 'true').toLowerCase(),
    ),
    childName: str(env, 'CHILD_NAME', 'Андрей'),
    childBirthDate: birthDate,
    claudeBin: str(env, 'CLAUDE_BIN', 'claude'),
    claudeModel: str(env, 'CLAUDE_MODEL', 'claude-opus-5'),
    workerEnabled: ['true', '1', 'yes'].includes(workerRaw),
    dashboardOrigin: list(env, 'DASHBOARD_ORIGIN'),
    dashboardDist: path.isAbsolute(dashboardDistRaw)
      ? dashboardDistRaw
      : path.resolve(cwd, dashboardDistRaw),
    adminDist: path.isAbsolute(adminDistRaw) ? adminDistRaw : path.resolve(cwd, adminDistRaw),
    llmQueuePolicy: policyRaw as LlmQueuePolicy,
    llmConfidenceThreshold: threshold,
    // Небезопасное значение приходится задавать явным словом: случайная опечатка
    // в переменной не должна тихо снять Secure с куки сессии.
    authCookieSecure: str(env, 'AUTH_COOKIE_SECURE', 'true').toLowerCase() !== 'false',
    pairCodeTtlSec: codeTtl,
    sessionTtlDays: sessionTtl,
  };
}
