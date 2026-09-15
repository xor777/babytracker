import { useEffect, useRef, useState } from 'react';
import type { Utterance } from '../types';
import { formatTime } from '../lib/format';

interface Props {
  utterances: Utterance[];
  pending: number;
}

const VISIBLE = 5;

const STATUS_META: Record<string, { label: string; color: string; live?: boolean }> = {
  pending: { label: 'в очереди', color: 'var(--amber)', live: true },
  processing: { label: 'разбор', color: 'var(--cyan)', live: true },
  done: { label: 'записано', color: 'var(--green)' },
  failed: { label: 'ошибка', color: 'var(--red)' },
  // Штатная ситуация: LLM-разбор недоступен, фраза осталась как есть. Не ошибка.
  skipped: { label: 'без разбора', color: 'var(--text-dim)' },
};

const KIND_LABEL: Record<string, string> = {
  sleep_start: 'заснул',
  sleep_end: 'проснулся',
  query_state: 'запрос',
  exit: 'выход',
  unknown: 'неясно',
};

const TYPE_LABEL: Record<string, string> = {
  sleep: 'сон',
  feed: 'кормление',
  diaper: 'подгузник',
  measure: 'замер',
  meds: 'лекарство',
  note: 'заметка',
};

/**
 * Сервер отдаёт fast_result/llm_result уже разобранными объектами (в БД это TEXT,
 * наружу — объект). Строку всё равно переживаем: вдруг попадётся сырое поле.
 */
function asResult(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return { kind: trimmed.slice(0, 24) };
  }
}

/** Человекочитаемая суть разбора фразы. */
function describe(u: Utterance): string | null {
  for (const raw of [u.llm_result, u.fast_result]) {
    const obj = asResult(raw);
    if (!obj) continue;
    if (typeof obj.kind === 'string' && obj.kind) return KIND_LABEL[obj.kind] ?? obj.kind;
    if (typeof obj.type === 'string' && obj.type) return TYPE_LABEL[obj.type] ?? obj.type;
  }
  return null;
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

export function UtteranceFeed({ utterances, pending }: Props) {
  const fresh = useFreshIds(utterances);
  const items = utterances.slice(0, VISIBLE);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Эфир</h2>
        <span className="panel__rule" />
        <span className="panel__meta">{pending > 0 ? `+${pending} в разборе` : 'тихо'}</span>
      </div>
      <div className="panel__body feed">
        {items.length === 0 && <span className="feed__empty">фраз пока не было</span>}
        {items.map((u) => {
          const meta = STATUS_META[u.status] ?? { label: String(u.status), color: 'var(--cyan)' };
          const kind = describe(u);
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
                  {kind && <span>· {kind}</span>}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
