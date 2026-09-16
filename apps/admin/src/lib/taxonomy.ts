/**
 * Человеческие подписи к таксономии §10.2. Одно место на всё приложение:
 * лента, редактор и сводка берут названия отсюда, чтобы не разъезжались.
 */
import type { EventType } from '../types';
import { SUBTYPES, stateSubtypePairs, type SubtypeOf } from '../../../../shared/taxonomy';

export interface SubtypeDef {
  id: string;
  label: string;
  /**
   * Винительный падеж подписи — «отмечали желтизну кожи».
   *
   * Нужен там, где подпись уходит не в ярлык, а внутрь фразы. Тот же повод,
   * что и у `Gender` ниже: «отмечали желтизна кожи» читается как поломка.
   * Не задан — значит подпись во фразы не попадает (для «сыпь» и не нужен:
   * винительный совпадает с именительным).
   */
  accusative?: string;
}

/**
 * Подписи к подтипам одного типа — ключом по подтипу, а не списком.
 *
 * Ключи проверяются типом: `SubtypeOf<T>` перечисляет подтипы из
 * `shared/taxonomy.ts`, и объект обязан покрыть их ВСЕ. Добавили подтип в общий
 * список и забыли подпись здесь — падает `pnpm typecheck`, то есть и CI.
 * Раньше на этом месте был массив, и забытая подпись означала подтип, который
 * сервер пишет, а админка молча не показывает.
 *
 * Порядок показа берётся из общего списка, а не из порядка ключей: он один
 * для сервера, админки и телевизора.
 */
function subtypesOf<T extends EventType>(
  type: T,
  labels: { [S in SubtypeOf<T>]: Omit<SubtypeDef, 'id'> },
): SubtypeDef[] {
  return (SUBTYPES[type] as readonly SubtypeOf<T>[]).map((id) => ({ id, ...labels[id] }));
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
    subtypes: subtypesOf('sleep', {
      night: { label: 'ночной' },
      nap: { label: 'дневной' },
    }),
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
    subtypes: subtypesOf('feed', {
      breast: { label: 'грудь' },
      bottle: { label: 'бутылочка' },
      solid: { label: 'прикорм' },
    }),
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
    subtypes: subtypesOf('pump', {}),
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
    subtypes: subtypesOf('diaper', {
      wet: { label: 'мокрый' },
      dirty: { label: 'грязный' },
      both: { label: 'и то, и то' },
    }),
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
    subtypes: subtypesOf('measure', {
      weight: { label: 'вес' },
      height: { label: 'рост' },
      head: { label: 'окр. головы' },
      temp: { label: 'температура' },
    }),
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
    subtypes: subtypesOf('meds', {}),
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
    subtypes: subtypesOf('symptom', {
      spit_up: { label: 'срыгивание' },
      vomit: { label: 'рвота' },
      // Сыпь — состояние (см. STATE_SUBTYPES): держится днями, и врач
      // спрашивает про неё протяжённостью. Винительный падеж совпадает
      // с именительным, поэтому отдельная форма не нужна.
      rash: { label: 'сыпь' },
      colic: { label: 'колики' },
      crying: { label: 'плач' },
      // Жар без числа. Названные градусы живут в measure/temp — иначе
      // температура не доходит до сводки.
      fever: { label: 'жар' },
      // Наблюдение, а не диагноз: родитель видит цвет, а не болезнь.
      // Название в интерфейсе читается как то, что увидели, — и только.
      // Кожа и белки глаз разведены намеренно: для врача это разные
      // наблюдения, ровно как мокрый и грязный подгузник.
      skin_yellow: { label: 'желтизна кожи', accusative: 'желтизну кожи' },
      eyes_yellow: { label: 'желтизна белков глаз', accusative: 'желтизну белков глаз' },
    }),
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
    subtypes: subtypesOf('activity', {
      bath: { label: 'купание' },
      walk: { label: 'прогулка' },
      tummy_time: { label: 'на животе' },
    }),
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
    subtypes: subtypesOf('note', {}),
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

/**
 * Пары «тип/подтип», которые являются состояниями (§10.2).
 *
 * Список не дублируется здесь флажками у подписей: он один на репозиторий
 * и лежит в `shared/taxonomy.ts` рядом с самими подтипами. Админка спрашивает
 * его, а не помнит.
 */
export function stateSubtypes(): Array<{ type: EventType; subtype: string }> {
  return stateSubtypePairs();
}

/** Подпись в винительном падеже; не задана — отдаём именительную, она хоть читается. */
export function subtypeAccusative(
  type: string | null | undefined,
  subtype: string | null | undefined,
): string {
  if (!subtype) return '';
  const def = typeDef(type).subtypes.find((s) => s.id === subtype);
  return def?.accusative ?? def?.label ?? subtype;
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
