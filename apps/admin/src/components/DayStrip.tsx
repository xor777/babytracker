import { Fragment, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { DayTimeline, MarkLayout, MarkSlot, TimeMark } from '../lib/timeline';
import { layoutMarks } from '../lib/timeline';
import { formatMinutes, formatTime, plural } from '../lib/format';

interface Props {
  timeline: DayTimeline;
  /** Подписи часов: на узком экране показываем реже. */
  compact?: boolean;
}

const HOUR_TICKS = [0, 6, 12, 18, 24];

/**
 * Размер знака и минимальный просвет между соседними — в точках экрана.
 * MARK_PX держится заодно с `--mark` в styles.css: там знак рисуется, здесь
 * по нему считается, какие знаки пришлось бы рисовать друг на друге.
 * Просвет нужен отдельно: без него «не слиплись» означало бы «соприкоснулись
 * боками», а это на полосе выглядит одной кляксой.
 */
const MARK_PX = 8;
const GAP_PX = 3;

/**
 * Насколько знаку позволено отъехать от своего времени ради просвета.
 *
 * Половина знака — ровно то расстояние, на котором знак ещё НАКРЫВАЕТ свою
 * минуту: время остаётся под ним, а не рядом с ним. Дальше сдвигать — врать,
 * поэтому пачка, которая не укладывается, становится одним знаком с числом.
 */
const MAX_SHIFT_PX = MARK_PX / 2;

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
 * кормление — круглое, подгузник — угловатый клин вниз. Цвет только
 * поддерживает. Так знаки читаются в темноте, на убавленной яркости и у тех,
 * кто плохо различает близкие оттенки, — а именно в этих условиях полосу и
 * смотрят.
 *
 * Пустые сутки тоже выглядят осмысленно: ось часов на месте, и видно, что записей
 * пока нет, — для двухнедельного ребёнка это нормальное состояние, а не ошибка.
 */
export function DayStrip({ timeline, compact }: Props) {
  const { sleeps, feeds, diapers, nowPos } = timeline;
  const pct = (v: number) => `${Math.max(0, Math.min(100, v * 100))}%`;
  const empty = sleeps.length === 0 && feeds.length === 0 && diapers.length === 0;
  const [ref, layout] = useMarkLayout();

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
        layout={layout}
        pct={pct}
        one="кормление"
        few="кормления"
        many="кормлений"
      />
      <MarkRow
        marks={diapers}
        kind="diaper"
        layout={layout}
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
  layout: MarkLayout;
  pct: (v: number) => string;
  one: string;
  few: string;
  many: string;
}

/**
 * Дорожка знаков одного вида: сколько событий, столько и знаков одинакового
 * размера. Считать их можно взглядом — за этим полосу и смотрят.
 *
 * Там, где знаки не развести, не соврав про время, остаётся один знак с
 * числом над ним. Строчка для числа появляется только на такой дорожке:
 * в обычные сутки подписей нет и полоса прежней высоты.
 */
function MarkRow({ marks, kind, layout, pct, one, few, many }: MarkRowProps) {
  const slots = layoutMarks(marks, layout);
  const counted = slots.some((s) => s.count > 1);

  return (
    <div
      className="strip__row strip__row--marks"
      data-kind={kind}
      data-counted={counted ? '1' : undefined}
    >
      {slots.map((s, i) => (
        <Fragment key={`${s.firstAt}-${i}`}>
          <div
            className="strip__mark"
            // Знак стоит центром на своей позиции: сдвиг влево на половину — в CSS.
            style={{ left: pct(s.pos) }}
            title={slotTitle(s, one, few, many)}
          />
          {s.count > 1 ? (
            <span className="strip__count" style={{ left: pct(s.pos) }} aria-hidden="true">
              {s.count}
            </span>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

/** Подсказка. Знак мог сдвинуться ради просвета, время в подсказке — настоящее. */
function slotTitle(s: MarkSlot, one: string, few: string, many: string): string {
  const name = plural(s.count, one, few, many);
  if (s.count === 1) return `${capitalize(one)} в ${formatTime(s.firstAt)}`;
  if (s.firstAt === s.lastAt) return `${s.count} ${name} в ${formatTime(s.firstAt)}`;
  return `${s.count} ${name} · ${formatTime(s.firstAt)} – ${formatTime(s.lastAt)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Мерки раскладки в долях суток: они зависят от того, сколько точек досталось
 * полосе на самом деле. На телефоне знаки приходится раздвигать часто, на
 * широком экране — почти никогда, и обе картинки правильные.
 */
function useMarkLayout(): [RefObject<HTMLDivElement | null>, MarkLayout] {
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
  return [ref, { pitch: (MARK_PX + GAP_PX) / px, maxShift: MAX_SHIFT_PX / px }];
}
