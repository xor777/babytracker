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

export const EVENT_TYPES: readonly EventType[] = [
  'sleep',
  'feed',
  'pump',
  'diaper',
  'measure',
  'meds',
  'symptom',
  'activity',
  'note',
];

export const VALUE_UNITS: readonly ValueUnit[] = ['ml', 'g', 'kg', 'c', 'cm', 'min', 'mg'];

export interface TypeSpec {
  /** Известные подтипы. Пустой список = подтип произвольный (meds) или не нужен. */
  subtypes: readonly string[];
  /** Свободный ли подтип: у meds это название препарата. */
  freeSubtype?: boolean;
  units: readonly ValueUnit[];
  hint: string;
}

export const TAXONOMY: Readonly<Record<EventType, TypeSpec>> = {
  sleep: {
    subtypes: ['night', 'nap'],
    units: [],
    hint: 'открытое событие до пробуждения: ended_at = NULL, пока спит',
  },
  feed: {
    subtypes: ['breast', 'bottle', 'solid'],
    units: ['ml', 'min', 'g'],
    hint:
      'бутылочка — объём в ml; грудь — длительность в min, сторона в note (left/right/both); ' +
      'объём НЕ обязателен, не названо — NULL',
  },
  pump: { subtypes: [], units: ['ml'], hint: 'сцеживание, объём в ml' },
  diaper: {
    subtypes: ['wet', 'dirty', 'both'],
    units: [],
    hint: 'считаем количество за сутки, значение не нужно',
  },
  measure: {
    subtypes: ['weight', 'height', 'head', 'temp'],
    units: ['g', 'kg', 'cm', 'c'],
    hint: 'weight — g или kg; height и head (окружность головы) — cm; temp — c',
  },
  meds: {
    subtypes: [],
    freeSubtype: true,
    units: ['ml', 'mg'],
    hint: 'subtype — название препарата свободным текстом (витамин D, нурофен)',
  },
  symptom: {
    subtypes: ['spit_up', 'vomit', 'rash', 'colic', 'crying', 'fever'],
    units: ['c'],
    hint: 'срыгивание, рвота, сыпь, колики, плач, температура',
  },
  activity: {
    subtypes: ['bath', 'walk', 'tummy_time'],
    units: ['min'],
    hint: 'купание, прогулка, выкладывание на живот',
  },
  note: { subtypes: [], units: [], hint: 'всё, что не разложилось; текст в note' },
};

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && EVENT_TYPES.includes(value as EventType);
}

/**
 * Подходит ли подтип типу. Неизвестный подтип НЕ повод терять событие (§10.2):
 * вызывающий код должен записать событие с note, а не отклонить его.
 */
export function isKnownSubtype(type: EventType, subtype: string | null | undefined): boolean {
  if (subtype === null || subtype === undefined || subtype === '') return true;
  const spec = TAXONOMY[type];
  if (spec.freeSubtype) return true;
  return spec.subtypes.includes(subtype);
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
