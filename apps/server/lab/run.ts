/**
 * ЛАБОРАТОРИЯ (не часть сервера, в проде не используется).
 *
 * Прогоняет сценарий неоднозначной фразы через НАСТОЯЩИЙ конвейер:
 *   seed -> вебхук Алисы (fast-path пишет свою запись) -> buildPrompt ->
 *   claude -p с реальным MCP-сервером -> дамп базы.
 *
 * Работает на отдельном файле БД, прод не трогает.
 *
 * Запуск: node lab/run.ts <scenarios.json> [id ...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.ts';
import { openDb, all } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { insertEvent, getState, queryEvents } from '../src/events.ts';
import { buildPrompt } from '../src/prompt.ts';
import { listChangeSets, newChangeSetId } from '../src/journal.ts';
import { listUtterances, insertUtterance } from '../src/utterances.ts';
import { decideQueue } from '../src/queue-policy.ts';
import { matchFast } from '../src/fastpath.ts';
import { localDateISO, localDayStartMs, shiftLocalDate } from '../src/time.ts';
import type { EventRow, UtteranceRow } from '../src/types.ts';

const SECRET = '0123456789abcdef0123456789abcdef';
const LAB_DIR = process.env.LAB_DIR ?? '/tmp/ambiguity-lab';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5';
const EFFORT = process.env.CLAUDE_EFFORT ?? 'high';
const TIMEOUT_MS = Number(process.env.LAB_TIMEOUT_MS ?? 180_000);

interface SeedEvent {
  type: string;
  subtype?: string | null;
  minutesAgo?: number;
  /** Местный час начала: ближайший прошедший. Нужно для «а не в десять». */
  atLocalHour?: number;
  endAtLocalHour?: number;
  endMinutesAgo?: number | null;
  value_num?: number | null;
  value_unit?: string | null;
  note?: string | null;
  source?: string;
  confidence?: number | null;
}

interface SeedUtterance {
  text: string;
  minutesAgo: number;
  status?: string;
}

interface Scenario {
  id: string;
  title: string;
  /** Что должно получиться — глазами архитектора, для сверки в отчёте. */
  expect: string;
  seed?: SeedEvent[];
  seedUtterances?: SeedUtterance[];
  say: string;
  nlu?: Record<string, unknown>;
}

interface ToolCall {
  name: string;
  input: unknown;
  result?: string;
}

function iso(minutesAgo: number, now: Date): string {
  return new Date(now.getTime() - minutesAgo * 60_000).toISOString();
}

/** Ближайший прошедший местный час (сегодня или вчера), в ISO UTC. */
function atHour(hour: number, now: Date, tz: string): string {
  const today = localDateISO(now, tz);
  let ms = localDayStartMs(today, tz) + hour * 3_600_000;
  if (ms > now.getTime()) ms = localDayStartMs(shiftLocalDate(today, -1), tz) + hour * 3_600_000;
  return new Date(ms).toISOString();
}

function seedStart(s: SeedEvent, now: Date, tz: string): string {
  return s.atLocalHour !== undefined ? atHour(s.atLocalHour, now, tz) : iso(s.minutesAgo ?? 0, now);
}

function seedEnd(s: SeedEvent, now: Date, tz: string): string | null {
  if (s.endAtLocalHour !== undefined) return atHour(s.endAtLocalHour, now, tz);
  return s.endMinutesAgo === undefined || s.endMinutesAgo === null ? null : iso(s.endMinutesAgo, now);
}

function runClaude(prompt: string, mcpConfig: string, cwd: string): Promise<{ raw: string; ms: number }> {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', MODEL,
    '--effort', EFFORT,
    '--mcp-config', mcpConfig,
    '--allowedTools',
    [
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
    ].join(','),
    '--permission-mode', 'acceptEdits',
  ];

  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ raw: out + (err ? `\n[stderr] ${err.slice(0, 2000)}` : ''), ms: Date.now() - started });
    });
  });
}

/** Достаёт из потока stream-json вызовы тулов и финальную строку. */
function parseStream(raw: string): { tools: ToolCall[]; final: string; error: string | null } {
  const tools: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  let final = '';
  let error: string | null = null;

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(t) as Record<string, unknown>; } catch { continue; }

    if (ev.type === 'assistant') {
      const msg = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of msg?.content ?? []) {
        if (block.type === 'tool_use') {
          const call: ToolCall = {
            name: String(block.name ?? '').replace('mcp__babytracker__', ''),
            input: block.input,
          };
          tools.push(call);
          byId.set(String(block.id), call);
        }
      }
    }
    if (ev.type === 'user') {
      const msg = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of msg?.content ?? []) {
        if (block.type === 'tool_result') {
          const call = byId.get(String(block.tool_use_id));
          if (!call) continue;
          const c = block.content;
          const text = Array.isArray(c)
            ? c.map((x: Record<string, unknown>) => String(x.text ?? '')).join('')
            : String(c ?? '');
          call.result = (block.is_error ? 'ОШИБКА: ' : '') + text.slice(0, 400);
        }
      }
    }
    if (ev.type === 'result') {
      final = String(ev.result ?? '');
      if (ev.is_error === true) error = final || 'is_error';
    }
  }
  return { tools, final, error };
}

function dumpEvents(rows: EventRow[]): string[] {
  return rows.map(
    (e) =>
      `id=${e.id} ${e.type}/${e.subtype ?? '-'} ${e.started_at} -> ${e.ended_at ?? 'ОТКРЫТО'}` +
      `${e.value_num === null ? '' : ` ${e.value_num}${e.value_unit ?? ''}`}` +
      ` conf=${e.confidence ?? '-'} src=${e.source}${e.deleted_at ? ' [УДАЛЕНО]' : ''}` +
      `${e.note ? ` note="${e.note}"` : ''}`,
  );
}

async function runScenario(sc: Scenario): Promise<Record<string, unknown>> {
  const dir = path.join(LAB_DIR, sc.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'ambiguity.db');

  const cfg = loadConfig(
    {
      ALICE_WEBHOOK_SECRET: SECRET,
      TZ: 'Europe/Moscow',
      CHILD_NAME: 'Андрей',
      CHILD_BIRTHDATE: '2026-09-02',
      DB_PATH: dbPath,
      WORKER_ENABLED: 'false',
      LLM_QUEUE_POLICY: 'smart',
    } as NodeJS.ProcessEnv,
    { cwd: dir },
  );
  const db = openDb({ path: dbPath });
  const now = new Date();

  // 1. история: события и прежние фразы
  for (const s of sc.seed ?? []) {
    insertEvent(
      db,
      {
        type: s.type,
        subtype: s.subtype ?? null,
        started_at: seedStart(s, now, cfg.tz),
        ended_at: seedEnd(s, now, cfg.tz),
        value_num: s.value_num ?? null,
        value_unit: s.value_unit ?? null,
        note: s.note ?? null,
        source: (s.source ?? 'alice-fast') as 'alice-fast',
        confidence: s.confidence ?? null,
      },
      'close-previous',
      { changeSetId: newChangeSetId(), actor: 'alice-fast', utteranceId: null, summary: 'сид сценария' },
    );
  }
  for (const u of sc.seedUtterances ?? []) {
    const row = insertUtterance(db, {
      rawText: u.text,
      aliceUserId: 'lab',
      sessionId: 'lab',
      fastResult: matchFast(u.text),
      status: (u.status ?? 'done') as 'done',
    });
    db.exec(`UPDATE utterances SET received_at = '${iso(u.minutesAgo, now)}' WHERE id = ${row.id}`);
  }

  const stateBefore = getState(db, cfg);
  const eventsBefore = queryEvents(db, { limit: 50, includeDeleted: true });

  // 2. настоящий вебхук: fast-path отвечает голосом и, возможно, пишет событие
  const { app, sse } = createApp({ cfg, db, logger: false, serveStatic: false });
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: `/alice/${SECRET}`,
    payload: {
      meta: { locale: 'ru-RU', timezone: 'Europe/Moscow', interfaces: {} },
      session: { message_id: 0, session_id: 'lab', skill_id: 'lab', user_id: 'lab', new: false },
      request: {
        type: 'SimpleUtterance',
        command: sc.say,
        original_utterance: sc.say,
        nlu: sc.nlu ?? { tokens: [], entities: [], intents: {} },
      },
      version: '1.0',
    },
  });
  const voice = (res.json() as { response: { text: string } }).response.text;
  sse.close();
  await app.close();

  const utterances = listUtterances(db, 12);
  const current = utterances[0] as UtteranceRow;
  const fast = matchFast(sc.say, sc.nlu?.entities ? (sc.nlu as never) : undefined, { now, tz: cfg.tz });
  const decision = decideQueue({
    policy: cfg.llmQueuePolicy,
    threshold: cfg.llmConfidenceThreshold,
    fast,
    command: sc.say,
  });

  const fastEvent =
    all<EventRow>(db, 'SELECT * FROM events WHERE utterance_id = ? ORDER BY id DESC LIMIT 1', [current.id])[0] ?? null;

  // 3. настоящий промпт
  const changeSetId = newChangeSetId();
  const prompt = buildPrompt({
    cfg,
    rawText: sc.say,
    fast: current.fast_result ? (JSON.parse(current.fast_result) as never) : null,
    fastEvent,
    state: getState(db, cfg),
    utteranceId: current.id,
    changeSets: listChangeSets(db, 5),
    recentEvents: queryEvents(db, { limit: 20 }),
    recentUtterances: listUtterances(db, 8),
  });
  fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt, 'utf8');

  const mcpConfig = path.join(dir, 'mcp.json');
  fs.writeFileSync(
    mcpConfig,
    JSON.stringify(
      {
        mcpServers: {
          babytracker: {
            command: process.execPath,
            args: [fileURLToPath(new URL('../src/mcp-server.ts', import.meta.url))],
            env: {
              DB_PATH: dbPath,
              TZ: cfg.tz,
              CHILD_NAME: cfg.childName,
              CHILD_BIRTHDATE: cfg.childBirthDate,
              BABYTRACKER_CHANGE_SET_ID: changeSetId,
              BABYTRACKER_UTTERANCE_ID: String(current.id),
            },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  db.close();

  const { raw, ms } = await runClaude(prompt, mcpConfig, dir);
  fs.writeFileSync(path.join(dir, 'stream.jsonl'), raw, 'utf8');
  const parsed = parseStream(raw);

  const db2 = openDb({ path: dbPath });
  const eventsAfter = queryEvents(db2, { limit: 50, includeDeleted: true });
  const stateAfter = getState(db2, cfg);
  const sets = listChangeSets(db2, 5);
  db2.close();

  return {
    id: sc.id,
    title: sc.title,
    expect: sc.expect,
    say: sc.say,
    promptChars: prompt.length,
    fast: { kind: fast.kind, confidence: 'confidence' in fast ? fast.confidence : null, mayContainMore: fast.mayContainMore, timeUnresolved: fast.timeUnresolved },
    queueDecision: decision,
    utteranceStatus: current.status,
    voice,
    stateBefore: { status: stateBefore.sleep.status, since: stateBefore.sleep.since, todayMin: stateBefore.today.sleepTotalMin },
    eventsBefore: dumpEvents(eventsBefore),
    tools: parsed.tools,
    final: parsed.final,
    error: parsed.error,
    elapsedSec: Math.round(ms / 1000),
    eventsAfter: dumpEvents(eventsAfter),
    stateAfter: { status: stateAfter.sleep.status, since: stateAfter.sleep.since, todayMin: stateAfter.today.sleepTotalMin },
    changeSets: sets.map((s) => `${s.summary ?? '—'} [${s.events.join(',')}]`),
  };
}

const file = process.argv[2];
if (!file) {
  process.stderr.write('нужен путь к scenarios.json\n');
  process.exit(1);
}
const only = process.argv.slice(3);
const scenarios = (JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario[]).filter(
  (s) => only.length === 0 || only.includes(s.id),
);

const results: Record<string, unknown>[] = [];
for (const sc of scenarios) {
  process.stderr.write(`\n=== ${sc.id}: ${sc.title}\n`);
  try {
    const r = await runScenario(sc);
    results.push(r);
    process.stderr.write(`    тулов: ${(r.tools as ToolCall[]).length}, ${r.elapsedSec}s\n`);
  } catch (err) {
    process.stderr.write(`    ПАДЕНИЕ: ${String(err)}\n`);
    results.push({ id: sc.id, crash: String(err) });
  }
  fs.writeFileSync(path.join(LAB_DIR, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
}
process.stdout.write(JSON.stringify(results, null, 2));
