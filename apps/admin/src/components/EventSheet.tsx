import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { EventPatch, TrackerEvent } from '../types';
import { TYPES, sourceLabel, typeDef, unitLabel } from '../lib/taxonomy';
import { formatTime, isoToLocalInput, localInputToIso, parseTs } from '../lib/format';

interface Props {
  event: TrackerEvent;
  busy: boolean;
  onClose: () => void;
  onSave: (id: number, patch: EventPatch) => Promise<boolean>;
  onDelete: (id: number) => void;
  onRestore: (id: number) => void;
}

interface Draft {
  type: string;
  subtype: string;
  started: string;
  ended: string;
  value: string;
  unit: string;
  note: string;
}

function toDraft(e: TrackerEvent): Draft {
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
function freeSubtype(type: string): boolean {
  return type === 'meds';
}

export function EventSheet({ event, busy, onClose, onSave, onDelete, onRestore }: Props) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(event));

  useEffect(() => setDraft(toDraft(event)), [event]);

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

  const startedIso = localInputToIso(draft.started);
  const endedIso = localInputToIso(draft.ended);
  const timeBroken =
    !startedIso ||
    (endedIso != null && (parseTs(endedIso) ?? 0) < (parseTs(startedIso) ?? 0));

  const patch = useMemo<EventPatch>(() => {
    const next: EventPatch = {};
    if (draft.type !== event.type) next.type = draft.type;
    const subtype = draft.subtype.trim() || null;
    if (subtype !== (event.subtype ?? null)) next.subtype = subtype;
    if (startedIso && startedIso !== event.started_at) next.started_at = startedIso;
    if (endedIso !== (event.ended_at ?? null)) next.ended_at = endedIso;
    const value = draft.value.trim() === '' ? null : Number(draft.value.replace(',', '.'));
    const valueOk = value == null || Number.isFinite(value);
    if (valueOk && value !== (event.value_num ?? null)) next.value_num = value;
    const unit = value == null ? null : draft.unit || null;
    if (unit !== (event.value_unit ?? null)) next.value_unit = unit;
    const note = draft.note.trim() || null;
    if (note !== (event.note ?? null)) next.note = note;
    return next;
  }, [draft, event, startedIso, endedIso]);

  const dirty = Object.keys(patch).length > 0;

  const pickType = (id: string) => {
    const nextDef = typeDef(id);
    setDraft((d) => ({
      ...d,
      type: id,
      // Подтип из другого домена не переносим — он там ничего не значит.
      subtype:
        freeSubtype(id) || nextDef.subtypes.some((s) => s.id === d.subtype) ? d.subtype : '',
      unit: nextDef.units.includes(d.unit) ? d.unit : (nextDef.units[0] ?? ''),
      ended: nextDef.ranged ? d.ended : '',
    }));
  };

  const submit = async () => {
    if (!dirty || timeBroken) return;
    const ok = await onSave(event.id, patch);
    if (ok) onClose();
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
                  style={{ '--chip-on': `var(--t-${t.tone})` } as CSSProperties}
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
            <div
              className="field"
              style={{ '--chip-on': `var(--t-${def.tone})` } as CSSProperties}
            >
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
          </label>

          {def.ranged ? (
            <div className="field">
              <span className="field__label">Конец</span>
              <div className="field__row">
                <input
                  type="datetime-local"
                  className="input input--time"
                  value={draft.ended}
                  onChange={(e) => setDraft({ ...draft, ended: e.target.value })}
                />
                {draft.ended ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setDraft({ ...draft, ended: '' })}
                  >
                    {def.openable ? 'Идёт' : 'Убрать'}
                  </button>
                ) : null}
              </div>
              {!draft.ended ? (
                <p className="field__hint">
                  {def.openable
                    ? 'Пусто — событие ещё не закончилось.'
                    : 'Можно не заполнять, если конец не называли.'}
                </p>
              ) : null}
              {timeBroken ? (
                <p className="field__hint" style={{ color: 'var(--amber)' }}>
                  Конец раньше начала — поправьте, чтобы сохранить.
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
            {event.confidence != null ? (
              <>
                <dt>Уверенность разбора</dt>
                <dd>{Math.round(event.confidence * 100)}%</dd>
              </>
            ) : null}
            {event.updated_at ? (
              <>
                <dt>Изменено</dt>
                <dd>{formatTime(event.updated_at)}</dd>
              </>
            ) : null}
            {deleted ? (
              <>
                <dt>Удалено</dt>
                <dd>{formatTime(event.deleted_at)}</dd>
              </>
            ) : null}
          </dl>

          <p className="footnote">
            Любая правка обратима: сервер хранит прежнее состояние записи, а удаление —
            это пометка, а не стирание.
          </p>
        </div>

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
                onClick={() => {
                  onRestore(event.id);
                  onClose();
                }}
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
                onClick={() => {
                  onDelete(event.id);
                  onClose();
                }}
              >
                Удалить
              </button>
              <button
                type="button"
                className={dirty && !timeBroken ? 'btn btn--primary' : 'btn'}
                style={{ flex: 1 }}
                disabled={busy || !dirty || timeBroken}
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
