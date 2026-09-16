/**
 * Промпт для `claude -p` (§5, §9.5, §10.3).
 *
 * Модель здесь — не «распознаватель речи» и не разборщик отдельных фраз,
 * а ВЛАДЕЛЕЦ журнала: fast-path уже ответил голосом и, возможно, уже создал
 * событие, а модель отвечает за связность всего журнала. Новый факт может
 * менять прочтение уже записанного — и тогда правка старой записи её работа,
 * а не побочный эффект.
 *
 * Граница, которую нельзя размывать и ради которой написана половина этого
 * файла: **решать о прочтении можно, выдумывать факты нельзя.** «Веди себя
 * как владелец» очень легко читается моделью как «будь уверена и заполняй
 * пробелы» — именно так проект дважды получил правдоподобную неправду на
 * проде. Поэтому владение в тексте промпта всегда идёт в паре с запретом на
 * выдумывание и со способом пометить допущение.
 *
 * СТРУКТУРА (промпт — интерфейс, а не сочинение):
 *   1. всегда: роль, главное правило, как помечать допущение, порядок работы;
 *   2. всегда: короткая таблица вердиктов по неоднозначным случаям (одна
 *      строка на случай) — чтобы ни один случай не остался без ответа;
 *   3. ПО СИТУАЦИИ: 1–3 развёрнутые карточки ровно тех случаев, которые
 *      сейчас на столе, с готовыми образцами вызовов. Избыточный промпт
 *      ухудшает следование инструкциям не меньше, чем недостаточный, поэтому
 *      карточки, которые сейчас ни при чём, не показываются вовсе;
 *   4. всегда: справочники (таксономия, тулы, схема, рамки SQL) — коротко.
 */

import type { Config } from './config.ts';
import type { EventRow, FastResult, StateDto, UtteranceRow } from './types.ts';
import type { ChangeSetDto } from './journal.ts';
import { EVENT_TYPES, STATE_SUBTYPES, TAXONOMY, isStateSubtype } from './taxonomy.ts';
import { formatDateTimeLocal, formatDurationRu, formatTimeLocal, withUnit } from './ru.ts';
import { zonedParts, pad2 } from './time.ts';

/**
 * Таксономия одной строкой на тип. Источник правды — `TAXONOMY`, но рендер здесь
 * намеренно плотный: в промпте это справочник, а не документация, и каждая лишняя
 * строка отнимает внимание у политики.
 */
function taxonomyCompact(): string {
  return EVENT_TYPES.map((type) => {
    const spec = TAXONOMY[type];
    const subtypes = spec.freeSubtype
      ? 'свободный текст'
      : spec.subtypes.length > 0
        ? spec.subtypes.join('|')
        : '—';
    const units = spec.units.length > 0 ? ` [${spec.units.join('/')}]` : '';
    return `- ${type.padEnd(8)} ${subtypes}${units} — ${spec.hint}`;
  }).join('\n');
}

/* ------------------------------------------------------------------ */
/* Контракт пометки допущения                                          */
/* ------------------------------------------------------------------ */

/**
 * Признак «в этой записи есть то, чего родитель не говорил».
 *
 * Почему это префикс в `note`, а не новая колонка. Отдельный булев признак
 * выглядит чище, но: (1) `confidence` уже несёт ровно этот смысл и уже
 * пишется fast-path'ом (0.4 при неразобранном времени, §10.3) — два
 * параллельных признака дали бы два источника правды; (2) колонка означает
 * миграцию плюс правки в схемах MCP-тулов, валидации API и двух дашбордах;
 * (3) главное, чего не умеет булев флаг, — сказать, ЧТО именно предположено,
 * а без этого пометка бесполезна человеку.
 *
 * Поэтому признаков два и они делят работу:
 *   - `[?]` в начале note — ЧТО неизвестно, словами, для человека;
 *   - `confidence` — НАСКОЛЬКО можно верить записи, числом, для дашборда.
 *
 * Маркер намеренно короткий, ASCII и стабильный: по нему можно грепать
 * (`note LIKE '[?]%'`), его легко вырезать из текста для TTS, и он одинаков
 * у записей fast-path и модели.
 */
export const ASSUMPTION_MARK = '[?]';

/** Есть ли в записи помеченное допущение (§: «допущение должно быть видимым»). */
export function isAssumption(event: Pick<EventRow, 'note'>): boolean {
  return (event.note ?? '').trimStart().startsWith(ASSUMPTION_MARK);
}

/**
 * Окно повтора: столько минут одинаковое событие считается ПОВТОРОМ ФРАЗЫ,
 * а не вторым событием.
 *
 * Числа — из физиологии, а не из головы: два кормления через минуту у
 * новорождённого не бывают, а вот два подряд «заснул» через 10 минут
 * (уложили, не заснул, уложили снова) — бывают, поэтому у сна окно шире.
 * Это подсказка модели для выбора прочтения, а не жёсткий порог.
 */
export const REPEAT_WINDOW_MIN: Readonly<Record<string, number>> = {
  sleep: 20,
  feed: 10,
  diaper: 10,
  pump: 10,
  meds: 10,
  measure: 60,
  symptom: 10,
  activity: 10,
};

export function repeatWindowMin(type: string): number {
  return REPEAT_WINDOW_MIN[type] ?? 10;
}

/**
 * Типы, у которых событие может ИДТИ: `ended_at = null` для них осмысленно.
 * Для всех прочих (diaper, measure, meds, symptom, note) пустой `ended_at` —
 * всегда ошибка: они точечные.
 *
 * Исключение не на уровне типа, а на уровне подтипа — см. `isDurative` ниже:
 * симптом в целом точечный (срыгнул, вырвало), но наблюдения-состояния
 * (`STATE_SUBTYPES`: желтизна кожи, желтизна белков глаз) держатся днями.
 */
export const DURATIVE_TYPES: readonly string[] = ['sleep', 'feed', 'pump', 'activity'];

/**
 * Может ли ЭТО событие числиться идущим.
 *
 * Разрешение даётся парой (тип, подтип), а не одним типом: расширить
 * `DURATIVE_TYPES` до целого `symptom` значило бы разрешить висеть открытыми
 * коликам и плачу, у которых нет ни закрывающей фразы, ни предела
 * правдоподобия — ровно та беда, от которой написан `MAX_OPEN_MIN`.
 */
export function isDurative(type: string, subtype?: string | null): boolean {
  return DURATIVE_TYPES.includes(type) || isStateSubtype(type, subtype);
}

/** «symptom/skin_yellow, symptom/eyes_yellow» — для справочной части промпта. */
export function stateSubtypesList(): string {
  return Object.entries(STATE_SUBTYPES)
    .flatMap(([type, subtypes]) => subtypes.map((s) => `${type}/${s}`))
    .join(', ');
}

/**
 * Сколько минут открытое событие ещё может быть правдой.
 *
 * У сна есть закрывающая фраза («проснулся») и инвариант одного открытого сна,
 * у остального нет ничего: «начал кушать» без «поел» провисит до утра и на
 * дашборде превратится в кормление, идущее седьмой час. Так не бывает,
 * и это видно без всякой модели.
 *
 * Сна в списке нет намеренно: девятичасовой сон неправдоподобен, но возможен,
 * и разбирается он отдельным правилом (см. карточку про второе «заснул»).
 */
export const MAX_OPEN_MIN: Readonly<Record<string, number>> = {
  feed: 60,
  pump: 30,
  activity: 180,
};

export function maxOpenMin(type: string): number | null {
  return MAX_OPEN_MIN[type] ?? null;
}

/** Событие, которое числится идущим дольше, чем такое событие вообще длится. */
export function isStaleOpen(event: EventRow, now: Date): boolean {
  if (event.ended_at !== null || event.deleted_at !== null) return false;
  const limit = maxOpenMin(event.type);
  if (limit === null) return false;
  return now.getTime() - Date.parse(event.started_at) > limit * 60_000;
}

/**
 * С какого момента открытый сон при новом «заснул» перестаёт быть похожим
 * на повтор фразы и становится похож на пропущенное пробуждение.
 */
export const SLEEP_REPEAT_WINDOW_MIN = REPEAT_WINDOW_MIN.sleep ?? 20;

/**
 * Сколько часов подряд сна для младенца до трёх месяцев уже неправдоподобно.
 * Не медицинское суждение и не повод «исправить» — повод усомниться в записи
 * и пометить её (принцип «правдоподобие как сигнал, а не как факт»).
 */
export const IMPLAUSIBLE_SLEEP_HOURS = 6;

/* ------------------------------------------------------------------ */
/* Вход                                                                */
/* ------------------------------------------------------------------ */

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
  /** Сколько раз фразу уже присылали на повторный разбор. */
  reparseCount?: number | null;
  /** Последние наборы изменений — чтобы «отмени последнее» имело смысл (§9.5). */
  changeSets?: ChangeSetDto[];
  /** Последние события — чтобы модель видела, что уже записано, и не дублировала. */
  recentEvents?: EventRow[];
  /**
   * Наблюдения-состояния, открытые прямо сейчас (`openStateEvents`).
   *
   * Отдельно от `recentEvents` намеренно: состояние держится сутками и за край
   * списка последних событий уезжает через несколько часов, а закрыть его
   * модель должна уметь и на пятый день.
   */
  openStates?: EventRow[];
  /**
   * Последние фразы родителя. Без них не отличить «сказал дважды» от
   * «случилось дважды»: по одним событиям видно, что записано, но не видно,
   * сколько раз про это говорили.
   */
  recentUtterances?: UtteranceRow[];
  now?: Date;
  /**
   * Когда фразу СКАЗАЛИ (`utterances.received_at`). По умолчанию — «сейчас».
   *
   * Разбор асинхронный, и между фразой и запуском модели может пройти час:
   * лежал claude, ждали окно лимита, перезапускался сервер, человек вернул
   * старую фразу в разбор. Всё относительное во фразе («полчаса назад», «в
   * три», «только что») отсчитывается от МОМЕНТА ФРАЗЫ, иначе разгребание
   * очереди само становится источником неверных времён в дневнике.
   */
  receivedAt?: Date;
}

/**
 * С какой задержки разбор считается запоздавшим и модели об этом говорится
 * прямым текстом. Две минуты — с запасом больше обычного времени в очереди
 * (секунды), но заметно меньше любого значимого интервала в дневнике.
 */
export const LATE_PARSE_MIN = 2;

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
      'СИГНАЛ «во фразе не одно событие»: союз, перечисление, слова из другой',
      'темы, несколько чисел или просто длинная фраза. Поэтому её отправили',
      'тебе, хотя матчер что-то понял. Разложи фразу целиком.',
    );
  }

  if (fast.timeUnresolved) {
    lines.push(
      'СИГНАЛ «время названо, но не разобрано»: во фразе есть «полтора часа назад» /',
      '«в три» / «после обеда», матчер не справился и поставил МОМЕНТ ФРАЗЫ — почти',
      'наверняка неверный. Вычисли настоящее время от «сейчас» и поправь started_at',
      'через update_event, второго события не создавай. Если однозначно не',
      'вычисляется и у тебя только догадка — время не меняй, а пометь запись:',
      'догадка, записанная молча, хуже честно помеченной неточности.',
    );
  }

  if (fastEvent) {
    lines.push(
      'Матчер УЖЕ ЗАПИСАЛ это в базу:',
      `  id=${fastEvent.id}, type=${fastEvent.type}, subtype=${fastEvent.subtype ?? 'null'}, ` +
        `started_at=${fastEvent.started_at}, ended_at=${fastEvent.ended_at ?? 'null'}, ` +
        `confidence=${fastEvent.confidence ?? 'null'}, note=${fastEvent.note ?? 'null'}`,
      'Матчер — словарь, он не видит ни состояния, ни истории. Его запись — черновик:',
      'верна — не трогай, неверна — почини по id, лишняя — удали. Вторую не создавай.',
    );
  } else {
    lines.push('Событий в базу матчер по этой фразе НЕ создавал.');
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
      const mark = isAssumption(e) ? ' [ТВОЁ ПРЕЖНЕЕ ДОПУЩЕНИЕ]' : '';
      const ended = e.ended_at ? ` -> ${formatTimeLocal(e.ended_at, tz)}` : ' -> ещё идёт';
      const value = e.value_num === null ? '' : ` ${e.value_num}${e.value_unit ?? ''}`;
      const note = e.note ? ` «${e.note}»` : '';
      const conf = e.confidence === null ? '' : `, confidence=${e.confidence}`;
      return (
        `- id=${e.id} ${e.type}/${e.subtype ?? '-'} ` +
        `${formatTimeLocal(e.started_at, tz)}${ended}${value}${note} ` +
        `(started_at=${e.started_at}, source=${e.source}${conf})${flags}${mark}`
      );
    })
    .join('\n');
}

/**
 * Наблюдения-состояния, открытые прямо сейчас.
 *
 * Отдельный блок, а не «найдётся в последних событиях»: желтизна держится
 * сутками, а последних событий модель видит два десятка — за четыре дня их
 * набегает втрое больше. Открытое состояние просто уехало бы за край списка,
 * и на «желтизна прошла» модель завела бы ВТОРУЮ запись вместо закрытия
 * первой. Состояний этих единицы, поэтому блок дешёвый и точный.
 */
function describeOpenStates(events: EventRow[], tz: string, now: Date): string {
  if (events.length === 0) return 'Открытых наблюдений-состояний нет.';
  return events
    .map((e) => {
      const days = Math.max(0, Math.floor(minutesBetween(e.started_at, now) / (60 * 24)));
      const since = formatDateTimeLocal(e.started_at, tz);
      const note = e.note ? ` «${e.note}»` : '';
      return (
        `- id=${e.id} ${e.type}/${e.subtype ?? '-'} держится с ${since}` +
        `${days > 0 ? ` — это ${withUnit(days, ['день', 'дня', 'дней'])}` : ''}` +
        `${note} (started_at=${e.started_at})`
      );
    })
    .join('\n');
}

/**
 * Последние фразы. Нужны ровно для одного вопроса, на который события ответа
 * не дают: «это случилось дважды или про это сказали дважды?»
 */
function describeRecentUtterances(rows: UtteranceRow[], tz: string, currentId: number | null): string {
  const others = rows.filter((u) => u.id !== currentId);
  if (others.length === 0) return 'Других фраз пока не было.';
  return others
    .map((u) => `- ${formatTimeLocal(u.received_at, tz)} [${u.status}] «${u.raw_text}»`)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Ситуативные карточки                                                */
/* ------------------------------------------------------------------ */

interface CaseCard {
  key: string;
  text: string;
}

interface CaseInput {
  cfg: Config;
  state: StateDto;
  fast: FastResult | null;
  fastEvent: EventRow | null;
  rawText: string;
  recentEvents: EventRow[];
  recentUtterances: UtteranceRow[];
  /** Открытые наблюдения-состояния — их не видно в «последних событиях». */
  openStates: EventRow[];
  utteranceId: number | null;
  /**
   * Точка отсчёта для всех «сколько прошло» — МОМЕНТ ФРАЗЫ, а не момент
   * разбора. Разбор мог случиться на час позже (стояла очередь), и «прошло
   * 20 минут после засыпания» должно означать 20 минут на момент, когда
   * родитель это сказал, — иначе развилка «повтор или пропущенное
   * пробуждение» решается по времени, которого не было.
   */
  now: Date;
}

const CORRECTION_MARKERS = [
  'не так',
  'не то',
  'как было',
  'а не в',
  'а не ',
  'нет ',
  'ошиб',
  'исправ',
  'поправ',
  'удали',
  'убери',
  'отмени',
  'верни',
  'сотри',
  'замен',
  'на самом деле',
  'перепут',
];

const DENIAL_MARKERS = ['не спал', 'не спала', 'он не', 'она не', 'не было', 'не ел', 'не кушал'];

function minutesBetween(fromIso: string, to: Date): number {
  const ms = to.getTime() - Date.parse(fromIso);
  return Number.isFinite(ms) ? Math.round(ms / 60_000) : 0;
}

function lower(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

/** Карточка: второе «заснул» при уже открытом сне — канонический случай. */
function cardOpenSleepRepeat(input: CaseInput): CaseCard | null {
  const { state, fast, now, cfg } = input;
  if (state.sleep.status !== 'asleep' || !state.sleep.since) return null;
  const isSleepStart =
    fast?.kind === 'sleep_start' ||
    (fast?.kind === 'unknown' && /засн|усн|засып|уложил|спат/u.test(lower(input.rawText)));
  if (!isSleepStart) return null;

  const openSince = state.sleep.since;
  const elapsed = Math.max(0, minutesBetween(openSince, now));
  const localSince = formatTimeLocal(openSince, cfg.tz);
  const localNow = localStamp(now, cfg.tz).slice(-5);
  const implausible = elapsed >= IMPLAUSIBLE_SLEEP_HOURS * 60;

  const branch =
    elapsed < SLEEP_REPEAT_WINDOW_MIN
      ? `Прошло ${elapsed} мин, меньше ${SLEEP_REPEAT_WINDOW_MIN} — это (б), повтор.
Открытый сон НЕ трогай, второй не создавай. Одна заметка:
  log_event type=note note="${ASSUMPTION_MARK} «заснул» сказано второй раз через ${elapsed} мин
  после начала сна в ${localSince}. Считаю повтором, новый сон не заводила" confidence=0.3`
      : `Прошло ${formatDurationRu(elapsed)} — это (а), пропущенное пробуждение. Момент пробуждения
НЕИЗВЕСТЕН, и выдумать его нельзя: любое время между ${localSince} и ${localNow} будет
ровно той правдоподобной неправдой, ради которой написан этот промпт.
Порядок:
  1) update_event id=<id открытого сна> ended_at=<сейчас>
     note="${ASSUMPTION_MARK} конец сна не назывался. Поставила ГРАНИЦУ — момент фразы ${localNow}:
     позже он точно не спал. Проснулся раньше, когда — неизвестно,
     длительность ${formatDurationRu(elapsed)} завышена" confidence=${implausible ? '0.2' : '0.3'}
  2) log_event type=sleep started_at=<сейчас> confidence=0.9
Оставить старый сон открытым нельзя: второй не заведётся (инвариант базы),
а завышенная длительность всё равно будет расти — только без пометки.${
          implausible
            ? `
  3) ${formatDurationRu(elapsed)} подряд для ${state.child.ageDays}-дневного неправдоподобно (ориентир — до
     ${IMPLAUSIBLE_SLEEP_HOURS} ч). Скажи это словами в той же заметке. Усомниться и пометить — да,
     «исправить» на красивую длительность — нет.`
            : ''
        }`;

  return {
    key: 'open_sleep_repeat',
    text: `## ТВОЙ СЛУЧАЙ: «заснул», а сон уже открыт

Открытый сон с ${localSince} (${openSince}), это уже ${formatDurationRu(elapsed)}. Родитель снова
говорит про засыпание, про пробуждение не говорил. Прочтений три, и различить
их НЕЛЬЗЯ: (а) проснулся, а сказать забыли; (б) родитель повторился;
(в) первое «заснул» было ошибкой. Вариант (в) — только если родитель сам про
это сказал. Между (а) и (б) решает прошедшее время: повтор через 10 минут
бывает, новое засыпание через 10 минут — нет.

${branch}`,
  };
}

const DURATIVE_WORDS =
  /корм|кушат|кушал|ест |поел|поела|доел|груд|бутылочк|сцеж|купа|гуля|прогул|выклад|животик|закончил|отпустил/u;

/**
 * Карточка: открытое НЕ-спальное событие, которому нечем закрыться.
 *
 * Живой случай с прода: «начал кушать» — модель честно завела открытое
 * кормление и не выдумала ни вид, ни объём. Но пары «заснул/проснулся»
 * у кормления нет, и запись провисела бы до утра, показывая «идёт седьмой час».
 */
function cardOpenDurative(input: CaseInput): CaseCard | null {
  const { recentEvents, now, rawText } = input;
  const open = recentEvents.filter(
    (e) => e.deleted_at === null && e.ended_at === null && e.type !== 'sleep' && maxOpenMin(e.type) !== null,
  );
  const aboutDurative = DURATIVE_WORDS.test(lower(rawText));
  if (open.length === 0 && !aboutDurative) return null;

  const list =
    open.length === 0
      ? 'Открытых незакрытых событий сейчас нет.'
      : open
          .map((e) => {
            const ago = Math.max(0, minutesBetween(e.started_at, now));
            const stale = isStaleOpen(e, now);
            return (
              `- id=${e.id} ${e.type}/${e.subtype ?? '-'} открыто с ${formatTimeLocal(e.started_at, input.cfg.tz)}, ` +
              `это ${formatDurationRu(ago)}${stale ? ' — ТАК ДОЛГО НЕ ДЛИТСЯ' : ''}`
            );
          })
          .join('\n');

  return {
    key: 'open_durative',
    text: `## ТВОЙ СЛУЧАЙ: событие с длительностью, которому нечем закрыться

${list}

У сна есть пара «заснул/проснулся» и инвариант одного открытого сна.
У кормления, сцеживания и активности нет ни того, ни другого: «начал кушать»
без «поел» провисит до утра и покажет кормление, идущее седьмой час.

  - ЗАКРЫВАЮТ открытое: «поел», «доел», «закончил», «всё», «отпустил грудь»,
    «искупали», «пришли с прогулки». Момент тут НАЗВАН — родитель говорит
    в ту самую минуту: ended_at = сейчас, confidence 0.9, маркер не нужен;
  - ПРОВИСЕВШЕЕ (кормление или сцеживание старше часа, активность старше трёх)
    почини заодно — это не массовая правка, а очевидная неправда в журнале.
    Закрывай ТОЧКОЙ: ended_at = started_at, note «${ASSUMPTION_MARK} не закрывали, длительность
    неизвестна; свела к точке, чтобы не числилось идущим», confidence 0.3.
    value_num не трогай: неизвестная длительность это NULL, а не число;
  - ПОЧЕМУ точкой, а у сна границей: ended_at сна — это часы на дашборде,
    и точка стёрла бы реальный сон. У кормления, сцеживания и активности
    длительность в метрики не идёт, поэтому точка ничего не теряет,
    а граница нарисовала бы шестичасовое кормление, которого не было;
  - НОВОЕ такое же при открытом предыдущем — развилка как со вторым «заснул»:
    в пределах ${REPEAT_WINDOW_MIN.feed} мин это повтор фразы (второго не создавай), дальше —
    предыдущее просто не закрыли: закрой точкой с пометкой и заводи новое.`,
  };
}

/** Карточка: пробуждение без открытого сна. */
function cardWakeWithoutSleep(input: CaseInput): CaseCard | null {
  const { state, fast } = input;
  if (fast?.kind !== 'sleep_end') return null;
  if (state.sleep.status === 'asleep') return null;

  return {
    key: 'wake_without_sleep',
    text: `## ТВОЙ СЛУЧАЙ: «проснулся», а открытого сна в базе нет

НЕ создавай сон задним числом. Ни начала, ни длительности никто не называл;
«наверное, поспал часа два» — выдумка, которая сразу же станет двумя часами
в сводке сна за сутки. Матчер уже записал заметку о пробуждении (id выше) —
этого достаточно, оставь как есть; note уточнить можно, время — нет.

ИСКЛЮЧЕНИЕ: родитель сам назвал начало или длительность («проспал два часа
и проснулся», «спал с двух»). Тогда сон НАЗВАН, а не выведен, — создай его
закрытым: log_event type=sleep started_at=<сейчас−2ч> ended_at=<сейчас>
confidence=0.8, а заметку матчера удали, чтобы не было двух записей об одном.
Открытым (ended_at=null) сон задним числом не создавай никогда.`,
  };
}

/** Карточка: поправка к уже записанному. */
function cardCorrection(input: CaseInput): CaseCard | null {
  const text = lower(input.rawText);
  const hit = CORRECTION_MARKERS.some((m) => text.includes(m));
  if (!hit) return null;

  return {
    key: 'correction',
    text: `## ТВОЙ СЛУЧАЙ: похоже на поправку к уже записанному

«нет, он заснул в девять, а не в десять», «убери последнюю запись»,
«я перепутала» — это НЕ новое событие, это правка старого.

  1) найди запись по названному старому значению («а не в десять» → сон
     около 10:00), типу и свежести; правь её через update_event, вторую
     не создавай — две версии правды хуже одной неполной;
  2) ПРОВЕРЬ, не завёл ли матчер по этой же фразе новое событие: слово
     «заснул» внутри поправки он принимает за засыпание прямо сейчас.
     Завёл — удали через delete_event;
  3) поправка родителя — это ФАКТ, а не допущение: маркер «${ASSUMPTION_MARK}» не ставь,
     confidence 0.9+, в note — что и с чего исправлено («было 10:00»);
  4) подходящей записи нет или кандидатов несколько — НИЧЕГО НЕ ТРОГАЙ,
     заметка «${ASSUMPTION_MARK} родитель поправляет: «<фраза>», не нашла какую запись»,
     confidence=0.3. Угадать не тот сон хуже, чем не угадать никакой.

«Отмени последнее», «верни как было» — это list_change_sets +
revert_change_set по свежему набору, а не ручное редактирование.`,
  };
}

/** Карточка: фраза противоречит записанному. */
function cardContradiction(input: CaseInput): CaseCard | null {
  const text = lower(input.rawText);
  if (!DENIAL_MARKERS.some((m) => text.includes(m))) return null;
  if (input.recentEvents.length === 0) return null;

  return {
    key: 'contradiction',
    text: `## ТВОЙ СЛУЧАЙ: фраза противоречит тому, что уже записано

«Он не спал» после записанного сна, «да не ел он» после кормления. Родитель —
источник истины о том, что БЫЛО. Но это не повод стирать молча и наугад.

  - однозначно понятно, какая запись оспорена (одна свежая подходящая) →
    delete_event по ней (удаление мягкое, обратимое) и заметка «${ASSUMPTION_MARK} родитель:
    «<фраза>», удалила id=N — противоречит сказанному», confidence=0.5;
  - кандидатов несколько или неясно, о чём речь → НЕ УДАЛЯЙ НИЧЕГО, заметка
    с текстом фразы и перечислением кандидатов, confidence=0.3;
  - противоречит записи, которую сделала ТЫ САМА, — тем более правь: твоё
    допущение не подтвердилось. Скажи об этом в итоговой строке.

Противоречие, оставленное невидимым, — худший исход из трёх.`,
  };
}

/** Карточка: событие задним числом, после которого уже есть записи. */
function cardRetroactive(input: CaseInput): CaseCard | null {
  const { fast, recentEvents } = input;
  const namedTime =
    fast?.timeUnresolved === true || (fast !== null && 'at' in fast && Boolean(fast.at));
  if (!namedTime) return null;
  if (recentEvents.length === 0) return null;

  return {
    key: 'retroactive',
    text: `## ТВОЙ СЛУЧАЙ: событие задним числом, а после него уже есть записи

«Он поел в одиннадцать», сказанное в два, когда на одиннадцать уже записан сон.

  - ставь запись туда, куда её поставил родитель, и НЕ СДВИГАЙ соседние ради
    «освободить место»: соседи записаны с его слов, не с твоих;
  - противоречит соседней (кормление внутри записанного сна) — запиши как
    названо и опиши противоречие в её note с «${ASSUMPTION_MARK}», confidence=0.5.
    Пусть родитель увидит и решит сам;
  - сон задним числом создавай ТОЛЬКО закрытым (с ended_at): открытый сон
    в прошлом молча закроет текущий и порвёт ленту;
  - время однозначно не вычисляется, а матчер уже поставил момент фразы —
    не меняй одну догадку на другую, оставь и пометь.`,
  };
}

/** Карточка: ту же фразу сказали второй раз. */
function cardDuplicateUtterance(input: CaseInput): CaseCard | null {
  const { recentUtterances, rawText, utteranceId, now } = input;
  const norm = lower(rawText).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (norm.length === 0) return null;

  const twin = recentUtterances.find((u) => {
    if (u.id === utteranceId) return false;
    const other = lower(u.raw_text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (other !== norm) return false;
    return Math.abs(minutesBetween(u.received_at, now)) <= 30;
  });
  if (!twin) return null;

  const ago = Math.max(0, minutesBetween(twin.received_at, now));
  return {
    key: 'duplicate_utterance',
    text: `## ТВОЙ СЛУЧАЙ: ровно эта фраза уже звучала ${ago} мин назад

Дословный повтор (фраза id=${twin.id}, статус «${twin.status}»). Одно и то же
событие дважды за ${ago} мин у младенца не случается — почти наверняка родитель
сказал дважды: не расслышал ответ, повторил, продиктовал из другой комнаты.

Второго события НЕ создавай. Матчер успел записать его по этой фразе —
удали через delete_event и объясни в итоговой строке.
Но если вторая фраза добавила подробность («покормили» → «покормили 60»),
это не повтор, а уточнение: update_event первой записи.`,
  };
}

/** Карточка: рядом есть запись того же типа, только что сделанная. */
function cardNearDuplicateEvent(input: CaseInput): CaseCard | null {
  const { recentEvents, fastEvent, now } = input;
  const candidates = recentEvents.filter((e) => {
    if (e.deleted_at !== null) return false;
    if (fastEvent && e.id === fastEvent.id) return false;
    if (e.type === 'note') return false;
    const ago = minutesBetween(e.started_at, now);
    return ago >= 0 && ago <= repeatWindowMin(e.type);
  });
  if (candidates.length === 0) return null;

  const list = candidates
    .slice(0, 3)
    .map((e) => `id=${e.id} ${e.type}/${e.subtype ?? '-'} (${minutesBetween(e.started_at, now)} мин назад)`)
    .join('; ');

  return {
    key: 'near_duplicate_event',
    text: `## ТВОЙ СЛУЧАЙ: только что уже записано похожее

В окне повтора есть: ${list}.

Если фраза про то же самое — это НЕ второе событие:
  - ничего не добавила → ничего не делай;
  - добавила подробность (объём, сторону, подтип) → update_event существующей
    записи; названное родителем — факт, маркер «${ASSUMPTION_MARK}» не нужен, confidence выше;
  - точно про другое событие (сказано «ещё раз», «опять», названо другое
    время) → тогда да, второе. Иначе — нет.
Дубликат на дашборде выглядит как второе кормление, которого не было.`,
  };
}

/**
 * Слова, по которым видно, что родитель говорит про то, что ДЕРЖИТСЯ:
 * про цвет кожи и белков глаз или про сыпь.
 *
 * Нарочно широко и по корню: «желтенький», «жёлтые», «желтизна», «желтит»,
 * «сыпь», «высыпало», «прыщики» — родитель выбирает слово не думая. Ложное
 * срабатывание стоит одной лишней карточки в промпте, пропуск — потерянного
 * из сводки наблюдения, которого врач ждал.
 *
 * Две границы проведены нарочно, и обе — против ложного срабатывания:
 *
 *   - «ПОКРАСНЕЛ» сюда НЕ входит. У младенца краснеют от натуги, от жары и
 *     перед плачем; это описание минуты, а не наблюдение о коже. Отличить
 *     одно от другого словарём нельзя, а карточка про состояние подталкивает
 *     завести ОТКРЫТУЮ запись там, где её быть не должно, — и та провисит,
 *     потому что закрывать её никто не придёт;
 *   - «ПЯТНО» — только в уменьшительной форме («пятнышки»). Голое «пятно» —
 *     это чаще про пелёнку и одежду, чем про кожу, а карточка стоит ПЕРВОЙ
 *     в очереди разборов и вытеснила бы ту, которая на самом деле нужна.
 */
const STATE_WORDS = /желт|жёлт|белки глаз|цвет кожи|цвет лица|сып|высыпа|прыщ|пятныш/u;

/**
 * Карточка: родитель заметил то, что держится днями, — желтизну или сыпь.
 *
 * Зачем вообще карточка. Без неё «он какой-то желтенький» ложится в общую
 * заметку: тип не опознан, подтипа нет, в сводку не попадает — а это ровно то
 * наблюдение, ради которого врач и спрашивает. И вторая беда: модель, увидев
 * желтизну у двухнедельного, охотно допишет «физиологическая желтуха
 * новорождённых, это норма», а на сыпь — «похоже на потницу». Это диагнозы,
 * поставленные приложением, и их здесь быть не должно ни в каком виде.
 *
 * Карточка одна на все состояния, а не по одной на подтип: правила у них
 * буквально общие (открыть, не заводить второе, закрыть только явным словом),
 * и различается лишь строка «куда». Три почти одинаковые карточки подряд
 * читаются как фон — ровно то, от чего написан `MAX_CASE_CARDS`.
 */
function cardObservationState(input: CaseInput): CaseCard | null {
  const { rawText, openStates, cfg, now } = input;
  const mentioned = STATE_WORDS.test(lower(rawText));
  if (!mentioned) return null;

  return {
    key: 'observation_state',
    text: `## ТВОЙ СЛУЧАЙ: родитель говорит про то, что ДЕРЖИТСЯ, — цвет или сыпь

${describeOpenStates(openStates, cfg.tz, now)}

Родитель УВИДЕЛ. Это НАБЛЮДЕНИЕ, и записывается оно как наблюдение.

  - ДИАГНОЗ СТАВИТЬ ЗАПРЕЩЕНО. Ни «желтуха», ни «физиологическая», ни
    билирубин, ни «это норма для новорождённого»; про сыпь — ни «аллергия»,
    ни «потница», ни «диатез», ни «акне новорождённых»; и ни в одном случае
    «стоит показаться врачу». Ты не врач и причины не знаешь. Твоё дело —
    записать, ЧТО РОДИТЕЛЬ УВИДЕЛ, его словами. Выводы сделает врач — по
    фактам, а не по твоей догадке. Приложение, записавшее вывод вместо
    факта, начинает лечить вместо врача;
  - КУДА: кожа жёлтая → symptom/skin_yellow, белки глаз жёлтые →
    symptom/eyes_yellow, сыпь и высыпания где угодно → symptom/rash.
    Сказали про несколько — по событию на каждое: для врача это разные
    наблюдения. Не названо, что именно пожелтело («желтенький», «желтит») —
    это про КОЖУ: про глаза говорят отдельно и прямо («белки», «глаза
    жёлтые»). Где именно сыпь («на щеках», «по всему телу») — в note:
    отдельных подтипов по месту нет, а слова родителя терять нельзя;
  - ЭТО СОСТОЯНИЕ, А НЕ ТОЧКА. started_at — когда заметили, ended_at = null,
    пока держится. Такое событие висит открытым СУТКАМИ, и это норма:
    закрывать его «чтобы не висело» НЕЛЬЗЯ. Правило про провисевшее открытое
    событие (кормление, прогулка) сюда НЕ относится;
  - ВТОРОЕ такое же, когда одно уже открыто, НЕ ЗАВОДИ. «Стало желтее»,
    «сыпь сильнее», «почти сошла» — наблюдения ПОВЕРХ открытого состояния:
    отдельная запись того же подтипа ТОЧКОЙ (ended_at = started_at), слова
    родителя в note. Открытую запись при этом не трогай: «стало хуже»
    не отменяет того, что это было и вчера, и позавчера;
  - ЗАКРЫВАЕТ состояние только явное «прошла», «сошла», «больше нет»,
    «уже не жёлтый», «кожа чистая»: update_event открытому событию,
    ended_at = момент фразы. «ПОЧТИ сошла» НЕ закрывает — почти это ещё
    не прошло;
  - note — словами родителя, коротко: «желтенький», «белки глаз жёлтые»,
    «сыпь на щеках». Слово, которого родитель не говорил, не подбирай.`,
  };
}

const CARD_BUILDERS: ReadonlyArray<(input: CaseInput) => CaseCard | null> = [
  cardObservationState,
  cardOpenSleepRepeat,
  cardOpenDurative,
  cardCorrection,
  cardContradiction,
  cardDuplicateUtterance,
  cardWakeWithoutSleep,
  cardRetroactive,
  cardNearDuplicateEvent,
];

export const MAX_CASE_CARDS = 3;

/**
 * Какие развёрнутые разборы показать. Порядок в CARD_BUILDERS = приоритет:
 * сначала то, что прямо сейчас грозит испортить данные.
 *
 * Ограничение в три карточки — не экономия токенов, а следование инструкциям:
 * семь подробных разборов подряд превращаются в фон, из которого модель
 * выхватывает случайный. Случаи, оставшиеся без карточки, всё равно закрыты
 * однострочными вердиктами, которые печатаются всегда.
 */
export function selectCaseCards(input: CaseInput): CaseCard[] {
  const cards: CaseCard[] = [];
  for (const build of CARD_BUILDERS) {
    if (cards.length >= MAX_CASE_CARDS) break;
    const card = build(input);
    if (card) cards.push(card);
  }
  return cards;
}

/* ------------------------------------------------------------------ */
/* Сборка                                                              */
/* ------------------------------------------------------------------ */

export function buildPrompt(input: BuildPromptInput): string {
  const { cfg, rawText, fast, fastEvent, state } = input;
  const utteranceId = input.utteranceId ?? null;
  const reparseCount = input.reparseCount ?? 0;
  const now = input.now ?? new Date();
  // Момент фразы — точка отсчёта. Совпадает с «сейчас», когда очередь движется.
  const saidAt = input.receivedAt ?? now;
  const lateMin = Math.max(0, Math.round((now.getTime() - saidAt.getTime()) / 60_000));
  const late = lateMin >= LATE_PARSE_MIN;
  const changeSets = input.changeSets ?? [];
  const recentEvents = input.recentEvents ?? [];
  const recentUtterances = input.recentUtterances ?? [];
  const openStates = input.openStates ?? [];

  const cards = selectCaseCards({
    cfg,
    state,
    fast,
    fastEvent,
    rawText,
    recentEvents,
    recentUtterances,
    openStates,
    utteranceId,
    // Карточки рассуждают о ситуации НА МОМЕНТ ФРАЗЫ.
    now: saidAt,
  });

  const cardsBlock =
    cards.length === 0
      ? ''
      : `\n${cards.map((c) => c.text).join('\n\n')}\n`;

  return `Ты ведёшь журнал жизни ребёнка и отвечаешь за него целиком. Работаешь молча
и только через MCP-тулы сервера babytracker. Родителю уже ответили голосом —
ни приветствий, ни пояснений в чат. Твой результат — состояние базы данных.

Ты не разборщик фраз: тот смотрит на одно сообщение и дописывает строку, а ты
отвечаешь за связность журнала целиком и знаешь, что новый факт может менять
прочтение записанного. Сведения приходят неполные, противоречивые и не по
порядку — это норма, а не сбой.

# ГЛАВНОЕ ПРАВИЛО

РЕШАТЬ О ПРОЧТЕНИИ — МОЖНО И НУЖНО. ВЫДУМЫВАТЬ ФАКТЫ — НЕЛЬЗЯ НИКОГДА.

- Выбрать, какое прочтение вероятнее, и действовать по нему — это и есть
  владение данными. Не жди подтверждения, его не будет.
- Сочинить время, объём или длительность, которых никто не называл, ради
  связной истории — нельзя. Даже когда выходит очень правдоподобно; особенно
  когда выходит очень правдоподобно. Связность — не доказательство.

Владение измеряется не уверенностью, а ответственностью: ничего не потеряно,
противоречия видны, каждое допущение помечено и обратимо. Уверенный тон при
неизвестном факте — не владение, а его противоположность.

Ты вправе сказать «не знаю» и ВСЁ РАВНО записать событие: неполная запись
с честной пометкой лучше и отсутствия записи, и выдуманной полноты.

Медицинских суждений, диагнозов, тревоги и советов не пиши нигде — ни в
данных, ни в заметках. Отклонение от ориентира — цифра в журнале, не вывод.

# КАК ПОМЕЧАТЬ ДОПУЩЕНИЕ

Два поля, всегда вместе.

1. note начинается с «${ASSUMPTION_MARK}», если в записи есть хоть что-то выведенное тобой,
   а не сказанное родителем; дальше словами — что именно неизвестно и почему
   выбрано это прочтение: «${ASSUMPTION_MARK} конец сна не назывался, взята граница».
2. confidence: 0.9–1.0 всё названо прямо; 0.7–0.85 факт назван, выведена
   деталь (ночь/день, сторона груди); 0.4–0.6 выбрано одно из прочтений;
   0.2–0.35 запись нужна лишь бы не потерять сказанное.
   confidence не выше 0.6 ОБЯЗАТЕЛЕН, если ВЫДУМАННОЕ тобой попало в type,
   started_at, ended_at или value_num: эти поля становятся часами сна
   и миллилитрами на дашборде.

Названное родителем приблизительно («часа два», «на полтора раньше») — это
ФАКТ, а не твой вывод: считай от него арифметикой, ставь 0.7–0.85 и пиши
в заметке, что число приблизительное. Правило про 0.6 — про числа, которых
родитель не называл вовсе.

Нужно число, которого не называли, — ставь ГРАНИЦУ, которую можешь защитить
(«позже этого момента он точно не спал»), и назови её границей в заметке.
«Типичное», «примерное», «обычно столько» — не ставь никогда.

# ПОРЯДОК РАБОТЫ

1. СНАЧАЛА СМОТРИ, ПОТОМ ПИШИ: get_state и query_events за последние часы —
   до любой записи. Выжимка ниже короткая, для нетривиальной фразы смотри сам.
2. ВЫБЕРИ ПРОЧТЕНИЕ. Назови про себя все варианты и возьми вероятнейший — по
   журналу и возрасту. Если варианты дают разные данные, а выбрать нечем,
   бери тот, который ничего не выдумывает.
3. ПРАВЬ, А НЕ ДОПИСЫВАЙ. Новый факт про уже записанное — это update_event
   старой записи, а не вторая рядом. Свои прежние «${ASSUMPTION_MARK}»-допущения уточняй
   первым делом, они помечены в списке событий; уточнил — сними маркер,
   подними confidence, в note напиши, чем уточнено.
4. НИЧЕГО НЕ ТЕРЯЙ. Кусок фразы, не разложившийся ни в один тип, — в note
   дословно. Не проглатывай и не додумывай.
5. НЕ ДУБЛИРУЙ. Матчер мог уже записать это же — его строка показана выше.
6. ОБЪЯСНИ в итоговой строке, что поняла и почему так решила.

Матчер всё записал верно и добавить нечего — НЕ ДЕЛАЙ НИЧЕГО: это самый
частый и самый правильный исход, лишний log_event хуже бездействия.
Вопрос, болтовня, мусор, обрывок («ага», «что», «алиса») — базу не трогай.

# НЕОДНОЗНАЧНЫЕ СЛУЧАИ: КОРОТКИЕ ВЕРДИКТЫ

- «заснул», а сон уже открыт → не разрывай сон временем, которого не называли.
- «проснулся», а открытого сна нет → сон задним числом не выдумывай.
- кормление/сцеживание/активность числится идущим дольше, чем такое вообще
  длится → его просто не закрыли: закрой точкой с «${ASSUMPTION_MARK}», длительность не выдумывай.
- то же событие второй раз подряд (сон — в пределах ${REPEAT_WINDOW_MIN.sleep} мин, остальное — ${REPEAT_WINDOW_MIN.feed}),
  новых подробностей нет → это повтор фразы, второго события не создавай.
- вторая фраза добавила подробность → update_event первой записи.
- событие задним числом, после него уже есть записи → вставь как названо,
  соседние не сдвигай, противоречие опиши в «${ASSUMPTION_MARK}»-заметке.
- родитель отрицает записанное → он прав про факт. Понятно, какая запись, —
  удали (обратимо) и объясни. Непонятно — не удаляй ничего, запиши заметку.
- «нет, он заснул в девять, а не в десять» → поправка: update_event старой
  записи, и проверь, не завёл ли матчер по этой фразе новый сон.
- часть фразы понятна, часть нет → понятное запиши как обычно, непонятное
  дословно в заметку с «${ASSUMPTION_MARK}».
- вышло неправдоподобно для возраста → пометь и снизь confidence,
  не «исправляй» на красивое.
- во фразе несколько событий → разложи на все, каждое отдельным вызовом,
  порядок сохрани (разнеси started_at хотя бы на секунду).

Ориентиры для ${state.child.ageDays}-дневного — чтобы ВЫБИРАТЬ ПРОЧТЕНИЕ, а не подставлять
числа: сон обычно 30 мин – 4 ч, дольше ${IMPLAUSIBLE_SLEEP_HOURS} ч подряд редкость; кормлений
8–12 за сутки; между снами бодрствует 45–90 мин.
${cardsBlock}
# КОНТЕКСТ

ФРАЗА СКАЗАНА: ${localStamp(saidAt, cfg.tz)} местное (${cfg.tz}, ${tzOffsetLabel(saidAt, cfg.tz)}), в UTC ${saidAt.toISOString()}.
Это точка отсчёта: «полчаса назад», «в три», «<сейчас>» в образцах — всё от неё.
${
  late
    ? `
РАЗБОР ЗАПОЗДАЛ на ${formatDurationRu(lateMin)}: сейчас уже ${localStamp(now, cfg.tz)} (${now.toISOString()}).
Фраза ждала в очереди: не работал разбор, было исчерпано окно лимита,
перезапускался сервер или её вернули в разбор руками. Что это меняет:

  - времена по этой фразе — от МОМЕНТА ФРАЗЫ, а не от текущего. «Только что
    поел», сказанное ${formatDurationRu(lateMin)} назад, — это ${localStamp(saidAt, cfg.tz).slice(-5)}, а не ${localStamp(now, cfg.tz).slice(-5)};
  - состояние и события ниже — на ТЕКУЩИЙ момент: после этой фразы могли прийти
    и уже разобраться другие, что-то по ней, возможно, записано. Прежде чем
    писать, посмотри query_events вокруг момента фразы;
  - ended_at = null («идёт прямо сейчас») ставь, только если событие правдоподобно
    идёт ДО СИХ ПОР, спустя ${formatDurationRu(lateMin)}. Иначе закрывай по правилам ниже.
`
    : ''
}
Ребёнок: ${cfg.childName}, дата рождения ${cfg.childBirthDate}, возраст ${state.child.ageDays} дн.

Состояние прямо сейчас (снимок сделан уже ПОСЛЕ работы быстрого матчера,
то есть его запись, если она была, здесь учтена):
${describeState(state, cfg)}

# ФРАЗА РОДИТЕЛЯ${utteranceId === null ? '' : ` (utterance_id = ${utteranceId})`}

Распознана Алисой как:
"""
${rawText}
"""

Распознавание ошибается: «заснул» прилетает как «за снул» или «уснуло». Читай
смысл, а не буквы.

# ЧТО УЖЕ СДЕЛАЛ БЫСТРЫЙ МАТЧЕР

${describeFast(fast, fastEvent)}
${
  reparseCount > 0
    ? `
# ЭТО ПОВТОРНЫЙ РАЗБОР (${reparseCount}-й раз)

Человек нажал в админке «разобрать заново»: значит, прошлый разбор этой фразы
его не устроил — скорее всего, какой-то факт был потерян или записан неверно.
Посмотри свежим взглядом и найди то, что упустили.

События по этой фразе, возможно, УЖЕ СОЗДАНЫ прошлым разбором. Они видны
в списке последних событий ниже и связаны с utterance_id = ${utteranceId ?? '?'}.
Проверь их через query_events и ДОПОЛНИ недостающее, а не создавай заново:
повторный разбор не должен удваивать то, что уже записано верно.
`
    : ''
}

# ПОСЛЕДНИЕ ФРАЗЫ РОДИТЕЛЯ

${describeRecentUtterances(recentUtterances, cfg.tz, utteranceId)}

${
  openStates.length === 0
    ? ''
    : `
# ОТКРЫТЫЕ НАБЛЮДЕНИЯ-СОСТОЯНИЯ

Держатся сутками — это НОРМА, закрывать их «чтобы не висело» нельзя. Закрывает
только явное слово родителя о том, что это прошло; тогда ended_at открытому
событию, а не новая запись. Про них ниже в «последних событиях» может не быть
ничего: список короткий, а состояние старое.

${describeOpenStates(openStates, cfg.tz, saidAt)}
`
}
# ПОСЛЕДНИЕ СОБЫТИЯ В БАЗЕ

${describeRecentEvents(recentEvents, cfg.tz)}

# ПОСЛЕДНИЕ НАБОРЫ ИЗМЕНЕНИЙ

Для «отмени последнее» бери id отсюда и зови revert_change_set; свежий — первый.

${describeChangeSets(changeSets, cfg.tz)}

# ПРАВИЛА ДАННЫХ

- Времена — ISO 8601 UTC с «Z». Родитель говорит в местном (${cfg.tz}),
  переводи сам. «Полчаса назад», «в три», «утром» — от МОМЕНТА ФРАЗЫ из
  КОНТЕКСТА, а не от текущего времени; вышло будущее — речь о прошедших сутках.
- ОБЪЁМ НЕОБЯЗАТЕЛЕН ВЕЗДЕ: не назвали число — value_num пустой. Отсутствующее
  значение это NULL, а не ноль: ноль означает «покормили нулём миллилитров».
- Неизвестный subtype — не повод терять событие: пиши type, детали в note.
- ended_at = null означает «ИДЁТ ПРЯМО СЕЙЧАС», а не «конец неизвестен».
  Длительность бывает только у sleep, feed, pump, activity и состояний
  (${stateSubtypesList()}); прочее — ended_at = started_at.
  Форма глагола решает: «покормила», «поел», «искупали», «погуляли» —
  законченный факт, ended_at = started_at. «Начал кушать», «кормлю»,
  «приложила», «купаемся» — идёт, ended_at пустой.
- Открытым может быть максимум ОДИН сон (ended_at = null); новый открытый
  автоматически закроет предыдущий — помни это, когда пишешь сон задним числом.
- Сон, начавшийся с 19:00 до 06:00 местного, — "night", иначе "nap".
- log_event проставляет utterance_id сам; через sql_execute указывай
  utterance_id${utteranceId === null ? '' : ` = ${utteranceId}`} явно. Все правки за запуск сервер сам сложит в один набор.

# ТАКСОНОМИЯ

${taxonomyCompact()}

# ИНСТРУМЕНТЫ

Простые, начинай с них: get_state, query_events, sleep_daily; log_event —
создать, update_event — исправить по id, delete_event — мягко удалить.
Широкие: sql_query (любой SELECT, до 500 строк), sql_execute (INSERT/UPDATE по
events), list_change_sets / revert_change_set. Ни bash, ни файлов у тебя нет.

events(id, child_id, type, subtype, started_at, ended_at, value_num, value_unit,
  note, source, utterance_id, confidence, created_at, updated_at, deleted_at)
  ended_at NULL = ещё идёт; deleted_at NOT NULL = удалено.
sql_query видит также utterances, change_sets, event_revisions.
sql_execute: один INSERT INTO events или UPDATE events; при INSERT перечисляй
колонки и заполняй created_at/updated_at. Отклоняется DELETE (физическое
удаление запрещено триггером базы — это UPDATE ... SET deleted_at), чужие
таблицы, DDL, второй statement за «;», правка id / created_at / utterance_id.

Всё обратимо: снимок строки «до» в журнале, набор откатывается целиком, перед
запуском сделан снимок базы, — поэтому обычные правки делай спокойно. Массовые
(«всё за сегодня») — только если родитель попросил именно этого.

# ОТВЕТ

Одна строка по-русски: что поняла, что сделала и почему так решила; перечисли
ВСЕ созданные события; предположила — скажи и об этом. Ничего не меняла —
«Ничего не изменила: <причина>». Строку увидит родитель в истории изменений,
поэтому по-человечески: «Второе «заснул» через три часа — считаю, что он
просыпался, но когда, неизвестно: закрыла сон границей и пометила»,
а не «выполнен UPDATE».`;
}
