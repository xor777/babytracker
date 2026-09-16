import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { DayTimeline, MarkRun, TimeMark } from '../lib/timeline';
import { clusterMarks } from '../lib/timeline';
import { formatMinutes, formatTime, plural } from '../lib/format';

interface Props {
  timeline: DayTimeline;
  /** Подписи часов: на узком экране показываем реже. */
  compact?: boolean;
}

const HOUR_TICKS = [0, 6, 12, 18, 24];

/**
 * Размер метки и минимальный просвет между соседними — в точках экрана.
 * MARK_PX держится заодно с `--mark` в styles.css: там метка рисуется, здесь
 * по ней считается, какие метки пришлось бы рисовать друг на друге.
 * Просвет нужен отдельно: без него «не слиплись» означало бы «соприкоснулись
 * боками», а это на полосе выглядит одной кляксой.
 */
const MARK_PX = 8;
const GAP_PX = 3;

/** Пока ширина не измерена, считаем по телефону: полоса проектируется от 390 px. */
const FALLBACK_WIDTH_PX = 390;

/**
 * Полоса суток: сон блоками, кормления и подгузники — метками на оси времени.
 *
 * Свёрстана дивами, а не SVG, намеренно: позиции задаются процентами, а метки
 * остаются заданного размера на любой ширине экрана. У SVG с preserveAspectRatio
 * они бы растягивались вместе с холстом.
 *
 * Кормления и подгузники различаются прежде всего ФОРМОЙ, а не цветом:
 * кормление — круглое (пачка вытягивается в капсулу), подгузник — угловатый
 * клин вниз (пачка превращается в трапецию). Цвет только поддерживает.
 * Так метки читаются в темноте, на убавленной яркости и у тех, кто плохо
 * различает близкие оттенки, — а именно в этих условиях полосу и смотрят.
 *
 * Пустые сутки тоже выглядят осмысленно: ось часов на месте, и видно, что записей
 * пока нет, — для двухнедельного ребёнка это нормальное состояние, а не ошибка.
 */
export function DayStrip({ timeline, compact }: Props) {
  const { sleeps, feeds, diapers, nowPos } = timeline;
  const pct = (v: number) => `${Math.max(0, Math.min(100, v * 100))}%`;
  const empty = sleeps.length === 0 && feeds.length === 0 && diapers.length === 0;
  const [ref, minGap] = useMinGap();

  return (
    <div className="strip" ref={ref}>
      <div className="strip__row strip__row--sleep">
        {sleeps.map((s, i) => (
          <div
            key={`${s.from}-${i}`}
            className={s.open ? 'strip__sleep strip__sleep--open' : 'strip__sleep'}
            style={{ left: pct(s.from), width: pct(Math.max(0.004, s.to - s.from)) }}
            title={s.minutes > 0 ? `Сон ${formatMinutes(s.minutes)}` : 'Сон'}
          />
        ))}
        {nowPos != null ? (
          <div className="strip__now" style={{ left: pct(nowPos) }} aria-hidden="true" />
        ) : null}
      </div>

      <MarkRow
        marks={feeds}
        kind="feed"
        minGap={minGap}
        pct={pct}
        one="кормление"
        few="кормления"
        many="кормлений"
      />
      <MarkRow
        marks={diapers}
        kind="diaper"
        minGap={minGap}
        pct={pct}
        one="подгузник"
        few="подгузника"
        many="подгузников"
      />

      <div className="strip__axis" aria-hidden="true">
        {HOUR_TICKS.map((h) => (
          <span key={h} className="strip__tick" style={{ left: pct(h / 24) }}>
            {compact && h === 24 ? '' : `${String(h % 24).padStart(2, '0')}`}
          </span>
        ))}
      </div>

      <div className="strip__legend">
        {empty ? (
          <span className="strip__hint">За эти сутки пока ничего не записано</span>
        ) : (
          <>
            <span className="strip__key" data-kind="sleep">
              сон
            </span>
            <span className="strip__key" data-kind="feed">
              кормления {feeds.length ? `· ${feeds.length}` : ''}
            </span>
            <span className="strip__key" data-kind="diaper">
              подгузники {diapers.length ? `· ${diapers.length}` : ''}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

interface MarkRowProps {
  marks: TimeMark[];
  kind: 'feed' | 'diaper';
  minGap: number;
  pct: (v: number) => string;
  one: string;
  few: string;
  many: string;
}

/**
 * Дорожка меток одного вида. Пачка рисуется тем же элементом, что и одиночка,
 * только шире: круг вытягивается в капсулу, клин — в трапецию. Один элемент на
 * пачку вместо трёх слипшихся палочек.
 */
function MarkRow({ marks, kind, minGap, pct, one, few, many }: MarkRowProps) {
  const runs = clusterMarks(marks, minGap);
  return (
    <div className="strip__row strip__row--marks" data-kind={kind}>
      {runs.map((r) => (
        <div
          key={r.firstAt}
          className="strip__mark"
          // Метка стоит центром на своём времени, поэтому элемент шире пролёта
          // ровно на одну метку и сдвинут влево на половину (сдвиг — в CSS).
          style={{ left: pct(r.from), width: `calc(${pct(r.to - r.from)} + var(--mark))` }}
          title={runTitle(r, one, few, many)}
        />
      ))}
    </div>
  );
}

function runTitle(r: MarkRun, one: string, few: string, many: string): string {
  const name = plural(r.count, one, few, many);
  if (r.count === 1) return `${capitalize(one)} в ${formatTime(r.firstAt)}`;
  return `${r.count} ${name} · ${formatTime(r.firstAt)} – ${formatTime(r.lastAt)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Порог склейки в долях суток: он зависит от того, сколько точек досталось
 * полосе на самом деле. На 390 px склеек много, на широком экране почти нет,
 * и обе картинки правильные — метки склеиваются ровно тогда, когда иначе
 * налезли бы друг на друга.
 */
function useMinGap(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    // Без ResizeObserver (старый webview) остаётся ширина первого замера —
    // это хуже, чем пересчёт на поворот экрана, но не ломает полосу.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const px = width > 0 ? width : FALLBACK_WIDTH_PX;
  return [ref, (MARK_PX + GAP_PX) / px];
}
