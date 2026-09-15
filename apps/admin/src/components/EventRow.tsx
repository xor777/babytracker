import type { CSSProperties } from 'react';
import type { TrackerEvent } from '../types';
import { describeEvent } from '../lib/describe';
import { formatTime, formatWhen } from '../lib/format';
import { sourceShort } from '../lib/taxonomy';

interface Props {
  event: TrackerEvent;
  busy: boolean;
  onOpen: (event: TrackerEvent) => void;
  onRestore: (id: number) => void;
}

/** Порог, ниже которого разбор стоит перепроверить глазами. */
const SHAKY = 0.6;

export function EventRow({ event, busy, onOpen, onRestore }: Props) {
  const lines = describeEvent(event);
  const deleted = Boolean(event.deleted_at);
  const shaky = event.confidence != null && event.confidence < SHAKY;

  const wrapClass = ['event-wrap', deleted ? 'event--deleted' : '', busy ? 'event--busy' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapClass} style={{ '--tone': lines.tone } as CSSProperties}>
      {/* Вся строка — одна большая кнопка: попасть пальцем можно куда угодно. */}
      <button type="button" className="event" onClick={() => onOpen(event)}>
        <span className="event__icon" aria-hidden="true">
          {lines.icon}
        </span>

        <span className="event__body">
          <span className="event__title">
            <span className="event__type">{lines.title}</span>
            {lines.sub ? <span className="event__sub">{lines.sub}</span> : null}
          </span>

          {lines.parts.length > 0 || lines.open ? (
            <span className="event__detail">
              {lines.parts.map((p) => (
                <span key={p} className="event__value">
                  {p}
                </span>
              ))}
              {lines.open ? <span className="badge badge--open">идёт</span> : null}
            </span>
          ) : null}

          {lines.note ? <span className="event__note">{lines.note}</span> : null}
        </span>

        <span className="event__right">
          <span className="event__time">{formatTime(event.started_at)}</span>
          <span className="event__flags">
            {shaky ? (
              <span className="badge badge--warn" title="Разбор не уверен — стоит проверить">
                ≈{Math.round((event.confidence ?? 0) * 100)}%
              </span>
            ) : null}
            <span className="badge">{sourceShort(event.source)}</span>
          </span>
        </span>

        {/*
         * Явная кнопка правки. Строка и так нажимается целиком, но об этом никто
         * не догадывался: «не могу редактировать» была жалоба именно на невидимость
         * действия, а не на его отсутствие.
         */}
        {!deleted ? (
          <span className="event__edit" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinejoin="round"
              />
            </svg>
            Править
          </span>
        ) : null}
      </button>

      {deleted ? (
        <div className="event__trash">
          <span>Удалено {formatWhen(event.deleted_at)}</span>
          <button type="button" className="event__restore" onClick={() => onRestore(event.id)}>
            Вернуть
          </button>
        </div>
      ) : null}
    </div>
  );
}
