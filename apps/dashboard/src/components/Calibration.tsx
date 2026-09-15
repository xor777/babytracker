import type { StageInfo } from '../hooks/useStage';

/**
 * Экран калибровки: по одному снимку телевизора видно, сколько именно
 * съедается по каждому краю.
 *
 * Рамки нарисованы **относительно вьюпорта**, а не сцены, и отступают от края
 * на 2, 4, 6… процентов. Если рамка «6» видна целиком со всех сторон, а «4»
 * обрезана — панель съедает между 4 и 6 процентами. Цифры продублированы во
 * всех четырёх углах: край, который не виден, опознаётся по пропавшей цифре.
 *
 * Показания вынесены в центр: центр виден при любом overscan.
 */
const MARKS = [2, 4, 6, 8, 10, 12];

export function Calibration({ stage }: { stage: StageInfo }) {
  return (
    <div className="calib">
      {MARKS.map((percent) => (
        <div key={percent} className="calib__frame" style={{ inset: `${percent}%` }}>
          <span className="calib__tag calib__tag--tl">{percent}</span>
          <span className="calib__tag calib__tag--tr">{percent}</span>
          <span className="calib__tag calib__tag--bl">{percent}</span>
          <span className="calib__tag calib__tag--br">{percent}</span>
        </div>
      ))}

      <div className="calib__center">
        <b className="calib__title">калибровка экрана</b>
        <span>
          вьюпорт <b>{stage.client}</b> · inner <b>{stage.inner}</b>
        </span>
        <span>
          visualViewport <b>{stage.visual}</b> · dpr <b>{stage.dpr}</b>
        </span>
        <span>
          сцена <b>×{stage.scale.toFixed(3)}</b> · запас <b>{stage.safe}</b>
          {stage.capped ? ' · вьюпорт ужат до расчётного' : ''}
        </span>
        <span className="calib__hint">
          сфотографируйте экран целиком — по видимым рамкам будет понятно,
          сколько подрезает панель
        </span>
      </div>
    </div>
  );
}
