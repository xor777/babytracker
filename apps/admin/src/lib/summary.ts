/**
 * Арифметика «Сводки» — раздела, который показывают врачу.
 *
 * Здесь нет ни одной оценки: только факты и то, чем они подкреплены. Врач
 * сравнивает с ориентирами сам, это его работа. Наша — не подсунуть ему числа,
 * которых мы не заработали.
 *
 * Главное правило модуля: **«не было» и «не записали» — разные вещи**.
 * Сервер этой разницы не знает: `GET /api/stats/daily` отдаёт строку на каждые
 * сутки окна, и сутки без единой записи приходят нулями (см. `dailyStats` в
 * apps/server/src/events.ts). Отличить их можно только по самим событиям,
 * поэтому все средние здесь считаются по суткам, где нужное **записано**, а
 * знаменатель едет вместе со значением и показывается человеку.
 *
 * Ровно эта подмена и выстрелила на проде: подгузники записывали второй день из
 * четырнадцати, один подгузник за завершённые сутки поделили на всё окно и
 * написали «в среднем 0 в сутки». Врач читает «0» как обезвоживание.
 */
import type { DailyStats, GrowthPoint, TrackerEvent } from '../types';
import { DAY, MINUTE, localDateKey, parseTs, startOfLocalDay } from './format';

/* ------------------------------------------------------------------ *
 * Границы «ночи»
 * ------------------------------------------------------------------ */

/**
 * Ночь — с 00:00 до 06:00 по местному времени.
 *
 * Любая граница здесь условна, поэтому она не прячется: всюду, где число
 * ночных кормлений попадает на экран, рядом написано «00:00–06:00». Врач
 * читает определение, а не догадывается о нём.
 */
export const NIGHT_FROM_HOUR = 0;
export const NIGHT_TO_HOUR = 6;

/** Полсуток сверху — чтобы шаг по дням не спотыкался о переход на летнее время. */
const HALF_DAY = 12 * 60 * MINUTE;

/* ------------------------------------------------------------------ *
 * Сутки окна
 * ------------------------------------------------------------------ */

export interface DayCell {
  /** YYYY-MM-DD в местной зоне — тот же ключ, что у сервера. */
  date: string;
  /** Полночь этих суток, мс. */
  startMs: number;
  /** Возраст ребёнка в эти сутки; null — дата рождения неизвестна. */
  ageDays: number | null;
  /** Сутки ещё идут: сравнивать их с прожитыми нечестно. */
  today: boolean;
  /**
   * Есть ли за эти сутки хоть одна запись любого типа.
   * `null` — мы не знаем: лента событий не доехала или обрезана лимитом.
   * Это третье состояние, и оно не равно `false`.
   */
  recorded: boolean | null;
  /** null — кормлений за эти сутки не записано (а не «их не было»). */
  feeds: DailyStats['feeds'] | null;
  /** null — подгузников за эти сутки не записано. */
  diapers: DailyStats['diapers'] | null;
  /** null — сна за эти сутки не записано. */
  sleep: DailyStats['sleep'] | null;
  /** Последнее взвешивание этих суток. */
  weightG: number | null;
  /** Кормления в 00:00–06:00; null — события недоступны, считать не по чему. */
  nightFeeds: number | null;
  /** Ориентиры на возраст этих суток — как их прислал сервер (§10.1). */
  norms: DailyStats['norms'];
}

export interface WindowInput {
  /** Сводка от сервера, в любом порядке. */
  days: DailyStats[];
  /** Сырые события окна. Пустой массив и «не загрузились» — разные вещи, см. `eventsKnown`. */
  events: TrackerEvent[];
  /**
   * Лента событий пришла целиком и ей можно верить. `false` — запрос не удался
   * либо упёрся в лимит: тогда `recorded` честно остаётся неизвестным.
   */
  eventsKnown: boolean;
  /**
   * Самое старое событие, которое мы точно видели. Всё, что древнее, лимит мог
   * срезать — про такие сутки мы не знаем ничего, и врать «записей нет» нельзя.
   */
  oldestSeenMs?: number | null;
  /** Дата рождения, мс. Сутки до неё в окно не попадают вовсе. */
  birthMs?: number | null;
  now?: number;
}

/**
 * Сутки окна, от старых к новым, с отметкой «что здесь вообще записано».
 *
 * Дни до рождения выбрасываются: это не «данных нет», это «ребёнка ещё не было».
 * Сервер их не отличает — `ageDays` он зажимает в ноль (`Math.max(0, …)`),
 * поэтому граница проводится здесь, по дате рождения из `/api/state`.
 */
export function buildWindow(input: WindowInput): DayCell[] {
  const now = input.now ?? Date.now();
  const todayKey = localDateKey(now);
  const birthKey = input.birthMs != null ? localDateKey(input.birthMs) : null;

  // Сутки → были ли в них события, и сколько из них ночных кормлений.
  const anyByDay = new Set<string>();
  const nightByDay = new Map<string, number>();
  for (const e of input.events) {
    if (e.deleted_at) continue;
    const at = parseTs(e.started_at);
    if (at == null) continue;
    anyByDay.add(localDateKey(at));
    if (e.type === 'feed' && isNightHour(at)) {
      const key = localDateKey(at);
      nightByDay.set(key, (nightByDay.get(key) ?? 0) + 1);
    }
  }

  const sorted = [...input.days].sort((a, b) => a.date.localeCompare(b.date));
  const cells: DayCell[] = [];

  for (const d of sorted) {
    if (birthKey && d.date < birthKey) continue;
    if (d.date > todayKey) continue;

    const startMs = startOfLocalDay(parseTs(`${d.date}T12:00:00`) ?? now);

    // Знаем ли мы про эти сутки хоть что-то. Лимит ленты режет самое старое,
    // поэтому за краем виденного — не «нет записей», а «неизвестно».
    let recorded: boolean | null;
    if (!input.eventsKnown) recorded = null;
    else if (input.oldestSeenMs != null && startMs + DAY <= input.oldestSeenMs) recorded = null;
    else recorded = anyByDay.has(d.date);

    // Сводка сервера считает события: ноль здесь означает ровно «ни одной
    // записи этого рода за сутки», а не «ничего не происходило».
    cells.push({
      date: d.date,
      startMs,
      ageDays: ageOn(input.birthMs, startMs),
      today: d.date === todayKey,
      recorded,
      feeds: d.feeds.total > 0 ? d.feeds : null,
      diapers: d.diapers.total > 0 ? d.diapers : null,
      sleep: d.sleep.sessions > 0 || d.sleep.totalMin > 0 ? d.sleep : null,
      weightG: d.measures.weightG,
      nightFeeds: input.eventsKnown && recorded !== null ? (nightByDay.get(d.date) ?? 0) : null,
      norms: d.norms,
    });
  }

  return cells;
}

function isNightHour(ms: number): boolean {
  const h = new Date(ms).getHours();
  return h >= NIGHT_FROM_HOUR && h < NIGHT_TO_HOUR;
}

/** Возраст в сутках на указанный момент. Календарный, а не по часам. */
function ageOn(birthMs: number | null | undefined, ms: number): number | null {
  if (birthMs == null) return null;
  return Math.round((startOfLocalDay(ms) - startOfLocalDay(birthMs)) / DAY);
}

/* ------------------------------------------------------------------ *
 * Полнота дневника
 * ------------------------------------------------------------------ */

export interface Coverage {
  /** Сутки окна, от старых к новым. */
  cells: DayCell[];
  /** Сколько суток окна прожиты (само окно уже обрезано рождением и «сегодня»). */
  total: number;
  /** Из них с записями. */
  recorded: number;
  /** Из них точно без записей. */
  blank: number;
  /** Из них неизвестных: лента не доехала или обрезана. */
  unknown: number;
  /** Первые сутки окна, в которых что-то записано. */
  firstRecordedDate: string | null;
  /** Сколько суток жизни ребёнка вообще прошло к «сегодня». */
  ageDays: number | null;
  /** Дневник покрывает всю жизнь ребёнка: окно начинается не позже рождения. */
  fromBirth: boolean;
}

export function coverage(cells: DayCell[], birthMs?: number | null, now = Date.now()): Coverage {
  let recorded = 0;
  let blank = 0;
  let unknown = 0;
  let firstRecordedDate: string | null = null;

  for (const c of cells) {
    if (c.recorded === null) unknown += 1;
    else if (c.recorded) {
      recorded += 1;
      if (!firstRecordedDate) firstRecordedDate = c.date;
    } else blank += 1;
  }

  const ageDays = ageOn(birthMs, now);
  const fromBirth =
    birthMs != null && cells.length > 0 && cells[0].startMs <= startOfLocalDay(birthMs);

  return {
    cells,
    total: cells.length,
    recorded,
    blank,
    unknown,
    firstRecordedDate,
    ageDays,
    fromBirth,
  };
}

/* ------------------------------------------------------------------ *
 * Средние за сутки
 * ------------------------------------------------------------------ */

export interface Avg {
  /** Среднее за сутки. НЕ округлено: округление — забота форматирования. */
  value: number;
  /** По скольким суткам посчитано. Уезжает на экран вместе со значением. */
  days: number;
  /** Сумма, из которой оно получилось. */
  total: number;
}

/**
 * Среднее за сутки по завершённым суткам, где нужное записано.
 *
 * Два решения, и оба обязательны, иначе получается число, которого не было:
 *
 * 1. **Сегодня не в счёт.** Сутки ещё идут, и неполный день тянет среднее вниз.
 * 2. **Сутки без записей не в знаменателе.** `pick` возвращает `null` — сутки
 *    выбрасываются целиком. Именно здесь ломалась прода: делили на всё окно.
 *
 * А вот `0`, вернувшийся из `pick`, — полноценное слагаемое. Если подгузники за
 * сутки записывали, то «грязных 0» — это факт, а не пробел. Поэтому `pick`
 * задаётся на семейство событий (кормления / подгузники / сон), а не на каждое
 * число по отдельности.
 *
 * `null` на выходе — «считать не по чему». Это не ноль и показывать его нулём нельзя.
 */
export function averagePerDay(
  cells: DayCell[],
  pick: (c: DayCell) => number | null,
): Avg | null {
  let total = 0;
  let days = 0;
  for (const c of cells) {
    if (c.today) continue;
    const v = pick(c);
    if (v == null || !Number.isFinite(v)) continue;
    total += v;
    days += 1;
  }
  if (days === 0) return null;
  return { value: total / days, days, total };
}

/* ------------------------------------------------------------------ *
 * Недели
 * ------------------------------------------------------------------ */

export interface WeekRow {
  /** 1 — первая неделя жизни. */
  index: number;
  label: string;
  cells: DayCell[];
  /** Сутки недели с записями. */
  recorded: number;
  /** Всего прожитых суток в этой неделе окна. */
  total: number;
}

/**
 * Разбивка окна на недели жизни, а не на календарные недели.
 *
 * Врач думает «первая неделя, вторая неделя», и считает от рождения. Календарный
 * понедельник тут ни при чём. Без даты рождения недель нет — и выдумывать их
 * от «сегодня» нельзя: получится сдвиг, который никто не заметит.
 */
export function weeks(cells: DayCell[]): WeekRow[] {
  const out = new Map<number, WeekRow>();
  for (const c of cells) {
    if (c.ageDays == null) continue;
    const index = Math.floor(c.ageDays / 7) + 1;
    let row = out.get(index);
    if (!row) {
      row = { index, label: `${index}-я неделя`, cells: [], recorded: 0, total: 0 };
      out.set(index, row);
    }
    row.cells.push(c);
    row.total += 1;
    if (c.recorded) row.recorded += 1;
  }
  return [...out.values()].sort((a, b) => a.index - b.index);
}

export interface WeekStats {
  week: WeekRow;
  feeds: Avg | null;
  wet: Avg | null;
  dirty: Avg | null;
  sleepMin: Avg | null;
  /**
   * Прибавка за эту неделю: последнее взвешивание недели минус последнее до неё.
   * null — взвешиваний не хватило, чтобы получилась разница.
   */
  weightDeltaG: number | null;
  /** За сколько суток эта разница набралась — без него граммы не читаются. */
  weightSpanDays: number | null;
}

/**
 * Неделя как строка таблицы: сколько суток записано и что в среднем за сутки.
 *
 * Прибавка веса считается не «первое и последнее взвешивание внутри недели», а
 * «последнее до недели → последнее в неделе». Иначе первая же неделя потеряет
 * весь провал и весь возврат: между взвешиванием в понедельник и в пятницу
 * лежит не неделя, а четыре дня, и подписать это «прибавка за неделю» нельзя.
 */
export function weekStats(rows: WeekRow[], weights: GrowthPoint[]): WeekStats[] {
  const pts = [...weights].sort((a, b) => a.at - b.at);

  return rows.map((week) => {
    const from = week.cells[0].startMs;
    const to = week.cells[week.cells.length - 1].startMs + DAY;

    const inside = pts.filter((p) => p.at >= from && p.at < to);
    const before = pts.filter((p) => p.at < from).at(-1) ?? null;
    const last = inside.at(-1) ?? null;
    // Точка отсчёта — последнее взвешивание до недели. Если его нет (это первая
    // неделя жизни), отсчитываем от первого взвешивания внутри неё.
    const base = before ?? inside[0] ?? null;

    const haveDelta = last != null && base != null && last !== base;

    return {
      week,
      feeds: averagePerDay(week.cells, (c) => (c.feeds ? c.feeds.total : null)),
      wet: averagePerDay(week.cells, (c) => (c.diapers ? c.diapers.wet : null)),
      dirty: averagePerDay(week.cells, (c) => (c.diapers ? c.diapers.dirty : null)),
      sleepMin: averagePerDay(week.cells, (c) => (c.sleep ? c.sleep.totalMin : null)),
      weightDeltaG: haveDelta ? last.value - base.value : null,
      weightSpanDays: haveDelta
        ? Math.max(1, Math.round((startOfLocalDay(last.at) - startOfLocalDay(base.at)) / DAY))
        : null,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Вес
 * ------------------------------------------------------------------ */

export interface WeightPoint extends GrowthPoint {
  /** Возраст в сутках на момент взвешивания; null — дата рождения неизвестна. */
  ageDays: number | null;
}

export interface WeightRate {
  /** Граммов в сутки. Может быть отрицательным — это тоже факт. */
  perDay: number;
  /** Календарных суток между взвешиваниями, всегда ≥ 1. */
  days: number;
  from: WeightPoint;
  to: WeightPoint;
}

export interface WeightFacts {
  /** Самое раннее взвешивание — точка отсчёта. */
  birth: WeightPoint;
  /** Самое свежее. */
  last: WeightPoint;
  count: number;
  /** Сколько всего набрано/потеряно от первого взвешивания. */
  fromBirthG: number;
  /**
   * Наименьшее взвешивание и насколько оно ниже первого.
   * `null` — ниже первого не опускались ни разу (или взвешивание одно).
   */
  nadir: { point: WeightPoint; lossG: number; lossPct: number } | null;
  /**
   * Первое взвешивание после провала, где вес не ниже исходного.
   * `null` — такого пока не записано. Это «не зафиксировано», а не «не вернулся».
   */
  regained: WeightPoint | null;
  /** Между двумя последними взвешиваниями. null — они в одни сутки. */
  recent: WeightRate | null;
  /** От минимума до последнего взвешивания. null — минимума нет или он сегодня. */
  sinceNadir: WeightRate | null;
}

/**
 * Что врач спрашивает про вес в первые недели, ровно в этом порядке: сколько
 * было при рождении, насколько провалился, вернулся ли, сколько прибавляет.
 *
 * Отдельно про «сколько прибавляет»: прибавка считается **между двумя
 * последними взвешиваниями**, а не от рождения. Взвешиваний три-четыре за две
 * недели, между ними провал первых суток, и «от рождения делить на возраст»
 * даёт число, не означающее ничего: оно смешивает потерю и набор. Поэтому
 * отдаём обе величины по отдельности и каждую подписываем, от чего она.
 *
 * Разница в сутках — календарная и целая. Два взвешивания в одни сутки прибавку
 * в сутки не дают вовсе: делить на ноль нельзя, а делить на «полдня» — значит
 * умножить погрешность весов на два и выдать результат за факт.
 */
export function weightFacts(
  points: GrowthPoint[],
  birthMs?: number | null,
): WeightFacts | null {
  if (points.length === 0) return null;

  // Без даты рождения возраст остаётся null. Подставлять сюда первое взвешивание
  // соблазнительно и неверно: «на 3-и сутки» превратится в «через 3 дня после
  // первого взвешивания», а подпись на экране останется прежней.
  const pts: WeightPoint[] = [...points]
    .sort((a, b) => a.at - b.at)
    .map((p) => ({ ...p, ageDays: ageOn(birthMs, p.at) }));

  const birth = pts[0];
  const last = pts[pts.length - 1];

  let minIdx = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].value < pts[minIdx].value) minIdx = i;

  const nadir =
    pts[minIdx].value < birth.value
      ? {
          point: pts[minIdx],
          lossG: birth.value - pts[minIdx].value,
          lossPct: ((birth.value - pts[minIdx].value) / birth.value) * 100,
        }
      : null;

  let regained: WeightPoint | null = null;
  if (nadir) {
    for (let i = minIdx + 1; i < pts.length; i++) {
      if (pts[i].value >= birth.value) {
        regained = pts[i];
        break;
      }
    }
  }

  return {
    birth,
    last,
    count: pts.length,
    fromBirthG: last.value - birth.value,
    nadir,
    regained,
    recent: rateBetween(pts[pts.length - 2], last),
    sinceNadir: nadir ? rateBetween(nadir.point, last) : null,
  };
}

/** Прибавка между двумя взвешиваниями. null — их меньше двух или они в одни сутки. */
function rateBetween(from: WeightPoint | undefined, to: WeightPoint): WeightRate | null {
  if (!from || from === to) return null;
  const days = Math.round((startOfLocalDay(to.at) - startOfLocalDay(from.at)) / DAY);
  if (days < 1) return null;
  return { perDay: (to.value - from.value) / days, days, from, to };
}

/* ------------------------------------------------------------------ *
 * Сон и кормления по сырым событиям
 * ------------------------------------------------------------------ */

export interface SleepStretch {
  minutes: number;
  startedAt: number;
  endedAt: number;
}

export interface SleepFacts {
  /** Самый длинный завершённый отрезок — целиком, без резки по полуночи. */
  longest: SleepStretch | null;
  /** Сон, который идёт прямо сейчас: сколько уже. Завершённым его считать нельзя. */
  openMin: number | null;
  /** Сколько отрезков учтено. */
  closed: number;
}

/**
 * Самый длинный сон — как его прожил ребёнок, а не как он лёг на календарь.
 *
 * Сводка сервера режет сон по полуночи (и правильно: суточный итог иначе
 * поедет). Но «самый длинный отрезок» из порезанного собрать нельзя: ночь
 * с 22:10 до 6:35 превращается в 1 ч 50 мин и 6 ч 35 мин, и на экран уходит
 * шесть с половиной часов вместо восьми с половиной. Поэтому длину берём
 * с самого события.
 *
 * Идущий сон в «самый длинный» не попадает: он ещё не кончился, и его длина —
 * не результат, а показание секундомера. Но и потерять его нельзя, поэтому он
 * возвращается отдельным полем.
 */
export function sleepFacts(
  events: TrackerEvent[],
  fromMs: number,
  now = Date.now(),
): SleepFacts {
  let longest: SleepStretch | null = null;
  let openMin: number | null = null;
  let closed = 0;

  for (const e of events) {
    if (e.deleted_at || e.type !== 'sleep') continue;
    const start = parseTs(e.started_at);
    if (start == null || start < fromMs) continue;

    const end = parseTs(e.ended_at);
    if (end == null) {
      // Незакрытый сон: считаем от начала до «сейчас», но завершённым не зовём.
      const min = Math.max(0, Math.round((now - start) / MINUTE));
      openMin = Math.max(openMin ?? 0, min);
      continue;
    }
    if (end <= start) continue;

    closed += 1;
    const minutes = Math.round((end - start) / MINUTE);
    if (!longest || minutes > longest.minutes) {
      longest = { minutes, startedAt: start, endedAt: end };
    }
  }

  return { longest, openMin, closed };
}

export interface FeedGapFacts {
  /** Самый длинный промежуток между записанными кормлениями, минуты. */
  maxMin: number;
  /** Когда он начался — врачу важно «когда», а не только «сколько». */
  fromAt: number;
  toAt: number;
  /** Сколько промежутков вообще удалось посчитать. */
  count: number;
}

/**
 * Самый длинный промежуток между кормлениями — но только тот, который мы
 * действительно наблюдали.
 *
 * Тут прячется соблазнительная ложь. Если записывали 8-го и 15-го, то между
 * последним кормлением 8-го и первым 15-го «промежуток» в семь суток. Ребёнок
 * семь суток не ел — это не факт, это дыра в дневнике, выданная за факт.
 *
 * Поэтому промежуток засчитывается, только если **все сутки, которые он
 * задевает, записаны**. Промежуток внутри записанных суток — наблюдение;
 * промежуток через пробел — нет.
 */
export function feedGapFacts(events: TrackerEvent[], cells: DayCell[]): FeedGapFacts | null {
  const recorded = new Set(cells.filter((c) => c.recorded).map((c) => c.date));

  const times: number[] = [];
  for (const e of events) {
    if (e.deleted_at || e.type !== 'feed') continue;
    const at = parseTs(e.started_at);
    if (at != null) times.push(at);
  }
  times.sort((a, b) => a - b);

  let best: FeedGapFacts | null = null;
  let count = 0;

  for (let i = 1; i < times.length; i++) {
    const from = times[i - 1];
    const to = times[i];
    // Нулевой промежуток — дубль разбора, а не промежуток (см. timeline.feedGaps).
    if (to - from < MINUTE) continue;
    if (!spanIsRecorded(from, to, recorded)) continue;

    count += 1;
    const minutes = Math.round((to - from) / MINUTE);
    if (!best || minutes > best.maxMin) {
      best = { maxMin: minutes, fromAt: from, toAt: to, count };
    }
  }

  return best ? { ...best, count } : null;
}

/** Все сутки, которые задевает промежуток, записаны. */
function spanIsRecorded(from: number, to: number, recorded: Set<string>): boolean {
  for (let d = startOfLocalDay(from); d <= startOfLocalDay(to); d = startOfLocalDay(d + DAY + HALF_DAY)) {
    if (!recorded.has(localDateKey(d))) return false;
  }
  return true;
}
