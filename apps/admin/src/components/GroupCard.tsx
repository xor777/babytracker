import { useState } from 'react';
import type { EventGroup } from '../lib/group';
import { undoableSets } from '../lib/group';
import type { TrackerEvent } from '../types';
import { HOUR, formatTime, parseTs, plural } from '../lib/format';
import { sourceLabel, typeDef } from '../lib/taxonomy';
import { describeEvent } from '../lib/describe';
import { classifyPhrase } from '../lib/utterance';
import { EventRow } from './EventRow';

interface Props {
  group: EventGroup;
  busyId: number | null;
  busySet: string | null;
  onOpen: (event: TrackerEvent) => void;
  onRestore: (id: number) => void;
  onUndo: (changeSetId: string) => Promise<string | null>;
}

/** Насколько далеко запись может уехать от фразы, прежде чем это стоит показать. */
const FAR = 6 * HOUR;

/**
 * Гроздь: исходная фраза Алисы и всё, что из неё получилось (§10.3).
 *
 * «Получилось» — это не только созданные записи. Фраза может ИЗМЕНИТЬ чужую:
 * «андрей проснулся» закрывает начатый ранее сон. Такая фраза не имеет ни одного
 * события со своим utterance_id, и раньше показывалась как не сделавшая ничего —
 * при том что дневник она поменяла, и откатить это было неоткуда.
 */
export function GroupCard({ group, busyId, busySet, onOpen, onRestore, onUndo }: Props) {
  const { utterance, events, touched, changeSets } = group;
  const [confirming, setConfirming] = useState(false);
  const solo = !utterance;

  const live = undoableSets(changeSets);
  const affected = new Set(live.flatMap((cs) => cs.events ?? []));
  const changedOnly = events.length === 0 && touched.length > 0;

  // Настоящий пробел разбора ищем только там, где фраза вообще ничего не сделала.
  const verdict =
    utterance && events.length === 0 && touched.length === 0 ? classifyPhrase(utterance) : null;
  const gap = verdict?.show === true && verdict.tone === 'gap';

  // Набор был и его уже откатили — это тоже надо сказать, иначе непонятно,
  // почему у фразы ничего нет.
  const reverted = changeSets.length > 0 && live.length === 0 && events.length === 0;

  const sources = [...new Set(events.map((e) => e.source).filter(Boolean))] as string[];

  const saidAt = parseTs(utterance?.received_at);
  const firstAt = parseTs(events[0]?.started_at ?? null);
  const headTime = saidAt ?? firstAt;
  const shifted =
    saidAt != null &&
    events.some((e) => {
      const ms = parseTs(e.started_at);
      return ms != null && Math.abs(ms - saidAt) > FAR;
    });

  const undoing = live.some((cs) => cs.id === busySet);

  const undoLabel = (() => {
    if (changedOnly) return affected.size > 1 ? 'Отменить изменения' : 'Отменить изменение';
    return affected.size > 1 ? 'Отменить фразу' : 'Отменить запись';
  })();

  const undoHint = (() => {
    if (changedOnly) {
      return affected.size > 1
        ? `Вернёт ${affected.size} ${plural(affected.size, 'запись', 'записи', 'записей')} в прежнее состояние`
        : 'Вернёт запись в прежнее состояние';
    }
    return affected.size > 1
      ? `Уберёт ${affected.size} ${plural(affected.size, 'запись', 'записи', 'записей')}, созданные этой фразой`
      : 'Уберёт запись, созданную этой фразой';
  })();

  const runUndo = () => {
    // Набор может затронуть несколько записей разом — о таком предупреждаем заранее.
    if (affected.size > 1 && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    const target = live[0];
    if (target) void onUndo(target.id);
  };

  return (
    <article className={solo ? 'group group--solo' : 'group'}>
      {utterance ? (
        <div className={gap ? 'said said--gap' : 'said'}>
          <span className="said__text">{utterance.raw_text}</span>
          <span className="said__meta">
            <span className="mono">{formatTime(headTime)}</span>
            {events.length > 1 ? (
              <span>
                · {events.length} {plural(events.length, 'запись', 'записи', 'записей')}
              </span>
            ) : null}
            {changedOnly ? (
              <span>
                · изменила {touched.length}{' '}
                {plural(touched.length, 'запись', 'записи', 'записей')}
              </span>
            ) : null}
            {sources.length === 1 ? <span>· {sourceLabel(sources[0])}</span> : null}
            {shifted ? <span>· запись на другое время</span> : null}
          </span>
        </div>
      ) : null}

      <div
        className={events.length && !solo ? 'group__events group__events--rows' : 'group__events'}
      >
        {events.length > 0 ? (
          events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              busy={busyId === event.id}
              onOpen={onOpen}
              onRestore={onRestore}
            />
          ))
        ) : changedOnly ? (
          /* Фраза изменила чужую запись: показываем, какую именно, и даём её открыть. */
          <div className="changed">
            <p className="changed__title">
              {live.length === 0
                ? 'Изменила существующую запись — изменение отменено'
                : touched.length > 1
                  ? 'Изменила уже существующие записи'
                  : 'Изменила уже существующую запись'}
            </p>
            {touched.map((e) => {
              const lines = describeEvent(e);
              const def = typeDef(e.type);
              return (
                <button
                  key={e.id}
                  type="button"
                  className="changed__row"
                  style={{ ['--tone' as string]: `var(--t-${def.tone})` }}
                  onClick={() => onOpen(e)}
                >
                  <span className="changed__icon" aria-hidden="true">
                    {lines.icon}
                  </span>
                  <span className="changed__body">
                    <span className="changed__name">
                      {lines.title}
                      {lines.sub ? ` · ${lines.sub}` : ''}
                    </span>
                    <span className="changed__detail">
                      {formatTime(e.started_at)}
                      {lines.parts.length ? ` · ${lines.parts.join(' · ')}` : ''}
                    </span>
                  </span>
                  <span className="changed__open">открыть</span>
                </button>
              );
            })}
          </div>
        ) : reverted ? (
          <p className="group__empty">Изменение этой фразы отменено.</p>
        ) : (
          <div className={gap ? 'group__empty group__empty--gap' : 'group__empty'}>
            <span>{verdict?.show ? verdict.title : 'Дневник эта фраза не изменила.'}</span>
            {verdict?.show && verdict.detail ? (
              <span className="group__empty-detail">{verdict.detail}</span>
            ) : null}
          </div>
        )}
      </div>

      {live.length > 0 ? (
        <div className="undo">
          {confirming ? (
            <>
              <span className="undo__hint">{undoHint}. Точно отменить?</span>
              <button type="button" className="undo__btn" disabled={undoing} onClick={runUndo}>
                Да, отменить
              </button>
              <button type="button" className="undo__cancel" onClick={() => setConfirming(false)}>
                Нет
              </button>
            </>
          ) : (
            <>
              <span className="undo__hint">{undoHint}</span>
              <button type="button" className="undo__btn" disabled={undoing} onClick={runUndo}>
                {undoing ? 'Отменяю…' : undoLabel}
              </button>
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}
