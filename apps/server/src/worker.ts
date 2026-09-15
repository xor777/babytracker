/**
 * Фоновый воркер: очередь фраз -> `claude -p` -> MCP-тулы -> база (§5).
 *
 * Обязательное требование контракта: **сервер работает без claude**.
 * Если CLI не установлен или не авторизован — пишем в лог ОДИН раз при старте,
 * помечаем записи `skipped` и продолжаем жить. Fast-path писать события не перестаёт.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext, WorkerStatus } from './context.ts';
import type { EventRow, FastResult, UtteranceRow } from './types.ts';
import { all } from './db.ts';
import { EVENT_COLUMNS } from './db.ts';
import { getState } from './events.ts';
import {
  MAX_ATTEMPTS,
  claimNextPending,
  finishUtterance,
  listUtterances,
  queueDepth,
  releaseUtterance,
  requeueUtterance,
  resetStaleProcessing,
  toUtteranceDto,
} from './utterances.ts';
import { buildPrompt } from './prompt.ts';
import {
  countRevisionsByActor,
  createSnapshot,
  findChangeSetByUtterance,
  listChangeSets,
  newChangeSetId,
  setChangeSetSummary,
  getChangeSet,
} from './journal.ts';
import { queryEvents } from './events.ts';

export const TICK_MS = 1_000;
/**
 * Таймаут одного запуска модели.
 *
 * В контракте (§5) стояло 60 с — этого мало. На живых прогонах неоднозначных
 * фраз (открытый сон + противоречие + разбор журнала через sql_query) Opus
 * доходил до 134 с, то есть самые сложные случаи — ровно те, ради которых
 * модель и зовут, — молча убивались по таймауту и уходили в retry.
 *
 * Разбор асинхронный, голосом уже ответили, поэтому задержка ничего не стоит;
 * цена убитого запуска — потерянный разбор. Конкурентность всё равно 1,
 * так что худшее последствие долгого запуска — очередь ждёт.
 */
export const CLAUDE_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 10_000;

/** Сколько последних фраз показывать модели: хватает, чтобы увидеть повтор. */
const PROMPT_UTTERANCES = 8;

/**
 * Уровень усилия модели (`--effort`). Закрепляем ЯВНО, а не наследуем
 * умолчание CLI: умолчание меняется между версиями молча, а этот конвейер
 * пишет данные о ребёнке — поведение не должно съезжать от обновления.
 *
 * `high` — минимум для задач, чувствительных к качеству решения; здесь модель
 * выбирает прочтение неоднозначной фразы и правит чужие данные.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const DEFAULT_EFFORT = 'high';

/**
 * Читается прямо из окружения, а не из Config, чтобы не трогать чужой модуль
 * ради одной строки. Неизвестное значение не роняет воркер: берём умолчание.
 */
export function resolveEffort(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.CLAUDE_EFFORT ?? '').trim().toLowerCase();
  if (raw.length === 0) return DEFAULT_EFFORT;
  return (EFFORT_LEVELS as readonly string[]).includes(raw) ? raw : DEFAULT_EFFORT;
}

/**
 * Всё, что модели разрешено звать. Список обязан совпадать с набором тулов
 * MCP-сервера (§9.3): тул, о котором промпт рассказывает, но который не попал
 * сюда, модель просто не сможет вызвать — и молча сделает что-то другое.
 */
export const ALLOWED_TOOLS: readonly string[] = [
  'mcp__babytracker__get_state',
  'mcp__babytracker__query_events',
  'mcp__babytracker__sleep_daily',
  'mcp__babytracker__log_event',
  'mcp__babytracker__update_event',
  'mcp__babytracker__delete_event',
  'mcp__babytracker__sql_query',
  'mcp__babytracker__sql_execute',
  'mcp__babytracker__list_change_sets',
  'mcp__babytracker__revert_change_set',
];

/**
 * Признаки того, что claude установлен, но работать не может: протухший токен,
 * отсутствующий ключ, кончившийся баланс. Такое не лечится повтором — сразу
 * помечаем CLI недоступным и перестаём жечь попытки.
 */
const AUTH_PROBLEM_RE =
  /authenticat|unauthorized|not logged in|oauth|invalid api key|no api key|credit balance|"api_error_status":\s*40[13]|please run .*login/i;

/** Как часто пробовать, не ожил ли claude (например, пользователь перелогинился). */
const REPROBE_MS = 5 * 60_000;

/**
 * Признаки исчерпанного окна лимита подписки (§9.4). Это НЕ ошибка: фраза
 * вернётся в очередь и дождётся открытия окна.
 *
 * Формулировки CLI меняются от версии к версии, поэтому смотрим на несколько
 * независимых признаков сразу, а не на одну фразу.
 */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /usage limit/i,
  /rate[ _-]?limit/i,
  /\b429\b/,
  /"?status"?\s*[:=]\s*429/i,
  /too many requests/i,
  /limit (?:reached|exceeded)/i,
  /quota (?:exceeded|exhausted)/i,
  /out of (?:usage|quota)/i,
  /will reset at/i,
  /resets? at/i,
  /слишком много запросов/i,
  /лимит/i,
];

/** Пауза при лимите без известного времени сброса: минута -> ... -> час. */
const RATE_LIMIT_BACKOFF_MIN_MS = 60_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60_000;

/**
 * Переменные, которые уводят CLI с подписки на поштучную оплату по API.
 * Дочернему процессу их не отдаём: пользователь платит за подписку и не должен
 * тарифицироваться второй раз.
 */
const BILLING_OVERRIDE_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

export function looksRateLimited(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/**
 * Пытается вытащить из ответа CLI момент открытия окна.
 * Возвращает epoch ms либо null, если время не названо.
 */
export function parseRateLimitReset(text: string, now: Date = new Date()): number | null {
  // 1. Машиночитаемое поле с unix-временем
  const unix = /"?(?:resets?_?at|reset_?time|resetsAt|resetAt)"?\s*[:=]\s*"?(\d{10,13})"?/i.exec(text);
  if (unix?.[1]) {
    const raw = Number.parseInt(unix[1], 10);
    const ms = raw > 1e12 ? raw : raw * 1000;
    if (ms > now.getTime()) return ms;
  }

  // 2. ISO-время рядом со словом reset
  const iso = /reset[^0-9]{0,24}(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)/i.exec(text);
  if (iso?.[1]) {
    const ms = Date.parse(iso[1].replace(' ', 'T'));
    if (Number.isFinite(ms) && ms > now.getTime()) return ms;
  }

  // 3. Retry-After в секундах
  const retry = /retry[-_ ]?after"?\s*[:=]\s*"?(\d{1,6})/i.exec(text);
  if (retry?.[1]) {
    const seconds = Number.parseInt(retry[1], 10);
    if (seconds > 0) return now.getTime() + seconds * 1000;
  }

  // 4. Человеческое «resets at 3pm» / «resets at 15:00»
  const human = /resets? at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (human?.[1]) {
    let hour = Number.parseInt(human[1], 10);
    const minute = human[2] ? Number.parseInt(human[2], 10) : 0;
    const suffix = human[3]?.toLowerCase();
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const target = new Date(now);
      target.setHours(hour, minute, 0, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      return target.getTime();
    }
  }

  return null;
}

export interface WorkerHandle {
  start: () => void;
  stop: () => Promise<void>;
  status: () => WorkerStatus;
  /** Сигнал «появилась новая фраза»: запускаем проход немедленно (§9.4). */
  notify: () => void;
  /** Резолвится, когда стартовая проверка claude завершена (нужно тестам). */
  ready: () => Promise<void>;
  /** Один проход очереди. Вынесен наружу ради тестов. */
  tick: () => Promise<void>;
}

interface RunResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
  authProblem?: boolean;
  rateLimited?: boolean;
  /** Момент открытия окна лимита, если CLI его назвал. */
  rateLimitResetMs?: number | null;
}

export function createWorker(ctx: AppContext): WorkerHandle {
  const { cfg, db, log } = ctx;

  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  let started = false;
  let stopping = false;
  let lastRunAt: string | null = null;
  let claudeAvailable = false;
  let claudeProblem: string | null = null;
  let problemLogged = false;
  let lastProbeAt = 0;
  let rateLimitedUntil: number | null = null;
  let rateLimitReason: string | null = null;
  let rateLimitBackoffMs = 0;
  let runtimeDirCache: string | null = null;
  let current: { kill: () => void } | null = null;
  let readyPromise: Promise<void> = Promise.resolve();

  /**
   * Куда класть mcp.json и откуда запускать claude — рядом с файлом БД.
   * Для БД в памяти (тесты) берём временный каталог, иначе мусор летит в cwd,
   * то есть прямо в репозиторий.
   */
  function runtimeDir(): string {
    if (runtimeDirCache) return runtimeDirCache;
    runtimeDirCache =
      cfg.dbPath === ':memory:'
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'babytracker-'))
        : path.dirname(cfg.dbPath);
    fs.mkdirSync(runtimeDirCache, { recursive: true });
    return runtimeDirCache;
  }

  /** Логируем проблему с claude ровно один раз — иначе зальём лог на проде. */
  function reportProblem(reason: string): void {
    claudeAvailable = false;
    // claude умеет вывалить простыню JSON; в /healthz нужна читаемая причина
    claudeProblem = reason.length > 300 ? `${reason.slice(0, 299)}…` : reason;
    if (problemLogged) return;
    problemLogged = true;
    log.warn(
      { claudeBin: cfg.claudeBin, reason },
      'worker: claude CLI недоступен — фразы будут помечаться skipped. ' +
        'Сервер и fast-path работают как обычно.',
    );
  }

  /**
   * mcp.json пишется перед каждым запуском: в нём едет id набора изменений,
   * чтобы все правки одного запуска модели легли в один change_set (§9.3).
   */
  function writeMcpConfig(changeSetId?: string, utteranceId?: number): string {
    const target = path.join(runtimeDir(), 'mcp.json');
    const serverEntry = fileURLToPath(new URL('./mcp-server.ts', import.meta.url));
    const config = {
      mcpServers: {
        babytracker: {
          command: process.execPath,
          args: [serverEntry],
          env: {
            DB_PATH: cfg.dbPath,
            TZ: cfg.tz,
            CHILD_NAME: cfg.childName,
            CHILD_BIRTHDATE: cfg.childBirthDate,
            ...(changeSetId ? { BABYTRACKER_CHANGE_SET_ID: changeSetId } : {}),
            ...(utteranceId !== undefined
              ? { BABYTRACKER_UTTERANCE_ID: String(utteranceId) }
              : {}),
          },
        },
      },
    };
    fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return target;
  }

  /**
   * Вход в состояние «окно лимита исчерпано». Одна строка в лог на вход,
   * без спама на каждую попытку.
   */
  function enterRateLimit(reason: string, resetMs: number | null): void {
    const wasLimited = rateLimitedUntil !== null && Date.now() < rateLimitedUntil;

    if (resetMs && resetMs > Date.now()) {
      // CLI назвал время открытия окна — ждём ровно до него
      rateLimitedUntil = resetMs;
      rateLimitBackoffMs = 0;
    } else {
      // время неизвестно: экспоненциальная пауза от минуты до часа
      rateLimitBackoffMs =
        rateLimitBackoffMs === 0
          ? RATE_LIMIT_BACKOFF_MIN_MS
          : Math.min(rateLimitBackoffMs * 2, RATE_LIMIT_BACKOFF_MAX_MS);
      rateLimitedUntil = Date.now() + rateLimitBackoffMs;
    }

    rateLimitReason = reason.length > 300 ? `${reason.slice(0, 299)}\u2026` : reason;

    if (!wasLimited) {
      log.warn(
        {
          until: new Date(rateLimitedUntil).toISOString(),
          waitSec: Math.round((rateLimitedUntil - Date.now()) / 1000),
          knownResetTime: Boolean(resetMs),
        },
        'worker: окно лимита подписки исчерпано, пауза. Фразы остаются в очереди и не расходуют попытки.',
      );
    }
  }

  function leaveRateLimit(): void {
    if (rateLimitedUntil === null) return;
    log.info(
      { pausedForSec: 0 },
      'worker: окно лимита подписки открылось, продолжаем разбор очереди',
    );
    rateLimitedUntil = null;
    rateLimitReason = null;
  }

  function isRateLimited(): boolean {
    if (rateLimitedUntil === null) return false;
    if (Date.now() >= rateLimitedUntil) {
      leaveRateLimit();
      return false;
    }
    return true;
  }

  /** Рубеж 3 (§9.1): снимок базы перед каждым запуском модели. */
  function snapshotBeforeRun(): void {
    try {
      const file = createSnapshot(db, cfg.dbPath);
      if (file) log.debug({ snapshot: file }, 'worker: снимок базы сделан');
    } catch (err) {
      // Снимок — страховка, а не условие работы: не смогли — идём дальше.
      log.warn({ err }, 'worker: не удалось сделать снимок базы');
    }
  }

  async function probeClaude(): Promise<void> {
    lastProbeAt = Date.now();
    const result = await runProcess(cfg.claudeBin, ['--version'], PROBE_TIMEOUT_MS, null);
    if (result.ok) {
      const recovered = problemLogged;
      claudeAvailable = true;
      claudeProblem = null;
      problemLogged = false;
      log.info(
        { version: String(result.payload ?? '').trim(), recovered },
        recovered ? 'worker: claude CLI снова доступен' : 'worker: claude CLI найден',
      );
      return;
    }
    reportProblem(result.error ?? 'неизвестная ошибка запуска claude');
  }

  /** Запуск процесса с таймаутом. Ошибки не всплывают наружу — только в RunResult. */
  function runProcess(
    bin: string,
    args: string[],
    timeoutMs: number,
    cwd: string | null,
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      let child;
      const env = { ...process.env };
      // Секрет вебхука дочерним процессам не отдаём.
      delete env.ALICE_WEBHOOK_SECRET;
      // И не даём CLI уйти с подписки на поштучную оплату по API (§9.4).
      for (const key of BILLING_OVERRIDE_ENV) delete env[key];

      try {
        child = spawn(bin, args, {
          cwd: cwd ?? undefined,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ ok: false, error: `не удалось запустить ${bin}: ${errText(err)}` });
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const finish = (res: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer2);
        current = null;
        resolve(res);
      };

      const timer2 = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // не ушёл по-хорошему — добиваем
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 2_000).unref();
      }, timeoutMs);
      timer2.unref();

      current = { kill: () => child.kill('SIGKILL') };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        const reason =
          err.code === 'ENOENT'
            ? `исполняемый файл "${bin}" не найден`
            : `ошибка запуска "${bin}": ${errText(err)}`;
        finish({ ok: false, error: reason });
      });

      child.on('close', (code) => {
        if (timedOut) {
          finish({ ok: false, error: `таймаут ${Math.round(timeoutMs / 1000)} с, процесс убит` });
          return;
        }
        const combined = `${stdout}\n${stderr}`;
        if (code === 0) {
          finish({ ok: true, payload: stdout });
          return;
        }
        const rateLimited = looksRateLimited(combined);
        finish({
          ok: false,
          error: `код выхода ${code}: ${(stderr || stdout).trim().slice(0, 1000)}`,
          // лимит проверяем первым: 429 — это «позже», а не «сломалось»
          authProblem: !rateLimited && AUTH_PROBLEM_RE.test(combined),
          rateLimited,
          rateLimitResetMs: rateLimited ? parseRateLimitReset(combined) : null,
        });
      });
    });
  }

  function fastEventFor(utteranceId: number): EventRow | null {
    const rows = all<EventRow>(
      db,
      `SELECT ${EVENT_COLUMNS} FROM events WHERE utterance_id = ? ORDER BY id DESC LIMIT 1`,
      [utteranceId],
    );
    return rows[0] ?? null;
  }

  function parseFast(raw: string | null): FastResult | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FastResult;
    } catch {
      return null;
    }
  }

  async function processOne(utterance: UtteranceRow): Promise<void> {
    if (!claudeAvailable) {
      const row = finishUtterance(db, utterance.id, {
        status: 'skipped',
        llmError: claudeProblem ?? 'claude CLI недоступен',
      });
      if (row) ctx.sse.broadcastUtterance(toUtteranceDto(row));
      return;
    }

    const runStartedAt = new Date().toISOString();

    // §10.3: все события ОДНОЙ фразы — в один набор изменений. Быстрый матчер
    // уже мог завести набор по этой фразе; дописываем в него, а не заводим свой,
    // иначе «отмени последнее» откатит только половину сказанного.
    const changeSetId =
      findChangeSetByUtterance(db, utterance.id)?.id ?? newChangeSetId();

    snapshotBeforeRun();

    const prompt = buildPrompt({
      cfg,
      rawText: utterance.raw_text,
      fast: parseFast(utterance.fast_result),
      fastEvent: fastEventFor(utterance.id),
      state: getState(db, cfg),
      utteranceId: utterance.id,
      changeSets: listChangeSets(db, 5),
      recentEvents: queryEvents(db, { limit: 20 }),
      // Без истории фраз не отличить «случилось дважды» от «сказали дважды».
      recentUtterances: listUtterances(db, PROMPT_UTTERANCES),
    });

    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--model',
      cfg.claudeModel,
      '--effort',
      resolveEffort(),
      '--mcp-config',
      writeMcpConfig(changeSetId, utterance.id),
      '--allowedTools',
      ALLOWED_TOOLS.join(','),
      '--permission-mode',
      'acceptEdits',
    ];

    const result = await runProcess(cfg.claudeBin, args, CLAUDE_TIMEOUT_MS, runtimeDir());

    if (result.ok) {
      // успешный вызов = окно открыто, экспоненту сбрасываем
      rateLimitBackoffMs = 0;
      leaveRateLimit();
      const payload = parseClaudeJson(String(result.payload ?? ''));
      if (payload.isError) {
        finishFailure(utterance, payload.error ?? 'claude вернул is_error');
      } else {
        const row = finishUtterance(db, utterance.id, { status: 'done', llmResult: payload.value });
        if (row) ctx.sse.broadcastUtterance(toUtteranceDto(row));
        // Модель описывает одной строкой, что сделала — кладём это в набор изменений,
        // чтобы «отмени последнее» показывало человекочитаемую историю.
        rememberSummary(changeSetId, payload.value);
      }
    } else if (result.rateLimited) {
      // Лимит — это «позже»: фраза возвращается в очередь, попытка НЕ сгорает.
      enterRateLimit(result.error ?? 'лимит подписки', result.rateLimitResetMs ?? null);
      const until = rateLimitedUntil ? new Date(rateLimitedUntil).toISOString() : 'позже';
      const row = releaseUtterance(
        db,
        utterance.id,
        `окно лимита подписки исчерпано, повтор после ${until}`,
      );
      if (row) ctx.sse.broadcastUtterance(toUtteranceDto(row));
      return;
    } else {
      if (result.authProblem) reportProblem(result.error ?? 'claude не авторизован');
      finishFailure(utterance, result.error ?? 'неизвестная ошибка');
    }

    broadcastChangedEvents(runStartedAt);
    ctx.sse.broadcastState(getState(db, cfg));
  }

  /** Записывает итоговую строку модели в summary набора изменений, если он появился. */
  function rememberSummary(changeSetId: string, payload: unknown): void {
    try {
      if (!getChangeSet(db, changeSetId)) return; // набор так и не появился
      // Набор мог быть создан быстрым матчером: если модель в него ничего не
      // добавила, её «ничего не изменил» затрёт осмысленное описание — не трогаем.
      if (countRevisionsByActor(db, changeSetId, 'alice-llm') === 0) return;
      const result =
        payload && typeof payload === 'object' && 'result' in payload
          ? String((payload as { result: unknown }).result ?? '')
          : '';
      if (result.trim().length > 0) setChangeSetSummary(db, changeSetId, result.trim());
    } catch (err) {
      log.warn({ err }, 'worker: не удалось сохранить описание набора изменений');
    }
  }

  function finishFailure(utterance: UtteranceRow, error: string): void {
    // attempts уже увеличен при claim; 3 попытки — и в failed.
    const exhausted = utterance.attempts >= MAX_ATTEMPTS || !claudeAvailable;
    const row = exhausted
      ? finishUtterance(db, utterance.id, {
          status: claudeAvailable ? 'failed' : 'skipped',
          llmError: error.slice(0, 2000),
        })
      : requeueUtterance(db, utterance.id, error);
    log.warn(
      { utteranceId: utterance.id, attempts: utterance.attempts, error, exhausted },
      'worker: разбор фразы не удался',
    );
    if (row) ctx.sse.broadcastUtterance(toUtteranceDto(row));
  }

  /** События, которые модель успела создать/поправить через MCP, — в SSE. */
  function broadcastChangedEvents(sinceIso: string): void {
    try {
      const rows = all<EventRow>(
        db,
        `SELECT ${EVENT_COLUMNS} FROM events WHERE updated_at >= ? ORDER BY id ASC LIMIT 50`,
        [sinceIso],
      );
      for (const row of rows) {
        const action = row.deleted_at ? 'deleted' : row.created_at >= sinceIso ? 'created' : 'updated';
        ctx.sse.broadcastEvent(action, row);
      }
    } catch (err) {
      log.error({ err }, 'worker: не удалось разослать изменения событий');
    }
  }

  async function tick(): Promise<void> {
    if (busy || stopping) return;
    busy = true;
    try {
      lastRunAt = new Date().toISOString();

      // Пауза из-за лимита подписки: очередь не трогаем вообще, чтобы не
      // отбирать фразу у следующего окна и не долбить CLI впустую.
      if (isRateLimited()) return;

      // claude мог ожить: пользователь перелогинился, поставил CLI. Проверяем
      // раз в несколько минут, чтобы не требовать рестарта сервера.
      if (!claudeAvailable && Date.now() - lastProbeAt > REPROBE_MS) {
        await probeClaude();
      }

      const utterance = claimNextPending(db);
      if (!utterance) return;
      await processOne(utterance);
    } catch (err) {
      // Ошибки воркера НИКОГДА не роняют сервер.
      log.error({ err }, 'worker: необработанная ошибка в цикле');
    } finally {
      busy = false;
    }
  }

  /**
   * Немедленный запуск прохода: фраза только что попала в очередь (§9.4).
   * Опрос по таймеру остаётся подстраховкой на случай потерянного сигнала.
   */
  function notify(): void {
    if (!cfg.workerEnabled || stopping || busy) return;
    if (rateLimitedUntil !== null && Date.now() < rateLimitedUntil) return;
    setImmediate(() => {
      void tick();
    });
  }

  function start(): void {
    if (started) return;
    started = true;

    try {
      const reset = resetStaleProcessing(db);
      if (reset > 0) log.info({ reset }, 'worker: зависшие фразы возвращены в очередь');
      writeMcpConfig();
    } catch (err) {
      log.error({ err }, 'worker: подготовка не удалась');
    }

    const billingOverrides = BILLING_OVERRIDE_ENV.filter((key) => {
      const value = process.env[key];
      return typeof value === 'string' && value.trim().length > 0;
    });
    if (billingOverrides.length > 0) {
      log.warn(
        { variables: billingOverrides },
        'worker: в окружении есть переменные, уводящие claude с подписки на поштучную оплату по API. ' +
          'Дочернему процессу они не передаются, но уберите их из окружения сервиса — ' +
          'иначе легко заплатить дважды.',
      );
    }

    if (!cfg.workerEnabled) {
      log.info('worker: выключен через WORKER_ENABLED=false');
      return;
    }

    readyPromise = probeClaude().then(() => {
      if (stopping) return;
      timer = setInterval(() => {
        void tick();
      }, TICK_MS);
      timer.unref();
    });
    void readyPromise;
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    current?.kill();
    // даём текущему проходу завершиться
    for (let i = 0; busy && i < 100; i++) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  }

  function status(): WorkerStatus {
    return {
      enabled: cfg.workerEnabled,
      alive: cfg.workerEnabled ? started && timer !== null : false,
      lastRunAt,
      queueDepth: safeQueueDepth(),
      claudeAvailable,
      claudeProblem,
      rateLimited: rateLimitedUntil !== null && Date.now() < rateLimitedUntil,
      rateLimitedUntil: rateLimitedUntil === null ? null : new Date(rateLimitedUntil).toISOString(),
      rateLimitReason,
    };
  }

  function safeQueueDepth(): number {
    try {
      return queueDepth(db);
    } catch {
      return 0;
    }
  }

  return { start, stop, status, tick, notify, ready: () => readyPromise };
}

interface ClaudeJson {
  value: unknown;
  isError: boolean;
  error?: string;
}

/** `claude -p --output-format json` отдаёт объект с полями result/is_error. */
export function parseClaudeJson(stdout: string): ClaudeJson {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { value: null, isError: true, error: 'пустой ответ claude' };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const isError = parsed.is_error === true || parsed.subtype === 'error';
    return {
      value: parsed,
      isError,
      error: isError ? String(parsed.result ?? parsed.error ?? 'is_error') : undefined,
    };
  } catch {
    // не JSON — сохраняем как есть, это всё равно полезно для разбора
    return { value: { result: trimmed.slice(0, 4000) }, isError: false };
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
