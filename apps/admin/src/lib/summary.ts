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
 *
 * Отсюда же второе правило: **записано — это записано ПО РОДУ СОБЫТИЙ**. Сутки,
 * в которые взвесили ребёнка и больше ничего, дневником считаются, а кормлений
 * в них не записано, и в разговоре о кормлениях они такой же пробел, как сутки
 * без единой записи. Общий `DayCell.recorded` отвечает только за полноту
 * дневника; про кормления, подгузники и сон спрашивают `feeds`, `diapers`,
 * `sleep` — и спрашивают их все разом: и график, и среднее, и знаменатель.
 */
import type { DailyStats, GrowthPoint, TrackerEvent } from '../types';
import { DAY, MINUTE, formatDayShort, localDateKey, parseTs, plural, startOfLocalDay } from './format';
import { isTemperatureReading } from '../../../../shared/taxonomy';

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
   * Есть ли за эти сутки хоть одна запись **любого** типа.
   * `null` — мы не знаем: лента событий не доехала или обрезана лимитом.
   * Это третье состояние, и оно не равно `false`.
   *
   * Отвечает ровно на один вопрос — «вели ли в эти сутки дневник вообще», —
   * и годится только для карточки полноты. Решать по нему что-либо про
   * кормления, подгузники или сон нельзя: сутки, в которые записали одно
   * взвешивание, дневником считаются, а кормлений в них не записано.
   */
  recorded: boolean | null;
  /**
   * Кормления за сутки; `null` — **кормлений не записано** (а не «их не было»).
   *
   * Эти три поля и есть покрытие ПО РОДУ событий: `feeds !== null` означает
   * «сутки записаны по кормлениям», и никакого другого признака для этого нет.
   * И график, и среднее, и знаменатель под ним обязаны спрашивать одно и то же
   * поле — иначе столбики и число под ними считают записанными разные сутки.
   */
  feeds: DailyStats['feeds'] | null;
  /** null — подгузников за эти сутки не записано. Покрытие по подгузникам. */
  diapers: DailyStats['diapers'] | null;
  /** null — сна за эти сутки не записано. Покрытие по сну. */
  sleep: DailyStats['sleep'] | null;
  /** Последнее взвешивание этих суток. */
  weightG: number | null;
  /**
   * Кормления в 00:00–06:00.
   *
   * `null` — считать не по чему: либо кормлений за сутки не записано вовсе,
   * либо события недоступны. Ноль здесь ставится только тем суткам, где
   * кормления записаны, а ночных среди них не оказалось.
   */
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
    // записи этого рода за сутки», а не «ничего не происходило». Отсюда и
    // покрытие по роду: считает сам сервер, по всей базе, и лимит ленты его
    // не режет — поэтому про кормления эти три поля знают точнее, чем `recorded`.
    const feeds = d.feeds.total > 0 ? d.feeds : null;

    cells.push({
      date: d.date,
      startMs,
      ageDays: ageOn(input.birthMs, startMs),
      today: d.date === todayKey,
      recorded,
      feeds,
      diapers: d.diapers.total > 0 ? d.diapers : null,
      sleep: d.sleep.sessions > 0 || d.sleep.totalMin > 0 ? d.sleep : null,
      weightG: d.measures.weightG,
      // Ночные считаются только там, где кормления вообще записаны. Иначе ноль
      // уезжал бы в знаменатель средних за сутки, когда дневник не вели, —
      // ровно та подмена, из-за которой прода написала «0 подгузников в сутки».
      nightFeeds:
        feeds && input.eventsKnown && recorded !== null ? (nightByDay.get(d.date) ?? 0) : null,
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

/**
 * Столбики графика — по тому же `pick`, что и среднее под ним.
 *
 * Функция трёхстрочная, и существует она ради одной вещи: график и число под
 * ним обязаны считать записанными ОДНИ И ТЕ ЖЕ сутки. Раньше столбики рисовали
 * пробел по `recorded` («есть хоть какая-то запись»), а среднее выбрасывало
 * сутки по своему роду событий — и сутки, в которые записали одно взвешивание,
 * оказывались на графике кормлений нулём, а в знаменателе не оказывались вовсе.
 * Ноль, которого никто не записывал, — это и есть выдуманный факт.
 *
 * `null` в `primary` — «за эти сутки такого не записано»: штриховка, не ноль.
 */
export function dayBars(
  cells: DayCell[],
  pick: (c: DayCell) => number | null,
): Array<{ date: string; primary: number | null }> {
  return cells.map((c) => ({ date: c.date, primary: pick(c) }));
}

/* ------------------------------------------------------------------ *
 * Подгузники: из двух пересекающихся рядов — в непересекающиеся кучки
 * ------------------------------------------------------------------ */

/**
 * Сколько подгузников какого рода сменили за сутки — **без единого двойного счёта**.
 *
 * Сервер отдаёт два пересекающихся ряда (`dailyStats` в apps/server/src/events.ts):
 * подгузник с подтипом `both` прибавлен и к `wet`, и к `dirty`, а сам он лежит
 * третьим числом. Так и надо для сравнения с ориентирами — «6+ мокрых» считает
 * все мокрые, — но рисовать по этим числам штуки нельзя: `wet + dirty` больше,
 * чем подгузников сменили, и картинка соврала бы в бо́льшую сторону.
 *
 * Здесь ряды раскладываются на три непересекающиеся кучки, сумма которых равна
 * числу сменённых подгузников:
 *
 *     wetOnly + both + dirtyOnly + unknown === total
 *
 * Обратно тоже сходится: `wetOnly + both === wet`, `dirtyOnly + both === dirty`.
 * Это и есть условие честной картинки — один подгузник, один знак.
 */
export interface DiaperMarks {
  /** Только мокрый. */
  wetOnly: number;
  /** И мокрый, и грязный — ОДИН подгузник. Он в обоих рядах, но знак у него один. */
  both: number;
  /** Только грязный. */
  dirtyOnly: number;
  /**
   * Подгузник записан, а мокрый он или грязный — не разобрали (`subtype` пустой).
   * Такие есть на проде, и молча терять их нельзя: без них нарисованных знаков
   * окажется меньше, чем подгузников сменили.
   */
  unknown: number;
  /** Сколько подгузников за сутки сменили. Ровно столько знаков и рисуем. */
  total: number;
}

/**
 * Разложить суточные подгузники на непересекающиеся кучки.
 *
 * `null` на входе — за сутки подгузников не записано; `null` и на выходе,
 * потому что это не ноль (см. шапку модуля).
 *
 * Числа с сервера подстрахованы: `both` не может быть больше ни `wet`, ни
 * `dirty`, ни `total`, а если кучки всё равно не влезают в `total` (рассогласование,
 * которого быть не должно), лишнее срезается — начиная с грязных, потом мокрые,
 * потом пересечение. Нарисованное обязано не превышать сменённое даже на битых
 * данных: лучше показать меньше, чем придумать подгузник.
 */
export function diaperMarks(d: DailyStats['diapers'] | null | undefined): DiaperMarks | null {
  if (!d) return null;

  const total = int(d.total);
  const wet = Math.min(int(d.wet), total);
  const dirty = Math.min(int(d.dirty), total);
  let both = Math.min(int(d.both), wet, dirty, total);
  let wetOnly = Math.max(0, wet - both);
  let dirtyOnly = Math.max(0, dirty - both);

  let over = wetOnly + dirtyOnly + both - total;
  if (over > 0) {
    const cut = (n: number) => {
      const c = Math.min(n, over);
      over -= c;
      return n - c;
    };
    dirtyOnly = cut(dirtyOnly);
    wetOnly = cut(wetOnly);
    both = cut(both);
  }

  const unknown = Math.max(0, total - wetOnly - dirtyOnly - both);
  return { wetOnly, both, dirtyOnly, unknown, total };
}

/** Целое и неотрицательное: с сервера может прийти что угодно, а рисуем мы штуки. */
function int(v: number | null | undefined): number {
  return Number.isFinite(v) ? Math.max(0, Math.floor(v as number)) : 0;
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

/** Промежуток между двумя соседними записанными кормлениями. */
export interface FeedGap {
  minutes: number;
  /** Когда он начался — врачу важно «когда», а не только «сколько». */
  fromAt: number;
  toAt: number;
}

export interface FeedGapFacts {
  /** Самый длинный промежуток, который мы действительно наблюдали. `null` — таких нет. */
  longest: FeedGap | null;
  /** Сколько промежутков засчитано. */
  count: number;
  /**
   * Перерывы в ЗАПИСЯХ о кормлении дольше суток, от старых к новым.
   *
   * Это не наблюдение, а пробел в дневнике, и в `longest` они не попадают.
   * Но и молчать о них нельзя: перерыв есть, он в дневнике виден, и врач
   * должен знать, что тут записей не делали.
   */
  breaks: FeedGap[];
}

/**
 * Дольше этого промежуток означает, что целые сутки прошли без единой записи
 * о кормлении. Ребёнок сутки не ел — это не наблюдение, это дыра в дневнике.
 */
const MAX_OBSERVED_GAP = 24 * 60 * MINUTE;

/**
 * Самый длинный промежуток между кормлениями — но только тот, который мы
 * действительно наблюдали.
 *
 * Тут прячется соблазнительная ложь. Если записывали 8-го и 15-го, то между
 * последним кормлением 8-го и первым 15-го «промежуток» в семь суток. Ребёнок
 * семь суток не ел — это не факт, это дыра в дневнике, выданная за факт.
 *
 * Отсекается это двумя правилами, и нужны оба:
 *
 * 1. **Сутки, которые промежуток задевает, записаны именно по КОРМЛЕНИЯМ.**
 *    «Есть хоть какая-то запись» тут не годится и однажды уже не сгодилось:
 *    в сутки, где записали только подгузники, кормления не записаны, а
 *    промежуток через них проходил как наблюдённый.
 * 2. **Промежуток длиннее суток не наблюдение.** Правила (1) мало: 14-го
 *    записали 4 кормления, 15-го — 3, оба дня «записаны по кормлениям», а
 *    между последним 14-го и первым 15-го — тридцать часов. Дневник вели
 *    не сплошь, и тридцатичасовой голод — вывод, которого никто не наблюдал.
 *    Заодно это правило чинит и обрезанную лимитом ленту: пропущенные сутки
 *    кормлений всегда дают промежуток больше суток, и он уйдёт в `breaks`.
 *
 * Такие перерывы не выбрасываются, а складываются в `breaks` — карточка
 * называет их отдельно и своими словами, без «мало» и «много».
 */
export function feedGapFacts(events: TrackerEvent[], cells: DayCell[]): FeedGapFacts {
  const recorded = new Set(cells.filter((c) => c.feeds != null).map((c) => c.date));

  const times: number[] = [];
  for (const e of events) {
    if (e.deleted_at || e.type !== 'feed') continue;
    const at = parseTs(e.started_at);
    if (at != null) times.push(at);
  }
  times.sort((a, b) => a - b);

  let longest: FeedGap | null = null;
  let count = 0;
  const breaks: FeedGap[] = [];

  for (let i = 1; i < times.length; i++) {
    const from = times[i - 1];
    const to = times[i];
    // Нулевой промежуток — дубль разбора, а не промежуток (см. timeline.feedGaps).
    if (to - from < MINUTE) continue;

    const gap: FeedGap = { minutes: Math.round((to - from) / MINUTE), fromAt: from, toAt: to };

    if (to - from > MAX_OBSERVED_GAP) {
      breaks.push(gap);
      continue;
    }
    if (!spanIsRecorded(from, to, recorded)) continue;

    count += 1;
    if (!longest || gap.minutes > longest.minutes) longest = gap;
  }

  return { longest, count, breaks };
}

/* ------------------------------------------------------------------ *
 * Наблюдения-состояния
 * ------------------------------------------------------------------ */

export interface ObservationSpan {
  /** Когда заметили, мс. */
  fromMs: number;
  /** Когда сошло, мс. `null` — держится до сих пор. */
  toMs: number | null;
  /** День жизни, с которого отмечали (1-based: день рождения — 1-й день). */
  fromDay: number | null;
  /** День жизни, по который отмечали. `null` — ещё держится. */
  toDay: number | null;
}

export interface ObservationFacts {
  subtype: string;
  /** Отрезки, когда наблюдение ДЕРЖАЛОСЬ, от старых к новым, пересечения слиты. */
  spans: ObservationSpan[];
  /** Отметки поверх состояния («стало желтее») — моменты, мс. */
  marks: number[];
  /** Всего записей этого рода в окне: и отрезки, и отметки. */
  records: number;
  /** Держится прямо сейчас. */
  ongoing: boolean;
  /**
   * Самая ранняя запись пришлась на первые сутки окна.
   *
   * Значит, «с такого-то дня» — это начало ОКНА, а не обязательно начало
   * наблюдения: что было раньше, в выборку не попало. Разница та же, что
   * между «не было» и «не записали», и молчать о ней нельзя.
   */
  atWindowEdge: boolean;
}

/**
 * День жизни, 1-based: сутки рождения — «1-й день».
 *
 * Именно так считает врач и так же считает `normsForAge` на сервере
 * («возраст 0 дней = первые сутки»). Возраст в сутках (0-based) и день жизни
 * различаются на единицу, и перепутать их — значит сдвинуть всю картину на
 * день, чего никто не заметит.
 */
export function dayOfLife(birthMs: number | null | undefined, ms: number): number | null {
  const age = ageOn(birthMs, ms);
  return age == null ? null : age + 1;
}

/**
 * Протяжённость наблюдений-состояний — то, ради чего у них есть `ended_at`.
 *
 * Врача интересует не «сколько раз сказали», а «с какого дня и прошло ли».
 * Поэтому события одного подтипа делятся надвое:
 *
 * - ОТРЕЗОК — запись с протяжённостью: либо открытая (`ended_at` пустой,
 *   держится), либо закрытая (`ended_at` позже начала). Из них и собирается
 *   «с 5-го по 9-й день»;
 * - ОТМЕТКА — запись-точка (`ended_at` равен `started_at`): «стало желтее»,
 *   «почти сошла». Это наблюдение ПОВЕРХ состояния, и границ оно не двигает:
 *   иначе одна реплика «почти сошла» удлинила бы отрезок до дня, когда
 *   желтизна уже проходила.
 *
 * Пересекающиеся отрезки сливаются: два открытых состояния подряд — это сбой
 * разбора, а не два эпизода, и показывать их врачу как два не надо.
 */
export function observationFacts(
  events: TrackerEvent[],
  subtypes: string[],
  opts: { birthMs?: number | null; windowStartMs?: number | null } = {},
): ObservationFacts[] {
  const out: ObservationFacts[] = [];

  for (const subtype of subtypes) {
    const raw = events.filter(
      (e) => !e.deleted_at && e.type === 'symptom' && e.subtype === subtype,
    );

    const spansRaw: Array<{ from: number; to: number | null }> = [];
    const marks: number[] = [];
    let earliest: number | null = null;

    for (const e of raw) {
      const from = parseTs(e.started_at);
      if (from == null) continue;
      earliest = earliest == null ? from : Math.min(earliest, from);

      const to = parseTs(e.ended_at);
      // Точка: конец совпал с началом — это отметка, а не отрезок.
      if (to != null && to <= from) {
        marks.push(from);
        continue;
      }
      spansRaw.push({ from, to });
    }

    if (spansRaw.length === 0 && marks.length === 0) continue;

    spansRaw.sort((a, b) => a.from - b.from);

    // Слияние пересекающихся. Открытый отрезок поглощает всё, что после него.
    const merged: Array<{ from: number; to: number | null }> = [];
    for (const s of spansRaw) {
      const last = merged[merged.length - 1];
      if (last && (last.to === null || last.to >= s.from)) {
        if (last.to !== null) last.to = s.to === null ? null : Math.max(last.to, s.to);
        continue;
      }
      merged.push({ ...s });
    }

    const ongoing = merged.some((s) => s.to === null);

    out.push({
      subtype,
      spans: merged.map((s) => ({
        fromMs: s.from,
        toMs: s.to,
        fromDay: dayOfLife(opts.birthMs, s.from),
        toDay: s.to === null ? null : dayOfLife(opts.birthMs, s.to),
      })),
      marks: marks.sort((a, b) => a - b),
      records: raw.length,
      ongoing,
      atWindowEdge:
        earliest != null &&
        opts.windowStartMs != null &&
        earliest < startOfLocalDay(opts.windowStartMs) + DAY,
    });
  }

  return out;
}

/**
 * Наблюдение одной фразой — так, как его читает врач.
 *
 * «Родители отмечали желтизну кожи с 5-го по 9-й день» / «отмечают с 5-го дня,
 * продолжается». Здесь нет и не может быть ни оценки, ни причины, ни
 * медицинского названия: страница сообщает, ЧТО РОДИТЕЛИ ВИДЕЛИ И КОГДА.
 * Что это значит — вопрос к врачу, и отвечать на него за него мы не будем.
 *
 * Время сказано днями жизни, а не датами: врач думает «на пятый день», и
 * пересчитывать даты в возраст у него на осмотре — лишняя работа и лишний
 * шанс ошибиться. Даты идут отдельной строкой, подписью.
 */
export function observationPhrase(f: ObservationFacts, accusative: string): string {
  const verb = f.ongoing ? 'отмечают' : 'отмечали';
  const head = `Родители ${verb} ${accusative}`;

  if (f.spans.length === 0) {
    // Протяжённости не записали — сказать «с такого-то по такой-то» не из чего.
    // Соблазн растянуть отрезок от первой отметки до последней здесь и живёт:
    // между двумя отметками наблюдения могло не быть вовсе, и нарисованный
    // отрезок был бы выводом, а не записью.
    const n = f.marks.length;
    return `${head} — ${n} ${plural(n, 'запись', 'записи', 'записей')}, протяжённость не записана.`;
  }

  const parts = f.spans.map((s) => spanLabel(s));
  return `${head} ${joinRu(parts)}${f.ongoing ? ', продолжается' : ''}.`;
}

/** «с 5-го по 9-й день» / «с 5-го дня» (ещё держится) / по датам без даты рождения. */
function spanLabel(s: ObservationSpan): string {
  if (s.fromDay == null) {
    const from = formatDayShort(s.fromMs);
    if (s.toMs == null) return `с ${from}`;
    const to = formatDayShort(s.toMs);
    return from === to ? `${from}` : `с ${from} по ${to}`;
  }
  if (s.toDay == null) return `с ${s.fromDay}-го дня`;
  if (s.toDay === s.fromDay) return `на ${s.fromDay}-й день`;
  return `с ${s.fromDay}-го по ${s.toDay}-й день`;
}

/** «a, b и c» — перечисление по-русски. */
function joinRu(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} и ${parts[parts.length - 1]}`;
}

/* ------------------------------------------------------------------ *
 * Температура
 * ------------------------------------------------------------------ */

export interface TempDay {
  /** Полночь этих суток, мс. */
  startMs: number;
  /** День жизни, 1-based. */
  day: number | null;
  /** Худшее за сутки значение: врача интересует пик, а не последний замер. */
  maxC: number;
  /** Сколько раз за эти сутки записывали градусы. */
  records: number;
}

export interface TemperatureFacts {
  /** Сутки с записанной температурой, от старых к новым. Пустых суток тут нет. */
  days: TempDay[];
  /** Всего записей с градусами в окне. */
  records: number;
  /** Пик за окно: сколько и когда. */
  peak: { c: number; atMs: number; day: number | null } | null;
  /**
   * Самая ранняя запись пришлась на первые сутки окна.
   *
   * Значит, раньше мы просто не смотрели, а не «раньше не было». Та же
   * разница, что у наблюдений, и молчать о ней так же нельзя.
   */
  atWindowEdge: boolean;
}

/**
 * Температура за окно — фактами, без единой оценки.
 *
 * Ни «норма», ни «высокая», ни цвета: 37.2 у новорождённого значит разное
 * в зависимости от того, как и чем мерили, во что был одет и когда ел, —
 * и решает это врач. Страница отвечает только на «записывали ли, сколько
 * и когда».
 *
 * Источников ДВА, и оба обязательны: `measure/temp` и `symptom/fever`
 * (см. `isTemperatureReading` в `shared/taxonomy.ts`). Читать одно место —
 * ровно та поломка, из-за которой записанный жар до врача не доезжал.
 *
 * Сутки без единой записи в список не попадают вовсе. Ноль здесь означал бы
 * «температуры не было», а дневник знает только «не записали».
 */
export function temperatureFacts(
  events: TrackerEvent[],
  opts: { birthMs?: number | null; windowStartMs?: number | null } = {},
): TemperatureFacts {
  const byDay = new Map<string, { startMs: number; maxC: number; records: number }>();
  let peak: TemperatureFacts['peak'] = null;
  let records = 0;
  let earliest: number | null = null;

  for (const e of events) {
    if (e.deleted_at) continue;
    if (!isTemperatureReading(e)) continue;
    const at = parseTs(e.started_at);
    const c = e.value_num;
    if (at == null || c == null) continue;

    records += 1;
    earliest = earliest == null ? at : Math.min(earliest, at);

    const key = localDateKey(at);
    const day = byDay.get(key);
    if (day === undefined) {
      byDay.set(key, { startMs: startOfLocalDay(at), maxC: c, records: 1 });
    } else {
      day.maxC = Math.max(day.maxC, c);
      day.records += 1;
    }

    // Строго «больше»: при равных значениях остаётся первое по времени —
    // так «максимум был тогда-то» не переезжает от повторного замера.
    if (peak === null || c > peak.c) {
      peak = { c, atMs: at, day: dayOfLife(opts.birthMs, at) };
    }
  }

  const days = [...byDay.values()]
    .sort((a, b) => a.startMs - b.startMs)
    .map((d) => ({
      startMs: d.startMs,
      day: dayOfLife(opts.birthMs, d.startMs),
      maxC: d.maxC,
      records: d.records,
    }));

  return {
    days,
    records,
    peak,
    atWindowEdge:
      earliest != null &&
      opts.windowStartMs != null &&
      earliest < startOfLocalDay(opts.windowStartMs) + DAY,
  };
}

/** Все сутки, которые задевает промежуток, записаны — по своему роду событий. */
function spanIsRecorded(from: number, to: number, recorded: Set<string>): boolean {
  for (let d = startOfLocalDay(from); d <= startOfLocalDay(to); d = startOfLocalDay(d + DAY + HALF_DAY)) {
    if (!recorded.has(localDateKey(d))) return false;
  }
  return true;
}
