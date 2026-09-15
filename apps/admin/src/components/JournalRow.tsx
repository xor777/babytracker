import type { CSSProperties } from 'react';
import type { EventRowData, PhraseRowData } from '../lib/journal';
import type { TrackerEvent } from '../types';
import { undoableSets } from '../lib/group';
import { describeEvent, describePhrase, hasTimeSpan, summaryLine } from '../lib/describe';
import { formatTime, formatWhen, plural } from '../lib/format';
import { sourceLabel, typeDef } from '../lib/taxonomy';

interface EventProps {
  row: EventRowData;
  open: boolean;
  busy: boolean;
  busySet: string | null;
  onToggle: () => void;
  onEdit: (event: TrackerEvent) => void;
  onRestore: (id: number) => void;
  onUndo: (changeSetId: string) => Promise<string | null>;
}

/**
 * Строка дневника. Свёрнутая — время и суть в одну строку, чтобы за экран
 * влезало много. Подробности (фраза Алисы, заметка, уверенность, кнопки)
 * приезжают по тапу.
 */
export function JournalEventRow({
  row,
  open,
  busy,
  busySet,
  onToggle,
  onEdit,
  onRestore,
  onUndo,
}: EventProps) {
  const { event, utterance, siblings, reason } = row;
  const def = typeDef(event.type);
  const lines = describeEvent(event);
  const deleted = Boolean(event.deleted_at);
  const live = undoableSets(row.changeSets);
  const affected = new Set(live.flatMap((cs) => cs.events ?? []));
  // describeEvent уже снял служебный префикс и убрал сторону груди, которая
  // и так показана в строке, — иначе в подробностях висело бы сырое «both».
  const note = lines.note;

  const cls = [
    'jrow',
    open ? 'jrow--open' : '',
    row.needsCheck ? 'jrow--check' : '',
    deleted ? 'jrow--deleted' : '',
    busy ? 'jrow--busy' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} style={{ '--tone': `var(--t-${def.tone})` } as CSSProperties}>
      <button type="button" className="jrow__head" onClick={onToggle} aria-expanded={open}>
        <span className="jrow__time">{formatTime(event.started_at)}</span>
        <span className="jrow__icon" aria-hidden="true">
          {lines.icon}
        </span>
        <span className="jrow__text">{summaryLine(event)}</span>
        {row.needsCheck ? (
          <span className="jrow__flag" title={reason ?? undefined} aria-label="стоит проверить">
            ?
          </span>
        ) : null}
        <span className="jrow__chev" aria-hidden="true">
          {open ? '⌃' : '⌄'}
        </span>
      </button>

      {open ? (
        <div className="jdet">
          {utterance?.raw_text ? (
            <p className="jdet__said">«{utterance.raw_text}»</p>
          ) : (
            <p className="jdet__said jdet__said--none">Запись добавлена без фразы Алисы</p>
          )}

          {reason ? <p className="jdet__warn">Стоит проверить: {reason}</p> : null}
          {note ? <p className="jdet__note">{note}</p> : null}

          {/* «С 21:04 до 21:04» — такая же пустая строка, как «0 мин»: у точечного
              события промежутка нет, и время уже стоит в свёрнутой строке. */}
          {lines.open ? (
            <p className="jdet__line">Началось в {formatTime(event.started_at)}, ещё идёт</p>
          ) : hasTimeSpan(event) ? (
            <p className="jdet__line">
              С {formatTime(event.started_at)} до {formatTime(event.ended_at)}
            </p>
          ) : null}

          {siblings.length > 0 ? (
            <p className="jdet__line">
              Из той же фразы: {siblings.map((s) => summaryLine(s)).join('; ')}
            </p>
          ) : null}

          <dl className="jdet__meta">
            <dt>Источник</dt>
            <dd>{sourceLabel(event.source)}</dd>
            {event.confidence != null ? (
              <>
                <dt>Уверенность</dt>
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

          <div className="jdet__actions">
            {deleted ? (
              <button type="button" className="jbtn jbtn--accent" onClick={() => onRestore(event.id)}>
                Вернуть
              </button>
            ) : (
              <button type="button" className="jbtn jbtn--accent" onClick={() => onEdit(event)}>
                Править или удалить
              </button>
            )}
            {live.length > 0 && !deleted ? (
              <button
                type="button"
                className="jbtn"
                disabled={live.some((cs) => cs.id === busySet)}
                onClick={() => void onUndo(live[0].id)}
              >
                Отменить фразу
                {affected.size > 1 ? ` (${affected.size})` : ''}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface PhraseProps {
  row: PhraseRowData;
  open: boolean;
  busySet: string | null;
  onToggle: () => void;
  onEdit: (event: TrackerEvent) => void;
  onUndo: (changeSetId: string) => Promise<string | null>;
}

/**
 * Фраза без созданных записей: либо она изменила существующую, либо её никто
 * не разобрал. И то и другое в журнале нужно, но в том же ритме, что события.
 *
 * Поэтому в свёрнутом виде стоит РАЗБОР («Сон, ночной — завершён, 7 ч 10 мин»),
 * а сама цитата уезжает в разворот: строка «что он проснулся» выглядела
 * необработанным мусором, хотя разбор отработал штатно. Цитата остаётся в
 * строке только там, где её никто не разобрал и она сама — единственный факт.
 */
export function JournalPhraseRow({ row, open, busySet, onToggle, onEdit, onUndo }: PhraseProps) {
  const { utterance, verdict, touched } = row;
  const live = undoableSets(row.changeSets);
  const affected = new Set(live.flatMap((cs) => cs.events ?? []));
  const changed = touched.length > 0;

  const summary = describePhrase(utterance.raw_text, touched, row.changeSets);

  const cls = ['jrow', 'jrow--phrase', open ? 'jrow--open' : '', row.needsCheck ? 'jrow--check' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls}>
      <button type="button" className="jrow__head" onClick={onToggle} aria-expanded={open}>
        <span className="jrow__time">{formatTime(row.at)}</span>
        <span className="jrow__icon" aria-hidden="true">
          {changed ? '↻' : '‹›'}
        </span>
        <span className={`jrow__text${summary.quote ? ' jrow__text--said' : ''}`}>
          {summary.text}
        </span>
        {row.needsCheck ? (
          <span className="jrow__flag" aria-label="стоит проверить">
            ?
          </span>
        ) : null}
        <span className="jrow__chev" aria-hidden="true">
          {open ? '⌃' : '⌄'}
        </span>
      </button>

      {open ? (
        <div className="jdet">
          {/* Цитата уехала сюда — но только если в строке стоит не она сама. */}
          {summary.quote ? null : <p className="jdet__said">«{utterance.raw_text}»</p>}

          {verdict.show ? (
            <p className={row.needsCheck ? 'jdet__warn' : 'jdet__line'}>{verdict.title}</p>
          ) : changed ? null : (
            // Набор изменений есть, а самих записей в загруженном окне нет:
            // сказать про фразу нечего, но и пустой разворот оставлять нельзя.
            <p className="jdet__line">Дневник не изменился</p>
          )}
          {verdict.show && verdict.detail ? (
            <p className="jdet__note">{verdict.detail}</p>
          ) : null}

          {changed ? (
            <p className="jdet__line">
              {touched.length === 1
                ? 'Новых записей не создала — изменила уже существующую:'
                : `Новых записей не создала — изменила ${touched.length} ${plural(
                    touched.length,
                    'запись',
                    'записи',
                    'записей',
                  )}:`}
            </p>
          ) : null}

          {touched.map((e) => (
            <button key={e.id} type="button" className="jdet__touched" onClick={() => onEdit(e)}>
              <span>{summaryLine(e)}</span>
              <span className="jdet__touched-open">открыть</span>
            </button>
          ))}

          {live.length > 0 ? (
            <div className="jdet__actions">
              <button
                type="button"
                className="jbtn jbtn--accent"
                disabled={live.some((cs) => cs.id === busySet)}
                onClick={() => void onUndo(live[0].id)}
              >
                Отменить изменение
                {affected.size > 1 ? ` (${affected.size})` : ''}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
