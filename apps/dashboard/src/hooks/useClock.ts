import { useEffect, useState } from 'react';

/**
 * Тикает раз в секунду, выравниваясь по границе секунды.
 * Сервер не дёргается — всё считается локально (контракт §6).
 */
export function useClock(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const stamp = Date.now();
      setNow(stamp);
      timer = setTimeout(tick, 1000 - (stamp % 1000));
    };
    timer = setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => clearTimeout(timer);
  }, []);

  return now;
}

/**
 * Масштабирует «сцену» 1920×1080 под реальный экран: телевизор может быть
 * 1920×1080, 1280×720 или окно браузера произвольного размера — вёрстка одна и та же,
 * скролла нет никогда.
 */
export function useStageScale(): void {
  useEffect(() => {
    const apply = () => {
      const w = document.documentElement.clientWidth || window.innerWidth;
      const h = document.documentElement.clientHeight || window.innerHeight;
      const scale = Math.min(w / 1920, h / 1080);
      if (scale > 0) document.documentElement.style.setProperty('--stage-scale', scale.toFixed(4));
    };
    apply();

    // ResizeObserver надёжнее события resize: WebView телевизора умеет менять
    // размер вьюпорта (панель навигации, смена режима) не рассылая resize.
    const ro = new ResizeObserver(apply);
    ro.observe(document.documentElement);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, []);
}
