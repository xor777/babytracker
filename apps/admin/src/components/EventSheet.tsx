import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { EventPatch, TrackerEvent } from '../types';
import { TYPES, sourceLabel, typeDef, unitLabel } from '../lib/taxonomy';
import { formatWhen, isoToLocalInput, msToLocalInput } from '../lib/format';
import { freeSubtype, parseValue, reviewDraft, suggestEnd, toDraft } from '../lib/draft';

interface Props {
  event: TrackerEvent;
  busy: boolean;
  onClose: () => void;
  /** Возвращают текст ошибки или null. Лист обязан показать её сам: на телефоне
   *  он перекрывает ленту целиком, и баннер под ним человеку не виден. */
  onSave: (id: number, patch: EventPatch) => Promise<string | null>;
  onDelete: (id: number) => Promise<string | null>;
  onRestore: (id: number) => Promise<string | null>;
}

export function EventSheet({ event, busy, onClose, onSave, onDelete, onRestore }: Props) {
  const [draft, setDraft] = useState(() => toDraft(event));
  const [err, setErr] = useState<string | null>(null);
  /** Время конца в поле подставлено нами, человек его ещё не набирал (см. suggestEnd). */
  const [endAuto, setEndAuto] = useState(false);

  useEffect(() => {
    setDraft(toDraft(event));
    setErr(null);
    setEndAuto(false);
  }, [event]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const def = typeDef(draft.type);
  const deleted = Boolean(event.deleted_at);
  // Только для подсказки под полем; для патча то же сравнение делает reviewDraft.
  const startedTouched = draft.started !== isoToLocalInput(event.started_at);

  const value = parseValue(draft.value);

  const { patch, problems, dirty, valid } = useMemo(
    () => reviewDraft(event, draft, endAuto),
    [event, draft, endAuto],
  );

  /**
   * Первое прикосновение к пустому полю конца. Подставляем дату и время сразу:
   * пока в поле пусто, браузер не отдаёт набранные цифры вообще (см. suggestEnd),
   * и человек набирает время в никуда.
   */
  const touchEnd = () => {
    if (draft.ended) return;
    setDraft((d) => ({ ...d, ended: suggestEnd(event.started_at) }));
    setEndAuto(true);
  };

  /** Набрал сам, выбрал пикером или нажал «Сейчас» — подстановка стала правкой. */
  const editEnd = (ended: string) => {
    setEndAuto(false);
    setDraft((d) => ({ ...d, ended }));
  };

  /** Ушёл, ничего не набрав: возвращаем поле в пустое, чтобы не закрыть сон случайно. */
  const leaveEnd = () => {
    if (!endAuto) return;
    setEndAuto(false);
    setDraft((d) => ({ ...d, ended: '' }));
  };

  const pickType = (id: string) => {
    const nextDef = typeDef(id);
    setEndAuto(false);
    setDraft((d) => {
      // У типа без единиц (сон, подгузник, заметка) значения не бывает — убираем оба,
      // иначе остаётся «сон со значением 130 без единицы».
      const keepsValue = nextDef.units.length > 0;
      return {
        ...d,
        type: id,
        // Подтип из другого домена не переносим — он там ничего не значит.
        subtype:
          freeSubtype(id) || nextDef.subtypes.some((s) => s.id === d.subtype) ? d.subtype : '',
        value: keepsValue ? d.value : '',
        unit: keepsValue ? (nextDef.units.includes(d.unit) ? d.unit : (nextDef.units[0] ?? '')) : '',
        ended: nextDef.ranged ? d.ended : '',
      };
    });
  };

  const submit = async () => {
    if (!dirty || !valid) return;
    const message = await onSave(event.id, patch);
    if (message) setErr(message);
    else onClose();
  };

  const act = async (fn: () => Promise<string | null>) => {
    const message = await fn();
    if (message) setErr(message);
    else onClose();
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Правка записи"
        style={{ '--tone': `var(--t-${def.tone})` } as CSSProperties}
      >
        <div className="sheet__grip" aria-hidden="true" />
        <header className="sheet__head">
          <h2 className="sheet__title">{def.label}</h2>
          <span className="sheet__id">#{event.id}</span>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>

        <div className="sheet__body">
          {event.utterance?.raw_text ? (
            <div className="field">
              <span className="field__label">Что сказали Алисе</span>
              <p className="said-quote">«{event.utterance.raw_text}»</p>
            </div>
          ) : null}

          <div className="field">
            <span className="field__label">Тип</span>
            <div className="chipgrid">
              {TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="chip"
                  aria-pressed={draft.type === t.id}
                  onClick={() => pickType(t.id)}
                >
                  <span className="chip__dot" aria-hidden="true" />
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {freeSubtype(draft.type) ? (
            <label className="field">
              <span className="field__label">Препарат</span>
              <input
                className="input"
                value={draft.subtype}
                placeholder="например, витамин D"
                onChange={(e) => setDraft({ ...draft, subtype: e.target.value })}
              />
            </label>
          ) : def.subtypes.length ? (
            <div className="field">
              <span className="field__label">Подтип</span>
              <div className="chipgrid">
                <button
                  type="button"
                  className="chip"
                  aria-pressed={draft.subtype === ''}
                  onClick={() => setDraft({ ...draft, subtype: '' })}
                >
                  не указан
                </button>
                {def.subtypes.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="chip"
                    aria-pressed={draft.subtype === s.id}
                    onClick={() => setDraft({ ...draft, subtype: s.id })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <label className="field">
            <span className="field__label">Начало</span>
            <input
              type="datetime-local"
              className="input input--time"
              value={draft.started}
              onChange={(e) => setDraft({ ...draft, started: e.target.value })}
            />
            {startedTouched ? (
              <p className="field__hint">Время сохранится ровно как выбрано, с нулём секунд.</p>
            ) : null}
          </label>

          {def.ranged ? (
            <div className="field">
              <span className="field__label">Конец</span>
              <div className="field__row">
                <input
                  type="datetime-local"
                  className="input input--time"
                  value={draft.ended}
                  onFocus={touchEnd}
                  onBlur={leaveEnd}
                  onChange={(e) => editEnd(e.target.value)}
                />
                {draft.ended && !endAuto ? (
                  <button type="button" className="btn" onClick={() => editEnd('')}>
                    {def.openable ? 'Идёт' : 'Убрать'}
                  </button>
                ) : (
                  // Самый частый случай: сон только что кончился. Одна кнопка вместо набора.
                  <button
                    type="button"
                    className="btn"
                    onClick={() => editEnd(msToLocalInput(Date.now()))}
                  >
                    Сейчас
                  </button>
                )}
              </div>
              {endAuto ? (
                <p className="field__hint">
                  Пока только подсказка: поправьте цифры или нажмите «Сейчас».
                </p>
              ) : !draft.ended ? (
                <p className="field__hint">
                  {def.openable
                    ? 'Пусто — событие ещё не закончилось.'
                    : 'Можно не заполнять, если конец не называли.'}
                </p>
              ) : null}
            </div>
          ) : null}

          {def.units.length ? (
            <div className="field">
              <span className="field__label">Значение</span>
              <div className="field__row">
                <input
                  className="input"
                  inputMode="decimal"
                  value={draft.value}
                  placeholder="не указано"
                  aria-invalid={value === 'bad' || (typeof value === 'number' && value < 0)}
                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                />
                <div className="chipgrid" style={{ flex: 'none' }}>
                  {def.units.map((u) => (
                    <button
                      key={u}
                      type="button"
                      className="chip"
                      aria-pressed={draft.unit === u}
                      onClick={() => setDraft({ ...draft, unit: u })}
                    >
                      {unitLabel(u)}
                    </button>
                  ))}
                </div>
              </div>
              <p className="field__hint">
                Пустое поле — значения нет. Ноль и «нет» это разные вещи.
              </p>
            </div>
          ) : null}

          <label className="field">
            <span className="field__label">Заметка</span>
            <textarea
              className="input"
              value={draft.note}
              placeholder={
                draft.type === 'feed' && draft.subtype === 'breast'
                  ? 'сторона: left / right / both'
                  : 'своими словами'
              }
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </label>

          <dl className="meta-list">
            <dt>Источник</dt>
            <dd>{sourceLabel(event.source)}</dd>
            <dt>Записано</dt>
            <dd>{formatWhen(event.started_at, true)}</dd>
            {event.confidence != null ? (
              <>
                <dt>Уверенность разбора</dt>
                <dd>{Math.round(event.confidence * 100)}%</dd>
              </>
            ) : null}
            {deleted ? (
              <>
                <dt>Удалено</dt>
                <dd>{formatWhen(event.deleted_at)}</dd>
              </>
            ) : null}
          </dl>

          <p className="footnote">
            Любая правка обратима: сервер хранит прежнее состояние записи, а удаление —
            это пометка, а не стирание.
          </p>
        </div>

        {err || (!valid && dirty) ? (
          <div className="sheet__alert" role="alert">
            {err ?? problems[0]}
          </div>
        ) : null}

        <footer className="sheet__foot">
          {deleted ? (
            <>
              <button type="button" className="btn" onClick={onClose}>
                Закрыть
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => act(() => onRestore(event.id))}
              >
                Вернуть запись
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy}
                onClick={() => act(() => onDelete(event.id))}
              >
                Удалить
              </button>
              <button
                type="button"
                className={dirty && valid ? 'btn btn--primary' : 'btn'}
                style={{ flex: 1 }}
                disabled={busy || !dirty || !valid}
                onClick={submit}
              >
                {dirty ? 'Сохранить' : 'Без изменений'}
              </button>
            </>
          )}
        </footer>
      </section>
    </>
  );
}
