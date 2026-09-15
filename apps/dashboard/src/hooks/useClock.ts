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
