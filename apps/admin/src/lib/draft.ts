/**
 * Черновик карточки правки: что человек видит в полях и что из этого получается
 * патчем для сервера.
 *
 * Вынесено из EventSheet целиком ради одного: поведение кнопки «Сохранить»
 * проверяется тестом без браузера. Именно она молчала на ручной ввод времени,
 * и молчание кнопки — это поведение, а не разметка.
 */
import type { EventPatch, TrackerEvent } from '../types';
import { DAY, isoToLocalInput, localInputToIso, msToLocalInput, parseTs } from './format';
import { typeDef } from './taxonomy';

export interface Draft {
  type: string;
  subtype: string;
  started: string;
  ended: string;
  value: string;
  unit: string;
  note: string;
}

export function toDraft(e: TrackerEvent): Draft {
  return {
    type: String(e.type),
    subtype: e.subtype ?? '',
    started: isoToLocalInput(e.started_at),
    ended: isoToLocalInput(e.ended_at),
    value: e.value_num == null ? '' : String(e.value_num),
    unit: e.value_unit ?? '',
    note: e.note ?? '',
  };
}

/** Подтип у meds — название препарата, у note его нет вовсе (§10.2). */
export function freeSubtype(type: string): boolean {
  return type === 'meds';
}

export function parseValue(raw: string): number | null | 'bad' {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(',', '.'));
  return Number.isFinite(n) ? n : 'bad';
}

/**
 * Что подставить в пустое поле конца, когда человек коснулся его впервые.
 *
 * Без подстановки ручной ввод не просто неудобен — он невозможен. Пустой
 * `datetime-local` браузер держит пустым, пока не заполнены и дата, и время:
 * набранные с клавиатуры часы видны в поле, но `value` остаётся пустой строкой,
 * а события `input` не приходит вовсе (проверено в Chrome). До React в этот
 * момент не доходит ничего, поэтому и кнопка «Сохранить» не оживает.
 *
 * Берём текущую минуту, если событие идёт меньше суток: сон почти всегда
 * закрывают «только что», и ночной сон с 22:10 закрывается уже утром следующего
 * дня — дата начала тут соврала бы. Для давних записей без конца ставим время
 * начала: там человек правит часы в пределах того же дня.
 */
export function suggestEnd(startedAt: string | null | undefined, now = Date.now()): string {
  const start = parseTs(startedAt);
  if (start == null) return msToLocalInput(now);
  if (now >= start && now - start <= DAY) return msToLocalInput(now);
  return msToLocalInput(start);
}

export interface Review {
  patch: EventPatch;
  problems: string[];
  /** Есть что сохранять: кнопка «Сохранить» вместо «Без изменений». */
  dirty: boolean;
  valid: boolean;
}

/**
 * @param endedAuto время конца подставлено нами (см. suggestEnd), человек его
 *   ещё не трогал. Для сервера это по-прежнему «конца нет»: иначе одно касание
 *   поля закрывало бы идущий сон случайной минутой.
 */
export function reviewDraft(event: TrackerEvent, draft: Draft, endedAuto = false): Review {
  const def = typeDef(draft.type);

  /*
   * Инпут `datetime-local` знает только минуты, а у событий Алисы есть секунды.
   * Поэтому «изменилось ли время» решаем в той же точности, в какой человек его видит:
   * иначе патч содержал бы started_at с первого же рендера и сохранение «без правок»
   * молча срезало бы секунды — вместе с порядком событий внутри фразы (§10.3).
   */
  const startedTouched = draft.started !== isoToLocalInput(event.started_at);
  const endedTouched = !endedAuto && draft.ended !== isoToLocalInput(event.ended_at);

  const startedIso = localInputToIso(draft.started);
  const endedIso = endedAuto ? null : localInputToIso(draft.ended);

  const value = parseValue(draft.value);

  const problems: string[] = [];
  if (!startedIso) problems.push('Без времени начала запись не сохранить.');
  if (startedIso && endedIso && (parseTs(endedIso) ?? 0) < (parseTs(startedIso) ?? 0)) {
    problems.push('Конец раньше начала.');
  }
  if (value === 'bad') problems.push('Значение должно быть числом.');
  if (typeof value === 'number' && value < 0) problems.push('Значение не может быть отрицательным.');
  if (typeof value === 'number' && def.units.length > 0 && !draft.unit) {
    problems.push('Выберите единицу измерения.');
  }

  const patch: EventPatch = {};
  if (draft.type !== event.type) patch.type = draft.type;
  const subtype = draft.subtype.trim() || null;
  if (subtype !== (event.subtype ?? null)) patch.subtype = subtype;
  if (startedTouched && startedIso) patch.started_at = startedIso;
  if (endedTouched) patch.ended_at = endedIso;
  if (typeof value === 'number' || value === null) {
    if (value !== (event.value_num ?? null)) patch.value_num = value;
    const unit = value == null ? null : draft.unit || null;
    if (unit !== (event.value_unit ?? null)) patch.value_unit = unit;
  }
  const note = draft.note.trim() || null;
  if (note !== (event.note ?? null)) patch.note = note;

  return {
    patch,
    problems,
    dirty: Object.keys(patch).length > 0,
    valid: problems.length === 0,
  };
}
