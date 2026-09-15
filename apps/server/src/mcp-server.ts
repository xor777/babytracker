#!/usr/bin/env node
/**
 * Отдельный stdio MCP-сервер `babytracker` (§5 контракта).
 *
 * Запускается claude-CLI как дочерний процесс, работает с ТЕМ ЖЕ файлом БД
 * (поэтому WAL обязателен). Тулы — единственный способ модели трогать данные:
 * ни bash, ни записи файлов ей не даём.
 *
 * ВАЖНО: stdout занят протоколом MCP. Любой лог — только в stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.ts';
import { openDb, all } from './db.ts';
import {
  SQL_QUERY_MAX_ROWS,
  listChangeSets,
  newChangeSetId,
  revertChangeSet,
  sqlExecute,
  type JournalContext,
} from './journal.ts';
import { checkSqlQuery } from './sql-guard.ts';
import type { EventPatch } from './events.ts';
import { EVENT_TYPES, VALUE_UNITS, TAXONOMY, isEventType } from './taxonomy.ts';
import {
  clampLimit,
  dailySleep,
  getState,
  insertEvent,
  queryEvents,
  softDeleteEvent,
  updateEvent,
  EVENTS_LIMIT_DEFAULT,
  EVENTS_LIMIT_MAX,
} from './events.ts';

const ISO_HINT = 'ISO 8601 в UTC, например 2026-09-15T14:32:05.000Z';

const TOOLS: Tool[] = [
  {
    name: 'get_state',
    description:
      'Текущее состояние ребёнка: спит или бодрствует, с какого момента, сводка за сегодня, ' +
      'глубина очереди разбора. Вызывай первым, если не уверен в ситуации.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'query_events',
    description:
      'Список событий, новые сверху. Используй ОБЯЗАТЕЛЬНО перед log_event, ' +
      'чтобы не создать дубликат уже записанного события.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: `Нижняя граница started_at, ${ISO_HINT}` },
        to: { type: 'string', description: `Верхняя граница started_at, ${ISO_HINT}` },
        type: { type: 'string', enum: [...EVENT_TYPES], description: 'Тип события' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: EVENTS_LIMIT_MAX,
          description: `Сколько вернуть, по умолчанию ${EVENTS_LIMIT_DEFAULT}`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'log_event',
    description:
      'Создать событие (source=alice-llm). Только если такого события ещё нет — сначала query_events. ' +
      'Открытый сон (ended_at не задан) может быть только один: предыдущий будет закрыт автоматически.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...EVENT_TYPES], description: 'Тип события' },
        subtype: {
          type: 'string',
          description:
            Object.entries(TAXONOMY)
              .filter(([, spec]) => spec.subtypes.length > 0 || spec.freeSubtype)
              .map(([type, spec]) =>
                `${type}: ${spec.freeSubtype ? 'название препарата' : spec.subtypes.join('|')}`,
              )
              .join('; ') +
            '. Незнакомый подтип — не повод терять событие: запиши type и опиши словами в note',
        },
        started_at: { type: 'string', description: `Начало, ${ISO_HINT}. По умолчанию — сейчас` },
        ended_at: {
          type: 'string',
          description: `Конец, ${ISO_HINT}. Не задавай, если событие ещё идёт (например, начавшийся сон)`,
        },
        value_num: {
          type: 'number',
          description:
            'Числовое значение: мл, г, кг, °C, см, минуты. НЕОБЯЗАТЕЛЬНО. ' +
            'Если мама числа не называла — не указывай вовсе, не подставляй ноль',
        },
        value_unit: {
          type: 'string',
          enum: [...VALUE_UNITS],
          description: 'Единица измерения value_num',
        },
        note: { type: 'string', description: 'Свободный комментарий' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Твоя уверенность 0..1' },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_event',
    description:
      'Исправить существующее событие по id. Именно так чинят ошибки быстрого матчера ' +
      'и закрывают открытый сон (проставь ended_at). Новое событие при этом НЕ создаётся.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'id события' },
        type: { type: 'string', enum: [...EVENT_TYPES] },
        subtype: { type: ['string', 'null'] },
        started_at: { type: 'string', description: ISO_HINT },
        ended_at: { type: ['string', 'null'], description: `${ISO_HINT}; null — снова открыть событие` },
        value_num: { type: ['number', 'null'] },
        value_unit: { type: ['string', 'null'], enum: [...VALUE_UNITS, null] },
        note: { type: ['string', 'null'] },
        confidence: { type: ['number', 'null'] },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_event',
    description:
      'Мягко удалить ошибочно созданное событие по id (проставляется deleted_at). ' +
      'Используй, если быстрый матчер записал то, чего родитель не говорил.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'id события' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'sql_query',
    description:
      'Произвольный SELECT по любым таблицам базы: events, utterances, change_sets, event_revisions. ' +
      'Джойны и агрегаты можно. Один statement, не больше ' +
      `${SQL_QUERY_MAX_ROWS} строк в ответе. Только чтение — изменения через sql_execute.`,
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Текст SELECT-запроса' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'sql_execute',
    description:
      'Произвольный INSERT или UPDATE по таблице events. Один statement, выполняется в транзакции, ' +
      'все затронутые строки журналируются и могут быть отменены через revert_change_set. ' +
      'DELETE запрещён триггером базы: удаление — это UPDATE events SET deleted_at = ... ' +
      'Так делаются массовые правки: «удали всё за сегодня», «сдвинь время всех снов».',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'INSERT INTO events (...) VALUES (...) или UPDATE events SET ... WHERE ...' },
        summary: {
          type: 'string',
          description: 'Одной строкой по-русски, что делает этот запрос — попадёт в историю изменений',
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_change_sets',
    description:
      'История изменений: последние наборы с описанием, временем и списком затронутых событий. ' +
      'Отсюда берётся id для revert_change_set, когда родитель просит «отмени последнее».',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: 'revert_change_set',
    description:
      'Отменить набор изменений целиком: строки восстанавливаются из журнала ровно в том виде, ' +
      'в каком были до него. Сам откат тоже попадает в историю, поэтому отмену отмены ' +
      'тоже можно отменить.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id набора изменений' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'sleep_daily',
    description: 'Сводка сна по суткам за последние N дней (по умолчанию 14). Для проверки аномалий.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 90 } },
      additionalProperties: false,
    },
  },
];

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function arg<T>(args: Record<string, unknown> | undefined, key: string): T | undefined {
  const value = args?.[key];
  return value === undefined || value === null ? undefined : (value as T);
}

function requireId(args: Record<string, unknown> | undefined): number {
  const raw = args?.id;
  const id = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Параметр id обязателен и должен быть целым числом');
  return id;
}

export async function main(): Promise<void> {
  const cfg = loadConfig(process.env, { requireWebhookSecret: false });
  const db = openDb({ path: cfg.dbPath });

  // Все правки одного запуска модели складываются в один набор изменений:
  // его id приезжает из mcp.json, который воркер пишет перед запуском (§9.3).
  const utteranceIdRaw = Number.parseInt(process.env.BABYTRACKER_UTTERANCE_ID ?? '', 10);
  const journal: JournalContext = {
    changeSetId: process.env.BABYTRACKER_CHANGE_SET_ID ?? newChangeSetId(),
    actor: 'alice-llm',
    utteranceId: Number.isInteger(utteranceIdRaw) ? utteranceIdRaw : null,
    summary: null,
  };

  const server = new Server(
    { name: 'babytracker', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case 'get_state':
          return ok(getState(db, cfg));

        case 'query_events':
          return ok({
            events: queryEvents(db, {
              from: arg<string>(args, 'from') ?? null,
              to: arg<string>(args, 'to') ?? null,
              type: arg<string>(args, 'type') ?? null,
              limit: clampLimit(args.limit, EVENTS_LIMIT_DEFAULT, EVENTS_LIMIT_MAX),
            }),
          });

        case 'log_event': {
          const type = arg<string>(args, 'type');
          if (!isEventType(type)) {
            return fail(
              `Неизвестный type="${String(type)}". Допустимо: ${EVENT_TYPES.join(', ')}. ` +
                'Если событие не подходит ни под один тип — запиши его как note с текстом.',
            );
          }
          const { event, closedPrevious } = insertEvent(
            db,
            {
              type,
              subtype: arg<string>(args, 'subtype') ?? null,
              started_at: arg<string>(args, 'started_at') ?? null,
              ended_at: arg<string>(args, 'ended_at') ?? null,
              value_num: arg<number>(args, 'value_num') ?? null,
              value_unit: arg<string>(args, 'value_unit') ?? null,
              note: arg<string>(args, 'note') ?? null,
              confidence: arg<number>(args, 'confidence') ?? null,
              source: 'alice-llm',
              // §10.4: связь с исходной фразой — чтобы в ленте админки было
              // видно, как речь превратилась в запись. Модели об этом думать
              // не надо, проставляем сами.
              utterance_id: journal.utteranceId ?? null,
            },
            'close-previous',
            journal,
          );
          return ok({
            created: event,
            closedPrevious,
            hint: closedPrevious
              ? 'Предыдущий открытый сон закрыт автоматически — инвариант «один открытый сон».'
              : undefined,
          });
        }

        case 'update_event': {
          const id = requireId(args);
          const patch: Record<string, unknown> = {};
          for (const key of [
            'type',
            'subtype',
            'started_at',
            'ended_at',
            'value_num',
            'value_unit',
            'note',
            'confidence',
          ]) {
            if (key in args) patch[key] = args[key];
          }
          const updated = updateEvent(db, id, patch as EventPatch, journal);
          if (!updated) return fail(`Событие id=${id} не найдено или уже удалено`);
          return ok({ updated });
        }

        case 'delete_event': {
          const id = requireId(args);
          const deleted = softDeleteEvent(db, id, journal);
          if (!deleted) return fail(`Событие id=${id} не найдено или уже удалено`);
          return ok({ deleted });
        }

        case 'sql_query': {
          const sql = arg<string>(args, 'sql') ?? '';
          const check = checkSqlQuery(sql);
          if (!check.ok) return fail(`Запрос отклонён: ${check.error}`);
          const rows = all<Record<string, unknown>>(db, sql, []);
          const truncated = rows.length > SQL_QUERY_MAX_ROWS;
          return ok({
            rows: rows.slice(0, SQL_QUERY_MAX_ROWS),
            count: Math.min(rows.length, SQL_QUERY_MAX_ROWS),
            truncated,
            hint: truncated
              ? `Показаны первые ${SQL_QUERY_MAX_ROWS} строк. Добавь LIMIT или сузь условие.`
              : undefined,
          });
        }

        case 'sql_execute': {
          const sql = arg<string>(args, 'sql') ?? '';
          const summary = arg<string>(args, 'summary');
          const result = sqlExecute(db, { ...journal, summary: summary ?? journal.summary }, sql);
          if (!result.ok) return fail(`Запрос отклонён: ${result.error}`);
          return ok({
            changes: result.changes,
            change_set_id: result.changeSetId,
            touched: result.touched,
            hint:
              result.changes === 0
                ? 'Ни одна строка не подошла под условие. Проверь WHERE через sql_query.'
                : `Изменения обратимы: revert_change_set("${result.changeSetId}")`,
          });
        }

        case 'list_change_sets':
          return ok({ change_sets: listChangeSets(db, arg<number>(args, 'limit') ?? 20) });

        case 'revert_change_set': {
          const id = arg<string>(args, 'id');
          if (!id) return fail('Параметр id обязателен');
          const result = revertChangeSet(db, id, 'alice-llm');
          if (!result.ok) return fail(result.error);
          return ok({
            reverted: result.changeSetId,
            revert_change_set_id: result.revertChangeSetId,
            restored: result.restored,
            already_reverted: result.alreadyReverted,
            hint: `Этот откат тоже можно отменить: revert_change_set("${result.revertChangeSetId}")`,
          });
        }

        case 'sleep_daily':
          return ok({ days: dailySleep(db, cfg, arg<number>(args, 'days') ?? 14) });

        default:
          return fail(`Неизвестный инструмент: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[babytracker-mcp] ошибка в ${name}: ${message}\n`);
      return fail(`Ошибка: ${message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[babytracker-mcp] готов, БД: ${cfg.dbPath}\n`);

  const shutdown = (): void => {
    try {
      db.close();
    } catch {
      /* уже закрыта */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`[babytracker-mcp] фатальная ошибка: ${String(err)}\n`);
    process.exit(1);
  });
}
