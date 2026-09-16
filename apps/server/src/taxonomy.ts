/**
 * Таксономия событий (§10.2) — один источник правды для схемы БД, валидации API,
 * описаний MCP-тулов и промпта. Разъехавшиеся копии этого списка — прямой путь
 * к тому, что модель запишет тип, который потом не пройдёт валидацию API.
 *
 * Главное правило: **объём необязателен везде**. При смешанном вскармливании
 * граммы осмысленны только для бутылочки, грудь измеряют стороной и длительностью.
 * Отсутствующее значение — это NULL, а не ноль.
 */

import type { EventType, ValueUnit } from './types.ts';
import { SUBTYPES, TYPE_IDS } from '../../../shared/taxonomy.ts';

/**
 * Список подтипов сюда не переписывается, а импортируется: три независимые
 * копии уже расходились молча (см. шапку `shared/taxonomy.ts`).
 *
 * Присваивание ниже — заодно и проверка, что `EventType` и `TypeId` описывают
 * один и тот же набор типов: лишний тип в `TypeId` не пройдёт сюда, лишний
 * в `EventType` — не получит строки в `TAXONOMY`.
 */
export const EVENT_TYPES: readonly EventType[] = TYPE_IDS;

export const VALUE_UNITS: readonly ValueUnit[] = ['ml', 'g', 'kg', 'c', 'cm', 'min', 'mg'];

export interface TypeSpec<T extends EventType = EventType> {
  /**
   * Известные подтипы. Пустой список = подтип произвольный (meds) или не нужен.
   *
   * Тип нарочно узкий — ровно кортеж из `SUBTYPES`, — чтобы сюда нельзя было
   * вписать список руками: единственное, что подходит, это `SUBTYPES[<тип>]`.
   */
  subtypes: (typeof SUBTYPES)[T];
  /** Свободный ли подтип: у meds это название препарата. */
  freeSubtype?: boolean;
  units: readonly ValueUnit[];
  hint: string;
}

export const TAXONOMY: Readonly<{ [T in EventType]: TypeSpec<T> }> = {
  sleep: {
    subtypes: SUBTYPES.sleep,
    units: [],
    hint: 'открытое событие до пробуждения: ended_at = NULL, пока спит',
  },
  feed: {
    subtypes: SUBTYPES.feed,
    units: ['ml', 'min', 'g'],
    hint:
      'бутылочка — объём в ml; грудь — длительность в min, сторона в note (left/right/both); ' +
      'объём НЕ обязателен, не названо — NULL',
  },
  pump: { subtypes: SUBTYPES.pump, units: ['ml'], hint: 'сцеживание, объём в ml' },
  diaper: {
    subtypes: SUBTYPES.diaper,
    units: [],
    hint: 'считаем количество за сутки, значение не нужно',
  },
  measure: {
    subtypes: SUBTYPES.measure,
    units: ['g', 'kg', 'cm', 'c'],
    // Про то, что градусы пишутся СЮДА, сказано в подсказке symptom — там, где
    // модель и ошибается. Дублировать здесь не стали: справочник читается при
    // каждом разборе, и каждая лишняя строка в нём стоит следования инструкциям.
    hint: 'weight — g или kg; height и head (окружность головы) — cm; temp — c',
  },
  meds: {
    subtypes: SUBTYPES.meds,
    freeSubtype: true,
    units: ['ml', 'mg'],
    hint: 'subtype — название препарата свободным текстом (витамин D, нурофен)',
  },
  symptom: {
    subtypes: SUBTYPES.symptom,
    // `c` оставлено намеренно: в базе уже лежат symptom/fever с градусами,
    // и запрещать единицу значило бы сделать существующие записи невалидными.
    units: ['c'],
    // Подробности про состояния и запрет на диагноз живут в ситуативной
    // карточке промпта, а не здесь: справочник читается при КАЖДОМ разборе,
    // и каждая лишняя строка в нём стоит следования инструкциям.
    // Про то, что rash и *_yellow длящиеся, сказано в «правилах данных» рядом
    // с самим ended_at — и сказано СПИСКОМ ИЗ КОДА (`stateSubtypesList`),
    // поэтому здесь это не повторяется: разъехаться прозе с кодом проще всего.
    hint:
      'срыгивание, рвота, сыпь, колики, плач; fever — жар БЕЗ числа, градусы → measure/temp; ' +
      '*_yellow — желтизна, НАБЛЮДЕНИЕ не диагноз',
  },
  activity: {
    subtypes: SUBTYPES.activity,
    units: ['min'],
    hint: 'купание, прогулка, выкладывание на живот',
  },
  note: { subtypes: SUBTYPES.note, units: [], hint: 'всё, что не разложилось; текст в note' },
};

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && EVENT_TYPES.includes(value as EventType);
}

/* ------------------------------------------------------------------ */
/* Наблюдения-СОСТОЯНИЯ                                                 */
/* ------------------------------------------------------------------ */

/**
 * Состояния (сыпь, желтизна кожи и белков глаз) живут в `shared/taxonomy.ts`
 * вместе с самим списком подтипов: разрешение быть длящимся выдаётся паре
 * (тип, подтип), и отрывать его от списка подтипов значило бы завести
 * четвёртую копию того же знания. Здесь — только реэкспорт, чтобы серверный
 * код по-прежнему импортировал таксономию из одного места.
 */
export { STATE_SUBTYPES, isStateSubtype } from '../../../shared/taxonomy.ts';

/**
 * Подходит ли подтип типу. Неизвестный подтип НЕ повод терять событие (§10.2):
 * вызывающий код должен записать событие с note, а не отклонить его.
 */
export function isKnownSubtype(type: EventType, subtype: string | null | undefined): boolean {
  if (subtype === null || subtype === undefined || subtype === '') return true;
  const spec: TypeSpec = TAXONOMY[type];
  if (spec.freeSubtype) return true;
  // Расширение до строк намеренное: сюда приходит что угодно из API и от модели,
  // и спрашивать «а вдруг это один из наших литералов» — ровно смысл функции.
  return (spec.subtypes as readonly string[]).includes(subtype);
}

/* ------------------------------------------------------------------ */
/* Нормы AAP (§10.1) — для подсказок на дашборде                        */
/* ------------------------------------------------------------------ */

export interface AgeNorms {
  ageDays: number;
  feeds: { min: number; max: number; note: string };
  wetDiapers: { min: number; note: string };
  dirtyDiapers: { min: number; max: number; note: string };
}

/**
 * Нормы для текущего возраста.
 *
 * Мокрые подгузники: день 1 -> 1, день 2 -> 2, ... с 5-го дня 6+.
 * Кормления 8–12 в сутки и 3–4 грязных подгузника — ориентиры для новорождённого;
 * дальше это именно ориентир, поэтому отдаём его вместе с пояснением, а не как
 * жёсткий порог.
 */
export function normsForAge(ageDays: number): AgeNorms {
  const day = Math.max(1, Math.floor(ageDays) + 1); // возраст 0 дней = первые сутки
  const wetMin = day >= 5 ? 6 : day;

  return {
    ageDays: Math.max(0, Math.floor(ageDays)),
    feeds: {
      min: 8,
      max: 12,
      note: 'ориентир AAP для новорождённого: 8–12 кормлений за 24 часа',
    },
    wetDiapers: {
      min: wetMin,
      note:
        day >= 5
          ? 'с 5-го дня — 6 и более мокрых подгузников в сутки'
          : `день ${day}: ориентир — ${wetMin} мокрых подгузника в сутки`,
    },
    dirtyDiapers: {
      min: 3,
      max: 4,
      note: 'после первых дней — 3–4 грязных подгузника в сутки',
    },
  };
}
