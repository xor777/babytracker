import { useCallback, useEffect, useState } from 'react';
import type { TrackerEvent } from '../types';
import { useHistory } from '../hooks/useHistory';
import { dayTitle, formatDay, plural } from '../lib/format';
import { Filters, RANGES } from './Filters';
import { JournalEventRow, JournalPhraseRow } from './JournalRow';
import { EventSheet } from './EventSheet';

interface Props {
  onBusy: (busy: boolean) => void;
}

export function HistoryScreen({ onBusy }: Props) {
  const h = useHistory();
  const [openId, setOpenId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [undoId, setUndoId] = useState<number | null>(null);
  const [undone, setUndone] = useState(false);

  useEffect(() => onBusy(h.status === 'loading'), [h.status, onBusy]);

  const openEvent: TrackerEvent | null =
    openId == null
      ? null
      : (h.sections
          .flatMap((s) => s.rows)
          .flatMap((r) => (r.kind === 'event' ? [r.event] : r.touched))
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

  const undo = useCallback(
    async (changeSetId: string) => {
      const error = await h.undoChangeSet(changeSetId);
      if (!error) setUndone(true);
      return error;
    },
    [h],
  );

  useEffect(() => {
    if (!undone) return;
    const t = setTimeout(() => setUndone(false), 6000);
    return () => clearTimeout(t);
  }, [undone]);

  useEffect(() => {
    if (undoId == null) return;
    const t = setTimeout(() => setUndoId(null), 9000);
    return () => clearTimeout(t);
  }, [undoId]);

  const wider = RANGES.find((r) => r.days > h.filters.days);
  const empty = h.status !== 'loading' && h.sections.length === 0 && !h.error;

  return (
    <>
      <Filters
        value={h.filters}
        onChange={h.setFilters}
        total={h.total}
        phrases={h.phraseCount}
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

      {/*
       * Пустой журнал обязан объяснять, что здесь бывает и что с этим можно делать:
       * человек, у которого записей ещё нет, иначе видит голый экран без единой
       * кнопки — и решает, что правка сломана.
       */}
      {empty ? (
        <div className="empty">
          <div className="empty__mark" aria-hidden="true">
            ✎
          </div>
          <h2 className="empty__title">
            {h.filters.types.length ? 'По этому фильтру пусто' : 'Записей за период нет'}
          </h2>
          <p className="empty__text">
            Сюда попадает всё, что вы говорите Алисе: «Андрей заснул», «покормила»,
            «поменяли подгузник». Рядом с каждой записью видно исходную фразу — так
            заметно, если разбор ошибся.
          </p>
          <p className="empty__text">
            Любую запись можно поправить или удалить: нажмите на неё — откроется
            карточка с кнопками. Удаление мягкое, вернуть можно всегда.
          </p>
          <div className="empty__actions">
            {h.filters.types.length ? (
              <button
                type="button"
                className="btn"
                onClick={() => h.setFilters({ ...h.filters, types: [] })}
              >
                Показать все типы
              </button>
            ) : null}
            {wider ? (
              <button
                type="button"
                className="btn btn--primary"
                style={{ flex: 'none' }}
                onClick={() => h.setFilters({ ...h.filters, days: wider.days })}
              >
                Посмотреть за {wider.label.toLowerCase()}
              </button>
            ) : null}
            {!h.filters.showDeleted && h.deletedCount > 0 ? (
              <button
                type="button"
                className="btn"
                onClick={() => h.setFilters({ ...h.filters, showDeleted: true })}
              >
                Показать удалённые ({h.deletedCount})
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {h.sections.map((section) => (
        <section key={section.key}>
          <header className="dayhead">
            <h2 className="dayhead__title">{dayTitle(section.dayMs)}</h2>
            {/* «2 сентября · 2 сентября» — для дней старше позавчера заголовок
                и есть дата, дублировать её незачем. */}
            {dayTitle(section.dayMs) !== formatDay(section.dayMs) ? (
              <span className="dayhead__date">{formatDay(section.dayMs)}</span>
            ) : null}
            <span className="dayhead__count">
              {section.events > 0
                ? `${section.events} ${plural(section.events, 'запись', 'записи', 'записей')}`
                : null}
              {section.events > 0 && section.phrases > 0 ? ' · ' : null}
              {section.phrases > 0
                ? `${section.phrases} ${plural(section.phrases, 'фраза', 'фразы', 'фраз')}`
                : null}
            </span>
          </header>

          <div className="jlist">
            {section.rows.map((row) =>
              row.kind === 'event' ? (
                <JournalEventRow
                  key={row.key}
                  row={row}
                  open={expanded === row.key}
                  busy={h.busyId === row.event.id}
                  busySet={h.busySet}
                  onToggle={() => setExpanded((cur) => (cur === row.key ? null : row.key))}
                  onEdit={(e) => setOpenId(e.id)}
                  onRestore={restore}
                  onUndo={undo}
                />
              ) : (
                <JournalPhraseRow
                  key={row.key}
                  row={row}
                  open={expanded === row.key}
                  busySet={h.busySet}
                  onToggle={() => setExpanded((cur) => (cur === row.key ? null : row.key))}
                  onEdit={(e) => setOpenId(e.id)}
                  onUndo={undo}
                />
              ),
            )}
          </div>
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
      ) : undone ? (
        <div className="toast" role="status">
          <span>Готово: дневник вернулся к прежнему состоянию.</span>
        </div>
      ) : null}
    </>
  );
}
