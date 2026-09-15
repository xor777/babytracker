import { useCallback, useEffect, useState } from 'react';
import type { TrackerEvent } from '../types';
import { useHistory } from '../hooks/useHistory';
import { dayTitle, formatDay, plural } from '../lib/format';
import { Filters } from './Filters';
import { GroupCard } from './GroupCard';
import { EventSheet } from './EventSheet';

interface Props {
  onBusy: (busy: boolean) => void;
}

export function HistoryScreen({ onBusy }: Props) {
  const h = useHistory();
  const [openId, setOpenId] = useState<number | null>(null);
  const [undoId, setUndoId] = useState<number | null>(null);

  useEffect(() => onBusy(h.status === 'loading'), [h.status, onBusy]);

  // Лист всегда показывает свежую версию записи: после сохранения она приезжает с сервера.
  const openEvent: TrackerEvent | null =
    openId == null
      ? null
      : (h.sections
          .flatMap((s) => s.groups)
          .flatMap((g) => g.events)
          .find((e) => e.id === openId) ?? null);

  const remove = useCallback(
    async (id: number) => {
      const error = await h.remove(id);
      if (!error) setUndoId(id);
      return error;
    },
    [h],
  );

  const restore = useCallback(
    async (id: number) => {
      const error = await h.restore(id);
      if (!error) setUndoId((cur) => (cur === id ? null : cur));
      return error;
    },
    [h],
  );

  useEffect(() => {
    if (undoId == null) return;
    const t = setTimeout(() => setUndoId(null), 9000);
    return () => clearTimeout(t);
  }, [undoId]);

  return (
    <>
      <Filters
        value={h.filters}
        onChange={h.setFilters}
        total={h.total}
        deletedCount={h.deletedCount}
      />

      {h.error ? (
        <div className="banner" role="status">
          <span>{h.error}</span>
          <button type="button" className="banner__btn" onClick={h.reload}>
            Ещё раз
          </button>
        </div>
      ) : null}

      {h.notice ? (
        <div className="banner banner--quiet" role="status">
          <span>{h.notice}</span>
        </div>
      ) : null}

      {h.status === 'loading' && h.sections.length === 0 ? (
        <p className="placeholder">Загружаю историю…</p>
      ) : null}

      {h.status !== 'loading' && h.sections.length === 0 && !h.error ? (
        <p className="placeholder">
          <span className="placeholder__big">Здесь пусто</span>
          За выбранный период записей нет. Попробуйте период побольше или снимите фильтр по типу.
        </p>
      ) : null}

      {h.sections.map((section) => (
        <section key={section.key}>
          <header className="dayhead">
            <h2 className="dayhead__title">{dayTitle(section.dayMs)}</h2>
            <span className="dayhead__date">{formatDay(section.dayMs)}</span>
            <span className="dayhead__count">
              {section.total} {plural(section.total, 'запись', 'записи', 'записей')}
            </span>
          </header>
          {section.groups.map((group) => (
            <GroupCard
              key={group.key}
              group={group}
              busyId={h.busyId}
              onOpen={(e) => setOpenId(e.id)}
              onRestore={restore}
            />
          ))}
        </section>
      ))}

      {openEvent ? (
        <EventSheet
          event={openEvent}
          busy={h.busyId === openEvent.id}
          onClose={() => setOpenId(null)}
          onSave={h.save}
          onDelete={remove}
          onRestore={restore}
        />
      ) : null}

      {undoId != null ? (
        <div className="toast" role="status">
          <span>Запись удалена. Её можно вернуть.</span>
          <button type="button" className="toast__btn" onClick={() => restore(undoId)}>
            Вернуть
          </button>
        </div>
      ) : null}
    </>
  );
}
