import { useEffect, useState } from 'react';

const DESIGN_W = 1920;
const DESIGN_H = 1080;

/**
 * Запас на overscan: телевизоры часто физически подрезают края кадра.
 * Переопределяется на лету (?safe=0.95) или на сборке (VITE_SAFE_AREA).
 *
 * 0.98, а не 0.95: на телевизоре заказчика подрезки краёв не видно — при
 * запасе в 5% по краям оставались заметные чёрные поля, то есть эти пиксели
 * экран показывает. Два процента оставлены на неточность измерения вьюпорта,
 * а не на overscan: если он где-то и есть, лучше увидеть это сразу, чем
 * годами прятать треть экрана про запас.
 */
const DEFAULT_SAFE = 0.98;

export interface StageInfo {
  /** Размер области, в которую реально вписываемся. */
  w: number;
  h: number;
  /** Ужимали ли вьюпорт до расчётного (он оказался больше). */
  capped: boolean;
  scale: number;
  safe: number;
  /** Что сказали разные источники — видно в ?debug=1. */
  client: string;
  inner: string;
  visual: string;
  dpr: number;
}

function readSafeFactor(): number {
  const fromQuery = new URLSearchParams(window.location.search).get('safe');
  const fromEnv = import.meta.env.VITE_SAFE_AREA as string | undefined;
  const raw = Number(fromQuery ?? fromEnv ?? DEFAULT_SAFE);
  if (!Number.isFinite(raw)) return DEFAULT_SAFE;
  return Math.min(1, Math.max(0.5, raw));
}

/**
 * Размер видимой области. Берём минимум по всем источникам, потому что они
 * расходятся: WebView телевизора умеет держать лейаут-вьюпорт шире того, что
 * реально видно на экране (визуальный вьюпорт), и тогда clientWidth врёт —
 * страница верстается на 1920, а видно 1280, и правый край уезжает за кадр.
 */
function measure(): { w: number; h: number; ox: number; oy: number; info: Omit<StageInfo, 'scale' | 'safe' | 'w' | 'h' | 'capped'> } {
  const el = document.documentElement;
  const vv = window.visualViewport;
  const ws: number[] = [];
  const hs: number[] = [];
  const push = (w: number, h: number) => {
    if (Number.isFinite(w) && w >= 320) ws.push(w);
    if (Number.isFinite(h) && h >= 240) hs.push(h);
  };

  push(el.clientWidth, el.clientHeight);
  push(window.innerWidth, window.innerHeight);
  if (vv) push(vv.width, vv.height);

  return {
    w: ws.length ? Math.min(...ws) : DESIGN_W,
    h: hs.length ? Math.min(...hs) : DESIGN_H,
    // Визуальный вьюпорт может быть ещё и сдвинут — держимся внутри него.
    ox: vv ? vv.offsetLeft : 0,
    oy: vv ? vv.offsetTop : 0,
    info: {
      client: `${el.clientWidth}×${el.clientHeight}`,
      inner: `${window.innerWidth}×${window.innerHeight}`,
      visual: vv ? `${Math.round(vv.width)}×${Math.round(vv.height)} @${vv.scale.toFixed(2)}` : 'нет',
      dpr: window.devicePixelRatio || 1,
    },
  };
}

/**
 * Вписывает сцену 1920×1080 в видимую область.
 * Позиционируем от левого верхнего угла собственным сдвигом, а не `left: 50%`:
 * если контейнер окажется шире видимой области, центрирование средствами CSS
 * увело бы картинку вправо за край экрана.
 */
export function useStage(): StageInfo {
  const [info, setInfo] = useState<StageInfo>(() => ({
    w: DESIGN_W,
    h: DESIGN_H,
    capped: false,
    scale: 1,
    safe: DEFAULT_SAFE,
    client: '—',
    inner: '—',
    visual: '—',
    dpr: 1,
  }));

  useEffect(() => {
    const safe = readSafeFactor();
    const root = document.documentElement.style;
    let last = '';

    const grow = new URLSearchParams(window.location.search).get('grow') === '1';

    const apply = () => {
      const { w, h, ox, oy, info: raw } = measure();

      /*
       * Вьюпорту БОЛЬШЕ расчётного не доверяем.
       *
       * На телевизоре WebView отдал область шире, чем реально видно на панели,
       * и прежняя формула честно растягивала сцену на эти лишние пиксели —
       * правая четверть уезжала за край, хотя в DOM всё было целое. Поэтому:
       * не увеличиваем сцену сверх 1:1 и держим её внутри первых 1920×1080
       * пикселей вьюпорта, которые видны наверняка.
       *
       * ?grow=1 — вернуть прежнее поведение для действительно большого экрана.
       */
      const boxW = grow ? w : Math.min(w, DESIGN_W);
      const boxH = grow ? h : Math.min(h, DESIGN_H);
      const scale = Math.min(boxW / DESIGN_W, boxH / DESIGN_H) * safe;
      const x = ox + (boxW - DESIGN_W * scale) / 2;
      const y = oy + (boxH - DESIGN_H * scale) / 2;

      root.setProperty('--stage-scale', scale.toFixed(4));
      root.setProperty('--stage-x', `${x.toFixed(1)}px`);
      root.setProperty('--stage-y', `${y.toFixed(1)}px`);

      const key = `${w}|${h}|${scale}|${raw.visual}`;
      if (key !== last) {
        last = key;
        setInfo({ w, h, capped: !grow && (w > DESIGN_W || h > DESIGN_H), scale, safe, ...raw });
      }
    };

    apply();
    // Пересчитываем по всем каналам: resize, ResizeObserver (WebView умеет менять
    // размер молча) и события визуального вьюпорта (зум/подрезка).
    const ro = new ResizeObserver(apply);
    ro.observe(document.documentElement);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    // Телевизор просыпается из standby — размеры могут приехать с задержкой.
    const slow = setInterval(apply, 5000);

    return () => {
      ro.disconnect();
      clearInterval(slow);
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      window.visualViewport?.removeEventListener('resize', apply);
      window.visualViewport?.removeEventListener('scroll', apply);
    };
  }, []);

  return info;
}

export function isDebug(): boolean {
  const q = new URLSearchParams(window.location.search);
  return q.has('debug') && q.get('debug') !== '0';
}
