# @babytracker/server

Бэкенд BabyTracker: вебхук Яндекс Диалогов, REST + SSE для дашборда, фоновый разбор фраз
через `claude -p`, отдельный MCP-сервер и раздача собранного дашборда статикой.

Контракт, которому всё здесь подчиняется: [`../../docs/CONTRACT.md`](../../docs/CONTRACT.md).

## Требования

- **Node >= 24.** Используется встроенный `node:sqlite` (`DatabaseSync`), а не `better-sqlite3`:
  на проде нет C++ тулчейна и мало диска, нативный модуль там не соберётся.
- pnpm 10.
- TypeScript исполняется Node напрямую (type stripping) — шага сборки нет,
  `pnpm typecheck` только проверяет типы.

## Запуск

```bash
cd apps/server
pnpm install

# минимум для локального старта
export ALICE_WEBHOOK_SECRET=$(openssl rand -hex 16)
pnpm dev          # с автоперезапуском
# или
pnpm start
```

Сервер слушает `0.0.0.0:8787`. Файл `.env` рядом с `package.json` подхватывается автоматически
(`--env-file-if-exists`); за образец возьмите `../../.env.example`.

## Переменные окружения

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `PORT` | `8787` | Порт HTTP |
| `HOST` | `0.0.0.0` | Интерфейс |
| `TZ` | `Europe/Moscow` | Таймзона **представления**. В БД всегда ISO 8601 UTC |
| `DB_PATH` | `./data/babytracker.db` | Файл SQLite (WAL). Каталог создаётся сам |
| `ALICE_WEBHOOK_SECRET` | — | **Обязательна.** 32 hex-символа, часть URL вебхука. `openssl rand -hex 16` |
| `ALICE_SKILL_ID` | пусто | Если задан — запросы с чужим `skill_id` отклоняются |
| `ALICE_ALLOWED_USER_IDS` | пусто | Список через запятую. Пусто = режим первичной настройки: принимаем всех и пишем увиденный `user_id` в лог |
| `CHILD_NAME` | `Андрей` | Имя в ответах Алисы и на дашборде |
| `CHILD_BIRTHDATE` | `2026-03-01` | Для расчёта возраста |
| `CLAUDE_BIN` | `claude` | Путь к CLI. Нет CLI — сервер всё равно работает |
| `CLAUDE_MODEL` | `claude-opus-5` | Модель для `claude -p`. Вызовы идут через подписку (OAuth), не по API-ключу |
| `WORKER_ENABLED` | `true` | Выключает фоновый разбор |
| `LLM_QUEUE_POLICY` | `smart` | Когда звать модель: `smart` / `all` / `unknown` (§9.4) |
| `LLM_CONFIDENCE_THRESHOLD` | `0.8` | Ниже этой уверенности fast-path зовём модель |
| `DASHBOARD_ORIGIN` | пусто | Разрешённые CORS-origin через запятую (для Vite на 5173). Пусто или `*` = разрешать всем |
| `DASHBOARD_DIST` | `../dashboard/dist` | Каталог собранного дашборда для раздачи статикой |
| `LOG_LEVEL` | `info` | Уровень pino |

Секрет вебхука **не попадает в логи**: URL `/alice/<secret>` маскируется в сериализаторе
запроса до `/alice/***`, а дочерним процессам (`claude`, MCP-сервер) переменная не передаётся.

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`
**вычищаются из окружения дочернего `claude`**: с ними CLI молча уходит на поштучную оплату
по API мимо подписки. Если такая переменная есть в окружении — при старте будет предупреждение.

## Раздача дашборда

Сервер отдаёт собранный дашборд из `DASHBOARD_DIST` по корню `/`, чтобы на Android TV
не требовался второй веб-сервер и не было кросс-origin.

- Неизвестный `GET` вне `/api`, `/alice`, `/healthz` отдаёт `index.html` (SPA-fallback).
- `/api/*` всегда возвращает честный `404 {"error":"not_found"}`, а не `index.html`.
- **Каталога `dist` нет — это не ошибка.** Сервер пишет одну строку в лог и продолжает
  работать: в dev-режиме дашборд обычно крутится отдельно на Vite. Для этого случая
  и нужен `DASHBOARD_ORIGIN`.

## Проверка курлом

```bash
SECRET=<ваш ALICE_WEBHOOK_SECRET>
B=http://127.0.0.1:8787

# 1. приветствие (новая сессия, пустая команда)
curl -s -X POST "$B/alice/$SECRET" -H 'Content-Type: application/json' -d '{
  "session":{"session_id":"s1","skill_id":"k","user_id":"u1","new":true},
  "request":{"type":"SimpleUtterance","command":"","nlu":{}},"version":"1.0"}'

# 2. заснул  (замеряем и время ответа: бюджет 200 мс)
curl -s -w '\nвремя: %{time_total}s\n' -X POST "$B/alice/$SECRET" -H 'Content-Type: application/json' -d '{
  "session":{"session_id":"s1","skill_id":"k","user_id":"u1"},
  "request":{"type":"SimpleUtterance","command":"андрей заснул","nlu":{}},"version":"1.0"}'

# 3. проснулся
curl -s -X POST "$B/alice/$SECRET" -H 'Content-Type: application/json' -d '{
  "session":{"session_id":"s1","skill_id":"k","user_id":"u1"},
  "request":{"type":"SimpleUtterance","command":"андрей проснулся","nlu":{}},"version":"1.0"}'

# 4. сводка
curl -s -X POST "$B/alice/$SECRET" -H 'Content-Type: application/json' -d '{
  "session":{"session_id":"s1","skill_id":"k","user_id":"u1"},
  "request":{"type":"SimpleUtterance","command":"сколько он сегодня спал","nlu":{}},"version":"1.0"}'

# 5. неверный секрет -> 200 OK с нейтральным текстом, ничего не записывается
curl -s -X POST "$B/alice/ffffffffffffffffffffffffffffffff" -H 'Content-Type: application/json' \
  -d '{"session":{"user_id":"x"},"request":{"command":"андрей заснул"},"version":"1.0"}'

# REST
curl -s "$B/api/state"
curl -s "$B/api/events?limit=5"
curl -s "$B/api/sleep/daily?days=14"
curl -s "$B/api/utterances?limit=10"
curl -s "$B/healthz"

# ручная запись события (отладка)
curl -s -X POST "$B/api/events" -H 'Content-Type: application/json' \
  -d '{"type":"feed","subtype":"bottle","value_num":120,"value_unit":"ml"}'

# SSE: держите открытым в соседнем терминале и шлите события из первого
curl -sN "$B/api/stream"
```

В потоке SSE должны быть: `retry:`, `event: state` сразу после подключения, затем
`event: event` / `event: utterance` на каждое действие и комментарий-heartbeat `: ping`
раз в 15 секунд.

## Обратимость изменений (§9)

Модель получает широкий доступ к SQL, поэтому безопасность даёт не доверие к ней,
а конструкция хранилища. **Безвозвратной модификации данных не существует.**

Три независимых рубежа:

1. **Триггер SQLite `events_no_hard_delete`.** Физически удалить событие нельзя ничем —
   ни тулом, ни произвольным SQL, ни багом в коде, ни через `sqlite3` из консоли.
   Удаление выражается только через `deleted_at`. Журнал ревизий тоже защищён
   от UPDATE и DELETE: он строго append-only.
2. **Журнал ревизий.** Каждое изменение `events` пишет полный снимок строки «до»
   в `event_revisions`, изменения одного запуска модели объединены в `change_set`.
   Любую правку можно отменить хоть через месяц — в том числе отмену отмены.
3. **Снимок базы** (`VACUUM INTO data/snapshots/<время>.db`) перед каждым запуском
   модели, хранятся последние 50.

Проверить рубеж 1 руками:

```bash
sqlite3 data/babytracker.db "DELETE FROM events;"
# Error: stepping, физическое удаление events запрещено: используй deleted_at (19)
```

Отмена изменений:

```bash
curl -s "$B/api/change-sets?limit=5"
curl -s -X POST "$B/api/change-sets/<id>/revert"
curl -s "$B/api/events?include_deleted=true"   # посмотреть, что было скрыто
```

### Рамки произвольного SQL

`sql_execute` принимает **один** `INSERT INTO events` или `UPDATE events`. Отклоняются
`DELETE`, любая другая таблица, DDL и служебные команды, вторая команда за `;`,
изменение `id` / `created_at` / `utterance_id`. Проверка идёт по токенам, а не по
подстрокам: `note = 'не надо delete'` — валидный запрос, а `-- ;\nDROP TABLE` — нет.
Текст ошибки всегда содержит подсказку, что сделать вместо.

`sql_query` выполняет произвольный `SELECT` по любым таблицам, до 500 строк.

### Лимиты подписки

Вызовы идут через подписку, поэтому ограничитель — окна лимитов, а не деньги.
Воркер отличает «лимит исчерпан» от настоящей ошибки: фраза возвращается в очередь
**без расхода попытки**, воркер встаёт на паузу до времени сброса окна (или на
экспоненциальную паузу от минуты до часа, если время не названо). В `/healthz` это
отдельное состояние `worker.rateLimited` / `rateLimitedUntil` — не путать с
`claudeAvailable: false`, которое означает сломанный или неавторизованный CLI.

## Тесты и типы

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # node:test
```

Покрыто: словарь и отрицания fast-path, разбор `YANDEX.DATETIME`, русские склонения,
инвариант «не более одного открытого сна», пробуждение без сна, проверки доступа
вебхука и бюджет ответа, деградация при отсутствии/неавторизованности `claude`,
лимиты подписки, REST-эндпоинты, SSE и SPA-fallback.

Отдельно и плотно — §9: токенизатор и валидатор SQL (ключевые слова в литералах,
вторая команда за комментарием, `;` внутри строки, экранированные кавычки, регистр),
триггеры БД, журналирование, откат и откат отката, политика очереди.

## Работа без claude

LLM — усилитель, а не единая точка отказа. Если `claude` не установлен или не авторизован:

- при старте в лог уходит **ровно одна** строка `worker: claude CLI недоступен`;
- фразы из очереди помечаются `skipped`, попытки не жгутся;
- fast-path продолжает писать события, Алиса отвечает как обычно;
- `/healthz` показывает `worker.claudeAvailable: false` и причину;
- раз в 5 минут воркер молча пробует, не ожил ли CLI, и подхватывает его без рестарта.

Проверить:

```bash
CLAUDE_BIN=/nonexistent pnpm start
```

## MCP-сервер

Отдельный stdio-процесс поверх того же файла БД. Воркер сам пишет `mcp.json` рядом с БД
и передаёт его в `claude --mcp-config`. Запустить вручную:

```bash
DB_PATH=./data/babytracker.db pnpm mcp
```

Тулы:

- простые: `get_state`, `query_events`, `log_event`, `update_event`, `delete_event`, `sleep_daily`;
- широкие (§9.3): `sql_query`, `sql_execute`;
- отмена: `list_change_sets`, `revert_change_set`.

Ничего, кроме них, модели не дано: ни bash, ни записи файлов.

## Раскладка

```
src/
  config.ts      env -> типизированный конфиг, понятные ошибки при старте
  db.ts          node:sqlite, схема §1, идемпотентные миграции по user_version
  time.ts        civil <-> UTC через Intl, границы локальных суток
  ru.ts          склонения, длительности, локальное время
  fastpath.ts    matchFast — чистая функция, §4
  events.ts      доменная логика и инвариант открытого сна
  utterances.ts  очередь фраз
  sse.ts         рассылка state/event/utterance + heartbeat 15 с
  sql-guard.ts   токенизатор и рамки произвольного SQL (§9.3)
  journal.ts     change sets, ревизии, откат, снимки базы (§9.1-9.3)
  queue-policy.ts когда звать модель (§9.4)
  api.ts         REST §3 и §9.6
  alice.ts       вебхук §3.1: constant-time секрет, тексты ответов
  prompt.ts      промпт для claude -p
  worker.ts      очередь -> claude -p -> MCP, таймаут 60 с, конкурентность 1, лимиты
  mcp-server.ts  отдельный stdio MCP-сервер
  app.ts         сборка Fastify (используется тестами)
  index.ts       точка входа и graceful shutdown
```
