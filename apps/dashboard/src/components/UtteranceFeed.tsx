import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrackerEvent, Utterance } from '../types';
import { formatTime } from '../lib/format';
import { eventLabel } from '../lib/day';

interface Props {
  utterances: Utterance[];
  events: TrackerEvent[];
  pending: number;
}

const VISIBLE = 5;

/**
 * Белый список видов разбора. Всё, чего здесь нет, на экран не попадает.
 *
 * Это защита от утечки служебных полей: `llm_result` — не результат разбора,
 * а конверт claude CLI (`{"type":"result","session_id":…,"usage":…}`), и наивное
 * чтение `type` печатало на телевизоре слово «result». Поэтому `llm_result`
 * не рендерится вообще, а из `fast_result` берётся только известный `kind`.
 */
const KIND_LABEL: Record<string, string> = {
  sleep_start: 'заснул',
  sleep_end: 'проснулся',
  query_state: 'вопрос',
  exit: 'выход',
  unknown: 'неясно',
};

/** Фразы, которые ничего не записывают: вопрос к Алисе и прощание. */
const NON_EVENT_KINDS = new Set(['query_state', 'exit']);

interface StatusMeta {
  label: string;
  color: string;
  live?: boolean;
}

/**
 * Статус фразы человеческим языком.
 *
 * `skipped` — НЕ сбой: fast-path разобрал уверенно, и звать модель не понадобилось
 * (`llm_error` там вида «не отправлено модели: fast-path уверенно разобрал…»).
 * Экран висит в детской, поэтому тревожного красного здесь нет вовсе.
 */
function statusMeta(status: string, kind: string | null, recorded: boolean): StatusMeta {
  if (status === 'pending') return { label: 'в очереди', color: 'var(--amber)', live: true };
  if (status === 'processing') return { label: 'разбор', color: 'var(--cyan)', live: true };
  if (status === 'failed') return { label: 'не разобрано', color: 'var(--amber)' };

  if (kind && NON_EVENT_KINDS.has(kind)) {
    return { label: kind === 'exit' ? 'конец разговора' : 'вопрос', color: 'var(--text-dim)' };
  }

  const understood = recorded || (kind !== null && kind !== 'unknown');
  if (status === 'done') {
    // Модель отработала, но ничего не записала («ага отличненько») — говорить
    // «записано» было бы неправдой.
    return understood
      ? { label: 'записано', color: 'var(--green)' }
      : { label: 'принято', color: 'var(--text-dim)' };
  }
  if (status === 'skipped') {
    return understood
      ? { label: 'записано', color: 'var(--green)' }
      : { label: 'не понято', color: 'var(--text-dim)' };
  }
  return { label: 'принято', color: 'var(--text-dim)' };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Что понял матчер — только известные виды, иначе ничего. */
function fastKind(u: Utterance): string | null {
  const obj = asObject(u.fast_result);
  const kind = obj && typeof obj.kind === 'string' ? obj.kind : null;
  return kind && kind in KIND_LABEL ? kind : null;
}

/** Подсвечиваем только те фразы, что прилетели уже при нас. */
function useFreshIds(items: Utterance[]): Set<number> {
  const seen = useRef<Set<number> | null>(null);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const [fresh, setFresh] = useState<Set<number>>(new Set());

  useEffect(() => {
    const pool = timers.current;
    return () => {
      pool.forEach(clearTimeout);
      pool.clear();
    };
  }, []);

  useEffect(() => {
    const ids = items.map((i) => i.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !seen.current!.has(id));
    if (!added.length) return;
    added.forEach((id) => seen.current!.add(id));
    setFresh((prev) => new Set([...prev, ...added]));

    // Таймеры держим в ref, а не в cleanup эффекта: иначе следующее же
    // обновление списка (pending → done) отменяло бы снятие подсветки.
    added.forEach((id) => {
      const timer = setTimeout(() => {
        timers.current.delete(id);
        setFresh((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 1800);
      timers.current.set(id, timer);
    });
  }, [items]);

  return fresh;
}

export function UtteranceFeed({ utterances, events, pending }: Props) {
  const fresh = useFreshIds(utterances);
  const items = utterances.slice(0, VISIBLE);

  /** Что фраза на самом деле породила — берём из событий, а не из внутренностей разборщика. */
  const byUtterance = useMemo(() => {
    const map = new Map<number, TrackerEvent[]>();
    for (const ev of events) {
      if (ev.deleted_at || typeof ev.utterance_id !== 'number') continue;
      const list = map.get(ev.utterance_id);
      if (list) list.push(ev);
      else map.set(ev.utterance_id, [ev]);
    }
    return map;
  }, [events]);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Эфир</h2>
        <span className="panel__rule" />
        <span className="panel__meta">
          {pending > 0
            ? `+${pending} в разборе`
            : items.length
              ? `последняя ${formatTime(items[0].received_at)}`
              : 'пока тихо'}
        </span>
      </div>
      <div className="panel__body feed">
        {items.length === 0 && <span className="feed__empty">фраз пока не было</span>}
        {items.map((u) => {
          const produced = byUtterance.get(u.id) ?? [];
          const kind = fastKind(u);
          const meta = statusMeta(String(u.status), kind, produced.length > 0);

          // Сначала — что записалось на самом деле, и только потом догадка матчера.
          const tags = produced.length
            ? Array.from(new Set(produced.map(eventLabel).filter((x): x is string => !!x))).slice(0, 2)
            : kind && !NON_EVENT_KINDS.has(kind) && kind !== 'unknown'
              ? [KIND_LABEL[kind]]
              : [];

          return (
            <article
              key={u.id}
              className={`utt${fresh.has(u.id) ? ' utt--fresh' : ''}`}
              style={{ ['--utt-color' as string]: meta.color }}
            >
              <span className={`utt__dot${meta.live ? ' utt__dot--live' : ''}`} />
              <div>
                <p className="utt__text">«{u.raw_text}»</p>
                <div className="utt__meta">
                  <span>{formatTime(u.received_at)}</span>
                  <span className="utt__status">{meta.label}</span>
                  {tags.length > 0 && <span>· {tags.join(' · ')}</span>}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
