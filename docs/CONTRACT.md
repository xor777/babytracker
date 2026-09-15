# BabyTracker — технический контракт

Единый источник правды для всех модулей. Менять только через согласование: на этот файл
опираются server, dashboard и tv одновременно.

## 0. Глоссарий

- **utterance** — сырая фраза, как её распознала Алиса. Хранится всегда, даже если разбор упал.
- **event** — распознанное событие жизни ребёнка. Может быть *открытым* (`ended_at IS NULL`) —
  например, начавшийся и ещё не закончившийся сон.
- **fast-path** — детерминированный матчер, отвечает Алисе за <50 мс.
- **worker** — фоновый процесс, гоняет `claude -p` по очереди utterances.

## 1. Схема БД (SQLite, WAL)

Файл: `data/babytracker.db`. Все временные метки — **ISO 8601 в UTC** (`2026-09-15T14:32:05.123Z`).
Никаких локальных времён в БД; таймзона применяется только на слое представления.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id     TEXT    NOT NULL DEFAULT 'andrey',
  type         TEXT    NOT NULL,   -- 'sleep' | 'feed' | 'diaper' | 'measure' | 'meds' | 'note'
  subtype      TEXT,               -- см. §2
  started_at   TEXT    NOT NULL,   -- ISO8601 UTC
  ended_at     TEXT,               -- NULL = событие ещё идёт
  value_num    REAL,               -- мл / г / °C / см
  value_unit   TEXT,               -- 'ml' | 'g' | 'kg' | 'c' | 'cm' | 'min'
  note         TEXT,
  source       TEXT    NOT NULL,   -- 'alice-fast' | 'alice-llm' | 'api' | 'manual'
  utterance_id INTEGER REFERENCES utterances(id),
  confidence   REAL,               -- 0..1, чем распознал fast-path/LLM
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  deleted_at   TEXT                -- мягкое удаление; все выборки фильтруют IS NULL
);

CREATE INDEX IF NOT EXISTS idx_events_started ON events(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type, started_at DESC);
-- ключевой индекс: поиск открытого события (незакрытый сон)
CREATE INDEX IF NOT EXISTS idx_events_open    ON events(type, ended_at) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS utterances (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text      TEXT    NOT NULL,
  alice_user_id TEXT,
  session_id    TEXT,
  received_at   TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending', -- pending|processing|done|failed|skipped
  fast_result   TEXT,    -- JSON: что понял fast-path
  llm_result    TEXT,    -- JSON: что вернул claude
  llm_error     TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  processed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_utt_status ON utterances(status, received_at);
```

**Правило открытого сна:** в каждый момент времени может существовать не более одного
события `type='sleep' AND ended_at IS NULL AND deleted_at IS NULL`. Перед вставкой нового
открытого сна — закрыть предыдущий (или отклонить). Это инвариант, проверяется в коде.

## 2. Словарь типов

| type      | subtype                          | value_num / unit         |
|-----------|----------------------------------|--------------------------|
| `sleep`   | `night` \| `nap`                 | —                        |
| `feed`    | `breast` \| `bottle` \| `solid`  | объём `ml` / длит. `min` |
| `diaper`  | `wet` \| `dirty` \| `both`       | —                        |
| `measure` | `weight` \| `height` \| `temp`   | `g`/`kg`, `cm`, `c`      |
| `meds`    | свободный текст препарата        | доза `ml` / `mg`         |
| `note`    | —                                | —                        |

**В MVP реально распознаётся только `sleep`.** Остальные типы уже есть в схеме и в MCP-тулах,
чтобы расширение не требовало миграций — но словарь fast-path и промпт LLM в MVP заточены на сон.

## 3. HTTP API

Базовый порт: **8787** (порт 3000 на codex-vm занят).

### 3.1 `POST /alice/:secret` — webhook Яндекс Диалогов

Секрет — 32 hex-символа из `ALICE_WEBHOOK_SECRET`. Сравнение **constant-time**.

Проверки, по порядку (любая неудача → 200 OK с нейтральным текстом, не 4xx: Алиса не должна
показывать пользователю ошибку, а атакующий — различать причины отказа):
1. секрет в пути совпадает;
2. `session.skill_id === ALICE_SKILL_ID` (если переменная задана);
3. `session.user_id` входит в `ALICE_ALLOWED_USER_IDS` (если список задан; пустой = принимать всех,
   это режим первичной настройки — в логи пишется увиденный `user_id`, чтобы его прописать).

Вход (существенная часть, полная схема — https://yandex.ru/dev/dialogs/alice/doc/ru/request):
```jsonc
{
  "meta":    { "locale": "ru-RU", "timezone": "Europe/Moscow", "interfaces": {} },
  "session": { "message_id": 0, "session_id": "...", "skill_id": "...",
               "user_id": "...", "new": true },
  "request": { "type": "SimpleUtterance", "command": "андрей заснул",
               "original_utterance": "Андрей заснул",
               "nlu": { "tokens": [], "entities": [], "intents": {} } },
  "version": "1.0"
}
```

Выход:
```jsonc
{ "response": { "text": "Записала: Андрей заснул в 17:32", "tts": "...", "end_session": false },
  "version": "1.0" }
```

Поведение:
- `session.new === true` и пустой `command` → приветствие, `end_session: false` (сессия держится
  открытой, чтобы можно было надиктовать несколько событий подряд).
- Команды выхода (`хватит`, `стоп`, `выход`, `пока`, `отмена`) → прощание, `end_session: true`.
- Иначе: записать utterance → прогнать fast-path → ответить. **Бюджет — 200 мс.**
  Запись в очередь и SSE-рассылка не должны блокировать ответ.
- `text` и `tts` — максимум 1024 символа каждое.

### 3.2 `GET /api/state` — текущее состояние для дашборда

```jsonc
{
  "now": "2026-09-15T14:32:05.123Z",
  "child": { "name": "Андрей", "birthDate": "2026-03-01", "ageDays": 198 },
  "sleep": {
    "status": "asleep",                      // "asleep" | "awake"
    "since": "2026-09-15T13:10:00.000Z",     // начало текущего состояния
    "currentDurationMin": 82,
    "lastSleep": { "startedAt": "...", "endedAt": "...", "durationMin": 95 }
  },
  "today": {
    "date": "2026-09-15",                    // локальная дата в TZ сервера
    "sleepTotalMin": 430,
    "sleepSessions": 4,
    "longestSleepMin": 180
  },
  "pending": 0                               // сколько фраз ещё разбирает worker
}
```

### 3.3 `GET /api/events`

Query: `from` (ISO), `to` (ISO), `type`, `limit` (по умолчанию 200, максимум 1000).
Ответ: `{ "events": Event[] }`, отсортировано по `started_at DESC`.

### 3.4 `GET /api/sleep/daily?days=14`

```jsonc
{ "days": [ { "date": "2026-09-15", "totalMin": 430, "sessions": 4, "nightMin": 300, "napMin": 130 } ] }
```

### 3.5 `GET /api/utterances?limit=20`

Лента последних фраз со статусом разбора — нужна дашборду для «живого» блока распознавания.

### 3.6 `GET /api/stream` — SSE

`Content-Type: text/event-stream`, heartbeat-комментарий каждые 15 с (иначе Cloudflare Tunnel
рвёт соединение). Именованные события:

| event       | data                                              |
|-------------|---------------------------------------------------|
| `state`     | тот же объект, что `/api/state`                   |
| `event`     | `{ "action": "created"\|"updated"\|"deleted", "event": Event }` |
| `utterance` | `{ "id", "raw_text", "status", "fast_result", "llm_result" }`   |

Клиент переподключается сам (EventSource это умеет); сервер обязан пережить обрыв.

### 3.7 `POST /api/events` — ручная запись (отладка, веб-кнопки)

Тело — `Event` без `id`/`created_at`/`updated_at`. `source` принудительно `'manual'`.

### 3.8 `GET /healthz`

`{ "ok": true, "db": true, "worker": { "alive": true, "lastRunAt": "...", "queueDepth": 0 } }`

## 4. Fast-path матчер (MVP: только сон)

Чистая функция, без побочных эффектов, полностью покрыта юнит-тестами:

```ts
type FastResult =
  | { kind: 'sleep_start'; confidence: number; at?: string }
  | { kind: 'sleep_end';   confidence: number; at?: string }
  | { kind: 'query_state'; confidence: number }
  | { kind: 'exit' }
  | { kind: 'unknown' };

function matchFast(command: string, nlu: AliceNlu): FastResult
```

Нормализация: нижний регистр, `ё`→`е`, схлопывание пробелов, срезание пунктуации.

- `sleep_start`: заснул, уснул, спит, засыпает, уложили, уложил, положили спать, спать пошёл,
  спатки, отрубился, вырубился, задрых
- `sleep_end`: проснулся, просыпается, встал, разбудили, не спит, глаза открыл, пробудился
- `query_state`: сколько спал, как спал, сколько проспал, что там, статус, как дела, отчёт,
  сколько сегодня
- `exit`: хватит, стоп, выход, пока, отмена, закончили

Отрицания (`не заснул`, `ещё не проснулся`) → `unknown`, отдаём на разбор LLM.
Если `nlu.entities` содержит `YANDEX.DATETIME` — превратить в абсолютное время и положить в `at`
(«заснул полчаса назад», «проснулся в три»).

**Ответы Алисы** (короткие, без «ваш», с локальным временем в TZ сервера):
- sleep_start → `Записала: Андрей заснул в 17:32`
- sleep_start при уже открытом сне → `Андрей уже спит, с 17:32. Это 45 минут`
- sleep_end → `Андрей проснулся. Спал 1 час 35 минут`
- sleep_end без открытого сна → `А он и не спал. Записала, что проснулся`
- query_state → сводка из `/api/state` словами
- unknown → `Приняла: «<фраза>». Сейчас разберу` — и LLM доразбирает асинхронно

## 5. Worker + Claude CLI

Цикл: раз в 1 с забрать `utterances` со `status='pending'` (по одной, `attempts < 3`),
перевести в `processing`, запустить:

```
claude -p "<prompt>" \
  --output-format json \
  --model claude-sonnet-5 \
  --mcp-config <path>/mcp.json \
  --allowedTools "mcp__babytracker__log_event,mcp__babytracker__update_event,mcp__babytracker__query_events,mcp__babytracker__get_state,mcp__babytracker__delete_event" \
  --permission-mode acceptEdits
```

Таймаут процесса — **60 с**, после чего kill и `status='failed'`. Ошибки не роняют сервер.
Конкурентность — 1 (не плодим процессы). Если `claude` не установлен или не авторизован —
worker логирует один раз на старте и помечает записи `skipped`; **сервер обязан работать без него**
(fast-path продолжает писать сон). Это обязательное требование: LLM — усилитель, не единая точка отказа.

Промпт даёт модели: текущее локальное время, TZ, текущее состояние ребёнка, сырую фразу и
результат fast-path. Задача — привести данные в порядок через MCP-тулы: дописать то, что fast-path
не понял, исправить то, что понял неверно, ничего не дублировать.

### MCP-сервер `babytracker` (stdio)

Отдельный процесс, тот же файл БД. Тулы:

| tool           | параметры |
|----------------|-----------|
| `get_state`    | — → объект из §3.2 |
| `query_events` | `{ from?, to?, type?, limit? }` |
| `log_event`    | `{ type, subtype?, started_at?, ended_at?, value_num?, value_unit?, note?, confidence? }` — `source='alice-llm'` |
| `update_event` | `{ id, ...любые поля }` |
| `delete_event` | `{ id }` — мягкое удаление |

Тулы — **единственный** способ модели трогать данные. Произвольный bash/запись файлов не даём.

## 6. Дашборд

React 19 + Vite + TypeScript. Цель — 1920×1080 на Android TV, смотрят с 3 метров.

- Минимальный кегль основного текста — 24 px, ключевые цифры — 100 px и крупнее.
- Данные: `GET /api/state` на старте, дальше живое обновление по SSE `/api/stream`;
  при обрыве — переподключение и мягкий индикатор «связь потеряна».
- Таймер текущего сна тикает локально раз в секунду, не дёргая сервер.
- Никакого скролла и ничего интерактивного: экран «висит» сутками. Учесть выгорание OLED —
  фон настоящий чёрный, аккуратная периодическая микро-анимация.
- Эстетика: sci-fi HUD — тёмный фон, неоновые акценты (циан/пурпур), моноширинные цифры,
  сканлайны, мягкое свечение. Должно быть красиво, но читаемо: свечение не в ущерб контрасту.

Блоки: крупный статус (СПИТ / БОДРСТВУЕТ + таймер), сводка за сутки, 24-часовая лента сна,
столбцы сна за 14 дней, живая лента распознанных фраз, индикатор связи и очереди.

## 7. Android TV

Тонкая обёртка WebView, Kotlin, `minSdk 21` / `targetSdk 34`.
`LEANBACK_LAUNCHER` intent-filter и баннер 320×180 — иначе приложение не появится в лаунчере TV.
Постоянный `KEEP_SCREEN_ON`, полный экран, JS включён, URL из `BuildConfig`, автоперезагрузка
при потере сети. Сборка — `./gradlew assembleDebug`, установка — `adb install -r`.

## 8. Переменные окружения

```
PORT=8787
TZ=Europe/Moscow
DB_PATH=./data/babytracker.db
ALICE_WEBHOOK_SECRET=<32 hex>
ALICE_SKILL_ID=
ALICE_ALLOWED_USER_IDS=
CHILD_NAME=Андрей
CHILD_BIRTHDATE=2026-03-01
CLAUDE_BIN=claude
CLAUDE_MODEL=claude-sonnet-5
WORKER_ENABLED=true
DASHBOARD_ORIGIN=http://localhost:5173
```
