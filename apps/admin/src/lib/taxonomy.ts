/**
 * Человеческие подписи к таксономии §10.2. Одно место на всё приложение:
 * лента, редактор и сводка берут названия отсюда, чтобы не разъезжались.
 */
import type { EventType } from '../types';

export interface SubtypeDef {
  id: string;
  label: string;
}

/**
 * Род названия типа. Нужен ровно для одного: согласовать причастие в журнале.
 * «Сон завершён», но «активность завершена» и «кормление завершено» —
 * неверная форма читается как поломка не хуже, чем «0 мин».
 */
export type Gender = 'm' | 'f' | 'n';

export interface TypeDef {
  id: EventType;
  label: string;
  /** Короткая подпись для чипов-фильтров. */
  short: string;
  icon: string;
  /** Род `label` — для согласования причастий (см. Gender). */
  gender: Gender;
  /** Цветовой токен из styles.css: var(--t-<tone>) */
  tone: 'sleep' | 'feed' | 'diaper' | 'measure' | 'meds' | 'symptom' | 'activity' | 'note';
  subtypes: SubtypeDef[];
  /** Единицы, которые вообще осмысленны для типа. Первая — предлагаемая по умолчанию. */
  units: string[];
  /** Бывает ли у события конец (открытый сон, длительность прогулки). */
  ranged: boolean;
  /**
   * Осмысленно ли состояние «ещё идёт». У сна — да, у кормления из бутылочки нет:
   * там пустой ended_at значит «время окончания не называли», а не «до сих пор ест».
   */
  openable: boolean;
}

export const TYPES: TypeDef[] = [
  {
    id: 'sleep',
    label: 'Сон',
    short: 'Сон',
    icon: '☾',
    gender: 'm',
    tone: 'sleep',
    subtypes: [
      { id: 'night', label: 'ночной' },
      { id: 'nap', label: 'дневной' },
    ],
    units: [],
    ranged: true,
    openable: true,
  },
  {
    id: 'feed',
    label: 'Кормление',
    short: 'Еда',
    icon: '◗',
    gender: 'n',
    tone: 'feed',
    subtypes: [
      { id: 'breast', label: 'грудь' },
      { id: 'bottle', label: 'бутылочка' },
      { id: 'solid', label: 'прикорм' },
    ],
    units: ['ml', 'min'],
    ranged: true,
    openable: false,
  },
  {
    id: 'pump',
    label: 'Сцеживание',
    short: 'Сцеж.',
    icon: '⤓',
    gender: 'n',
    tone: 'feed',
    subtypes: [],
    units: ['ml'],
    ranged: false,
    openable: false,
  },
  {
    id: 'diaper',
    label: 'Подгузник',
    short: 'Подгуз.',
    icon: '◇',
    gender: 'm',
    tone: 'diaper',
    subtypes: [
      { id: 'wet', label: 'мокрый' },
      { id: 'dirty', label: 'грязный' },
      { id: 'both', label: 'и то, и то' },
    ],
    units: [],
    ranged: false,
    openable: false,
  },
  {
    id: 'measure',
    label: 'Измерение',
    short: 'Замер',
    icon: '▲',
    gender: 'n',
    tone: 'measure',
    subtypes: [
      { id: 'weight', label: 'вес' },
      { id: 'height', label: 'рост' },
      { id: 'head', label: 'окр. головы' },
      { id: 'temp', label: 'температура' },
    ],
    units: ['g', 'kg', 'cm', 'c'],
    ranged: false,
    openable: false,
  },
  {
    id: 'meds',
    label: 'Лекарство',
    short: 'Лек-во',
    icon: '✚',
    gender: 'n',
    tone: 'meds',
    subtypes: [],
    units: ['ml', 'mg'],
    ranged: false,
    openable: false,
  },
  {
    id: 'symptom',
    label: 'Симптом',
    short: 'Симптом',
    icon: '◐',
    gender: 'm',
    tone: 'symptom',
    subtypes: [
      { id: 'spit_up', label: 'срыгивание' },
      { id: 'vomit', label: 'рвота' },
      { id: 'rash', label: 'сыпь' },
      { id: 'colic', label: 'колики' },
      { id: 'crying', label: 'плач' },
      { id: 'fever', label: 'температура' },
    ],
    units: ['c'],
    ranged: true,
    openable: true,
  },
  {
    id: 'activity',
    label: 'Активность',
    short: 'Актив.',
    icon: '◉',
    gender: 'f',
    tone: 'activity',
    subtypes: [
      { id: 'bath', label: 'купание' },
      { id: 'walk', label: 'прогулка' },
      { id: 'tummy_time', label: 'на животе' },
    ],
    units: ['min'],
    ranged: true,
    openable: true,
  },
  {
    id: 'note',
    label: 'Заметка',
    short: 'Заметка',
    icon: '✎',
    gender: 'f',
    tone: 'note',
    subtypes: [],
    units: [],
    ranged: false,
    openable: false,
  },
];

const BY_ID = new Map(TYPES.map((t) => [t.id as string, t]));

/** Незнакомый тип не должен ломать ленту — отдаём нейтральную заглушку (§10.2). */
export function typeDef(type: string | null | undefined): TypeDef {
  const found = type ? BY_ID.get(type) : undefined;
  if (found) return found;
  return {
    id: 'note',
    label: type || 'Событие',
    short: type || 'Событие',
    icon: '·',
    // «Событие» среднего рода, и незнакомый тип безопаснее согласовывать так же.
    gender: 'n',
    tone: 'note',
    subtypes: [],
    units: ['ml', 'min', 'g', 'kg', 'cm', 'c', 'mg'],
    ranged: false,
    openable: false,
  };
}

export function subtypeLabel(type: string | null | undefined, subtype: string | null | undefined) {
  if (!subtype) return null;
  const def = typeDef(type).subtypes.find((s) => s.id === subtype);
  // meds хранит в subtype название препарата свободным текстом (§10.2) — показываем как есть.
  return def ? def.label : subtype;
}

export const UNIT_LABEL: Record<string, string> = {
  ml: 'мл',
  g: 'г',
  kg: 'кг',
  c: '°C',
  cm: 'см',
  min: 'мин',
  mg: 'мг',
};

export function unitLabel(unit: string | null | undefined): string {
  if (!unit) return '';
  return UNIT_LABEL[unit] ?? unit;
}

export const SOURCE_LABEL: Record<string, string> = {
  'alice-fast': 'Алиса · быстрый разбор',
  'alice-llm': 'Алиса · модель',
  api: 'API',
  manual: 'вручную',
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return 'неизвестно';
  return SOURCE_LABEL[source] ?? source;
}

/** Короткий бейдж источника для плотной ленты. */
export const SOURCE_SHORT: Record<string, string> = {
  'alice-fast': 'fast',
  'alice-llm': 'opus',
  api: 'api',
  manual: 'рука',
};

export function sourceShort(source: string | null | undefined): string {
  if (!source) return '—';
  return SOURCE_SHORT[source] ?? source;
}

/** Грудь: сторона лежит в note (§10.2). Разбираем, чтобы показать «левая/правая». */
const SIDE_LABEL: Record<string, string> = {
  left: 'левая',
  right: 'правая',
  both: 'обе',
};

export function breastSide(note: string | null | undefined): string | null {
  if (!note) return null;
  const key = note.trim().toLowerCase();
  return SIDE_LABEL[key] ?? null;
}
