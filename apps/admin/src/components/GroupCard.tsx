import type { EventGroup } from '../lib/group';
import type { TrackerEvent } from '../types';
import { HOUR, formatTime, parseTs, plural } from '../lib/format';
import { sourceLabel } from '../lib/taxonomy';
import { EventRow } from './EventRow';

interface Props {
  group: EventGroup;
  busyId: number | null;
  onOpen: (event: TrackerEvent) => void;
  onRestore: (id: number) => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'в очереди на разбор',
  processing: 'разбирается',
  failed: 'разбор не удался',
  skipped: 'разбор пропущен',
};

const EMPTY_LABEL: Record<string, string> = {
  pending: 'Фраза ещё ждёт разбора.',
  processing: 'Фразу сейчас разбирают.',
  failed: 'Разбор не справился — записей по этой фразе нет.',
  skipped: 'Разбор пропущен — записей по этой фразе нет.',
};

/** Насколько далеко запись может уехать от фразы, прежде чем это стоит показать. */
const FAR = 6 * HOUR;

/**
 * Гроздь: исходная фраза Алисы и всё, что из неё получилось (§10.3).
 * Ради этой связки экран и существует — видно, что «покушал и уснул» стало двумя записями.
 */
export function GroupCard({ group, busyId, onOpen, onRestore }: Props) {
  const { utterance, events } = group;
  const solo = !utterance;
  const failed = utterance?.status === 'failed' || utterance?.status === 'skipped';
  const statusNote = utterance?.status ? STATUS_LABEL[utterance.status] : undefined;

  // Источник у всех записей грозди обычно один — показываем его в шапке, а не в каждой строке.
  const sources = [...new Set(events.map((e) => e.source).filter(Boolean))] as string[];

  /*
   * Время фразы знаем не всегда: текст приходит вместе с событием, а received_at —
   * только из /api/utterances. Если его нет, показываем время первой записи,
   * а расхождение не считаем: сравнивать было бы не с чем.
   */
  const saidAt = parseTs(utterance?.received_at);
  const firstAt = parseTs(events[0]?.started_at ?? null);
  const headTime = saidAt ?? firstAt;
  const shifted =
    saidAt != null &&
    events.some((e) => {
      const ms = parseTs(e.started_at);
      return ms != null && Math.abs(ms - saidAt) > FAR;
    });

  return (
    <article className={solo ? 'group group--solo' : 'group'}>
      {utterance ? (
        <div className={failed ? 'said said--failed' : 'said'}>
          <span className="said__text">{utterance.raw_text}</span>
          <span className="said__meta">
            <span className="mono">{formatTime(headTime)}</span>
            {events.length > 1 ? (
              <span>
                · {events.length}{' '}
                {plural(events.length, 'запись', 'записи', 'записей')}
              </span>
            ) : null}
            {sources.length === 1 ? <span>· {sourceLabel(sources[0])}</span> : null}
            {statusNote ? <span>· {statusNote}</span> : null}
            {shifted ? <span>· запись на другое время</span> : null}
          </span>
        </div>
      ) : null}

      <div
        className={
          events.length && !solo ? 'group__events group__events--rows' : 'group__events'
        }
      >
        {events.length === 0 ? (
          <p className={failed ? 'group__empty group__empty--gap' : 'group__empty'}>
            {EMPTY_LABEL[utterance?.status ?? ''] ?? 'Записей по этой фразе нет.'}
          </p>
        ) : (
          events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              busy={busyId === event.id}
              onOpen={onOpen}
              onRestore={onRestore}
            />
          ))
        )}
      </div>
    </article>
  );
}
