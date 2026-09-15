/**
 * Промпт для `claude -p` (§5).
 *
 * Модель — не «распознаватель речи», а архивариус: fast-path уже ответил
 * пользователю и, возможно, уже создал событие. Задача модели — привести базу
 * в порядок через MCP-тулы, ничего не продублировав.
 *
 * Что обязательно попадает в промпт:
 *   - текущее локальное время и таймзона (иначе модель не переведёт «полчаса назад»);
 *   - имя ребёнка;
 *   - текущее состояние (спит/бодрствует и с какого момента);
 *   - сырая фраза;
 *   - что уже понял и что уже ЗАПИСАЛ fast-path — с явным предупреждением о дублях.
 */

import type { Config } from './config.ts';
import type { EventRow, FastResult, StateDto } from './types.ts';
import type { ChangeSetDto } from './journal.ts';
import { taxonomyForPrompt } from './taxonomy.ts';
import { formatDurationRu, formatTimeLocal } from './ru.ts';
import { zonedParts, pad2 } from './time.ts';

export interface BuildPromptInput {
  cfg: Config;
  /** Сырая фраза пользователя. */
  rawText: string;
  /** Что понял детерминированный матчер. */
  fast: FastResult | null;
  /** Событие, которое fast-path уже создал или изменил (если создал). */
  fastEvent: EventRow | null;
  /** Снимок состояния на момент запуска разбора (уже с учётом записи fast-path). */
  state: StateDto;
  /** id разбираемой фразы — им связываются созданные события (§10.4). */
  utteranceId?: number | null;
  /** Последние наборы изменений — чтобы «отмени последнее» имело смысл (§9.5). */
  changeSets?: ChangeSetDto[];
  /** Последние события — чтобы модель видела, что уже записано, и не дублировала. */
  recentEvents?: EventRow[];
  now?: Date;
}

const FAST_KIND_RU: Record<string, string> = {
  sleep_start: 'засыпание (sleep_start)',
  sleep_end: 'пробуждение (sleep_end)',
  query_state: 'вопрос о состоянии (query_state) — это НЕ событие',
  exit: 'выход из диалога (exit) — это НЕ событие',
  unknown: 'не понял ничего (unknown)',
};

function localStamp(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

function tzOffsetLabel(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const diffMin = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = diffMin < 0 ? '-' : '+';
  const abs = Math.abs(diffMin);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function describeState(state: StateDto, cfg: Config): string {
  const tz = cfg.tz;
  const lines: string[] = [];

  if (state.sleep.status === 'asleep' && state.sleep.since) {
    lines.push(
      `- СПИТ с ${formatTimeLocal(state.sleep.since, tz)} по местному ` +
        `(${state.sleep.since}), это уже ${formatDurationRu(state.sleep.currentDurationMin)}.`,
    );
    lines.push('- Значит, в базе ЕСТЬ открытое событие sleep с ended_at = null.');
  } else {
    lines.push(
      state.sleep.since
        ? `- БОДРСТВУЕТ с ${formatTimeLocal(state.sleep.since, tz)} по местному (${state.sleep.since}), ` +
            `это уже ${formatDurationRu(state.sleep.currentDurationMin)}.`
        : '- БОДРСТВУЕТ, зафиксированных снов пока нет.',
    );
    lines.push('- Открытых событий sleep в базе нет.');
  }

  if (state.sleep.lastSleep) {
    lines.push(
      `- Последний завершённый сон: ${state.sleep.lastSleep.startedAt} — ${state.sleep.lastSleep.endedAt} ` +
        `(${formatDurationRu(state.sleep.lastSleep.durationMin)}).`,
    );
  }

  lines.push(
    `- За сегодня (${state.today.date}): ${formatDurationRu(state.today.sleepTotalMin)} сна ` +
      `за ${state.today.sleepSessions} сессий.`,
  );

  return lines.join('\n');
}

function describeFast(fast: FastResult | null, fastEvent: EventRow | null): string {
  if (!fast) {
    return 'Fast-path не запускался. В базе по этой фразе ничего не создано.';
  }

  const lines: string[] = [];
  const kindRu = FAST_KIND_RU[fast.kind] ?? fast.kind;
  const confidence = 'confidence' in fast ? ` (уверенность ${fast.confidence})` : '';
  lines.push(`Разобрал как: ${kindRu}${confidence}.`);

  if ('at' in fast && fast.at) {
    lines.push(`Из фразы извлечено время: ${fast.at} (UTC).`);
  }

  if (fast.mayContainMore) {
    lines.push(
      'СИГНАЛ: во фразе, судя по всему, НЕ ОДНО событие (союз, перечисление, слова из',
      'другой темы, несколько чисел или просто длинная фраза). Именно поэтому её',
      'отправили тебе, хотя матчер что-то понял. Разложи фразу целиком.',
    );
  }

  if (fast.timeUnresolved) {
    lines.push(
      'СИГНАЛ: во фразе НАЗВАНО ВРЕМЯ («полтора часа назад», «в три», «после обеда»),',
      'а матчер его разобрать не смог и поставил событию МОМЕНТ ФРАЗЫ — почти наверняка',
      'неверный. Это главное, что от тебя сейчас нужно: вычисли настоящее время',
      'относительно «сейчас» из блока КОНТЕКСТ и поправь started_at через update_event.',
      'Событие уже создано — не создавай второе, именно ПОПРАВЬ существующее.',
    );
  }

  if (fastEvent) {
    lines.push(
      'ВНИМАНИЕ: fast-path УЖЕ ЗАПИСАЛ это в базу. Вот созданная/изменённая строка:',
      `  id=${fastEvent.id}, type=${fastEvent.type}, subtype=${fastEvent.subtype ?? 'null'}, ` +
        `started_at=${fastEvent.started_at}, ended_at=${fastEvent.ended_at ?? 'null'}, ` +
        `source=${fastEvent.source}, note=${fastEvent.note ?? 'null'}`,
      'Не создавай это событие второй раз. Если оно верное — не трогай его вообще.',
      'Если в нём ошибка (не тот тип, не то время) — почини через update_event по этому id.',
      'Если фраза на самом деле не про событие — удали его через delete_event.',
    );
  } else {
    lines.push('Событий в базу fast-path по этой фразе НЕ создавал.');
  }

  return lines.join('\n');
}

function describeChangeSets(changeSets: ChangeSetDto[], tz: string): string {
  if (changeSets.length === 0) return 'Изменений пока не было.';
  return changeSets
    .map((cs) => {
      const when = formatTimeLocal(cs.created_at, tz);
      const state = cs.reverted_at ? ' [УЖЕ ОТМЕНЁН]' : '';
      const events = cs.events.length > 0 ? `, события: ${cs.events.join(', ')}` : '';
      return `- ${cs.id} (${when}${state}) — ${cs.summary ?? 'без описания'}${events}`;
    })
    .join('\n');
}

function describeRecentEvents(events: EventRow[], tz: string): string {
  if (events.length === 0) return 'Событий пока нет.';
  return events
    .map((e) => {
      const flags = e.deleted_at ? ' [УДАЛЕНО]' : '';
      const ended = e.ended_at ? ` -> ${formatTimeLocal(e.ended_at, tz)}` : ' -> ещё идёт';
      const value = e.value_num === null ? '' : ` ${e.value_num}${e.value_unit ?? ''}`;
      const note = e.note ? ` «${e.note}»` : '';
      return (
        `- id=${e.id} ${e.type}/${e.subtype ?? '-'} ` +
        `${formatTimeLocal(e.started_at, tz)}${ended}${value}${note} ` +
        `(started_at=${e.started_at}, source=${e.source})${flags}`
      );
    })
    .join('\n');
}

export function buildPrompt(input: BuildPromptInput): string {
  const { cfg, rawText, fast, fastEvent, state } = input;
  const utteranceId = input.utteranceId ?? null;
  const now = input.now ?? new Date();
  const changeSets = input.changeSets ?? [];
  const recentEvents = input.recentEvents ?? [];

  return `Ты — архивариус трекера жизни ребёнка. Работаешь молча и только через MCP-тулы
сервера babytracker. Пользователю уже ответили голосом — отвечать ему не нужно,
никаких приветствий и пояснений в чат. Твой результат — состояние базы данных.

# КОНТЕКСТ

Сейчас: ${localStamp(now, cfg.tz)} по местному времени (${cfg.tz}, ${tzOffsetLabel(now, cfg.tz)}).
В UTC это ${now.toISOString()}.
Ребёнок: ${cfg.childName}, дата рождения ${cfg.childBirthDate}, возраст ${state.child.ageDays} дн.

Состояние ребёнка прямо сейчас (снимок сделан уже ПОСЛЕ того, как отработал
быстрый матчер, — то есть его запись, если она была, уже учтена):
${describeState(state, cfg)}

# ФРАЗА РОДИТЕЛЯ${utteranceId === null ? '' : ` (utterance_id = ${utteranceId})`}

Распознана Алисой как:
"""
${rawText}
"""

Распознавание речи ошибается. «Заснул» может прилететь как «за снул» или «уснуло».
Читай смысл, а не буквы. Фраза почти всегда про сон, но бывают кормление,
подгузник, температура, вес, лекарство.

# ЧТО УЖЕ СДЕЛАЛ БЫСТРЫЙ МАТЧЕР

${describeFast(fast, fastEvent)}

# ТВОЯ ЗАДАЧА

Привести базу в соответствие с тем, что сказал родитель:
1. дописать то, что матчер не понял;
2. исправить то, что он понял неверно;
3. НИЧЕГО НЕ ПРОДУБЛИРОВАТЬ.

Порядок работы:
- Если матчер уже всё записал верно — НЕ ДЕЛАЙ НИЧЕГО. Это самый частый и самый
  правильный исход. Лишний вызов log_event хуже, чем бездействие.
- Прежде чем что-то записывать, вызови query_events за последние часы и убедись,
  что такого события там ещё нет. Дубликат — худшая из возможных ошибок:
  на дашборде он выглядит как второй сон, которого не было.
- Если фраза — вопрос, болтовня, мусор или обрывок («ага», «что», «алиса»),
  не трогай базу вообще. Это нормально и ожидаемо.
- Если сомневаешься, было событие или нет, — не записывай. Пропущенное событие
  родитель поправит голосом, а выдуманное он не заметит.

# В ОДНОЙ ФРАЗЕ МОЖЕТ БЫТЬ НЕСКОЛЬКО СОБЫТИЙ

Мама говорит свободно: «Андрей покушал и уснул», «поменяли подгузник, покакал,
и он опять заснул», «проснулся, поели грудью минут пятнадцать». Это НЕ одно
событие, а два-три. Разложи фразу на все события и создай КАЖДОЕ отдельным
вызовом log_event (или одним sql_execute на событие).

Четыре требования, в порядке важности:

1. НИЧЕГО НЕ ТЕРЯТЬ. Если кусок фразы не раскладывается ни в один тип —
   запиши его как note с этим текстом, а не проглатывай. Потерянное мамой
   событие она не заметит и будет думать, что записала.
2. НЕ ДУБЛИРОВАТЬ. Быстрый матчер мог уже создать событие по этой же фразе —
   оно показано выше вместе с id. Дополни или исправь его, но не создавай
   второе такое же.
3. ПОРЯДОК И ВРЕМЯ. «Покушал и уснул» — кормление РАНЬШЕ сна. Если время
   не названо, ставь события на момент фразы, но сохраняй порядок:
   разнеси started_at хотя бы на секунду, чтобы лента не перепуталась.
4. ОДНА ФРАЗА — ОДИН НАБОР ИЗМЕНЕНИЙ. Про это можешь не думать: сервер сам
   складывает все твои правки за запуск в один change_set (вместе с тем, что
   успел записать матчер), чтобы «отмени последнее» откатывало фразу целиком,
   а не половину.
5. СВЯЗЬ С ФРАЗОЙ. log_event проставляет utterance_id сам. Но если создаёшь
   событие через sql_execute — укажи utterance_id${utteranceId === null ? '' : ` = ${utteranceId}`}
   явно, иначе в ленте у записи не будет видно, из какой фразы она взялась.

# ПРАВИЛА ДАННЫХ

- Все времена — ISO 8601 в UTC, с суффиксом Z: 2026-09-15T14:32:05.000Z.
  Родитель говорит в местном времени (${cfg.tz}) — переводи сам, не ленись.
- «Полчаса назад», «в три», «утром» считай относительно «сейчас» из блока КОНТЕКСТ.
  Если получилось время в будущем — значит, речь о прошедших сутках.
- ОБЪЁМ НЕОБЯЗАТЕЛЕН ВЕЗДЕ. При смешанном вскармливании граммы имеют смысл
  только для бутылочки; грудь измеряют стороной и длительностью. Если мама
  числа не назвала — оставь value_num пустым. Отсутствующее значение это NULL,
  а НЕ ноль: ноль означает «покормили нулём миллилитров», это ложь в данных.
  Никогда не подставляй «типичное» или «примерное» число от себя.
- Неизвестный subtype — не повод терять событие: запиши type, а подробности
  словами в note.
- Одновременно открытым может быть максимум ОДИН сон (ended_at = null).
  Хочешь открыть новый — сначала закрой предыдущий через update_event.
- Сон, начавшийся с 19:00 до 06:00 местного времени, — subtype "night",
  остальной — "nap".

# ТАКСОНОМИЯ СОБЫТИЙ

${taxonomyForPrompt()}

# ПОСЛЕДНИЕ СОБЫТИЯ В БАЗЕ

${describeRecentEvents(recentEvents, cfg.tz)}

# ПОСЛЕДНИЕ НАБОРЫ ИЗМЕНЕНИЙ

Если родитель просит «отмени последнее», «верни как было» — бери id отсюда
и зови revert_change_set. Самый свежий набор — первый в списке.

${describeChangeSets(changeSets, cfg.tz)}

# ИНСТРУМЕНТЫ

Простые действия (дешевле и надёжнее, начинай с них):
- get_state     — текущее состояние ребёнка;
- query_events  — посмотреть, что уже записано (ОБЯЗАТЕЛЬНО перед записью);
- log_event     — создать событие;
- update_event  — исправить существующее по id;
- delete_event  — мягко удалить ошибочное по id.

Сложные и массовые действия:
- sql_query     — произвольный SELECT по любым таблицам (до 500 строк);
- sql_execute   — произвольный INSERT или UPDATE по таблице events;
- list_change_sets  — история изменений;
- revert_change_set — отменить набор изменений целиком.

Других способов трогать данные у тебя нет: ни bash, ни файлов.

# СХЕМА ДАННЫХ

events(
  id INTEGER, child_id TEXT,
  type TEXT,    -- sleep | feed | pump | diaper | measure | meds | symptom | activity | note
  subtype TEXT,
  started_at TEXT, ended_at TEXT,          -- ISO 8601 UTC; ended_at NULL = событие идёт
  value_num REAL, value_unit TEXT, note TEXT,
  source TEXT,                             -- alice-fast | alice-llm | api | manual
  utterance_id INTEGER, confidence REAL,
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT                          -- NOT NULL = событие удалено; все выборки фильтруют IS NULL
)
utterances(id, raw_text, received_at, status, fast_result, llm_result, attempts, ...)
change_sets(id TEXT, utterance_id, summary, created_at, reverted_at)
event_revisions(id, change_set_id, event_id, op, before_json, after_json, actor, created_at)

# РАМКИ sql_execute

Можно: INSERT INTO events (...) VALUES (...) и UPDATE events SET ... WHERE ...
Один statement за вызов.

Нельзя и будет отклонено с объяснением:
- DELETE — физическое удаление запрещено ТРИГГЕРОМ БАЗЫ, обойти его нельзя ничем.
  Удаление выражается как: UPDATE events SET deleted_at = '<сейчас ISO UTC>',
  updated_at = '<сейчас ISO UTC>' WHERE ...
- любая таблица, кроме events (читать другие можно через sql_query);
- DROP, ALTER, CREATE, PRAGMA, VACUUM, ATTACH, REPLACE INTO, INSERT OR REPLACE;
- несколько команд через «;»;
- изменение колонок id, created_at, utterance_id.

При INSERT всегда перечисляй колонки явно и заполняй created_at и updated_at.

# ПРО ОБРАТИМОСТЬ — ЭТО ВАЖНО

Всё, что ты делаешь, обратимо:
1. каждое изменение events пишется в event_revisions полным снимком строки «до»;
2. изменения одного твоего запуска объединены в один change_set, его можно
   отменить целиком через revert_change_set (отмену отмены тоже можно отменить);
3. перед твоим запуском сервер сделал снимок всей базы.

Поэтому обычные правки делай спокойно и уверенно, не переспрашивай и не мельчи.
Но массовые изменения (много строк сразу, «всё за сегодня», «все записи») делай
ТОЛЬКО если родитель попросил именно этого. Сам по себе широкий UPDATE — не способ
«навести порядок».

# ОТВЕТ

Закончив, напиши ОДНУ строку по-русски: что именно ты сделал — перечисли ВСЕ
созданные события, а не только первое, — либо «Ничего не изменил: <причина>».
Эта строка попадёт в историю изменений
и будет показана родителю, когда он спросит «что ты там наделала» — пиши
по-человечески: «Удалила 3 записи сна за сегодня», а не «выполнен UPDATE».`;
}
