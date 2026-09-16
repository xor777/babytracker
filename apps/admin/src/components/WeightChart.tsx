import type { GrowthPoint } from '../types';
import { DAY, formatDayShort, formatWeight, plural } from '../lib/format';

interface Props {
  /** Измерения по возрастанию времени; первое считается точкой отсчёта. */
  points: GrowthPoint[];
}

const W = 320;
const H = 132;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 14;
const PAD_B = 22;

/**
 * Вес от рождения.
 *
 * Три решения, которые тут важнее красоты:
 *
 * 1. **Ось X — время, а не номер измерения.** Взвешивают раз в несколько дней,
 *    и пробелы должны быть видны пробелами: иначе редкие замеры выглядят как
 *    ровный ежедневный ряд, которого не было.
 * 2. **Вес при рождении — базовая линия.** Берётся как самое раннее измерение,
 *    без единого зашитого числа. Первые дни ребёнок вес теряет, и именно
 *    пересечение этой линии — то, чего родители ждут.
 * 3. **Акцент на прирост.** Крупно — «сколько от рождения», потому что абсолютные
 *    граммы без точки отсчёта ни о чём не говорят.
 *
 * Никаких перцентилей и кривых ВОЗ: их у нас нет, а рисовать выдуманные —
 * значит выдавать догадку за медицинские данные.
 */
export function WeightChart({ points }: Props) {
  if (points.length === 0) {
    return (
      <p className="chart-empty">
        Веса пока нет. Скажите Алисе «взвесили, три шестьсот» — и здесь появится
        точка отсчёта.
      </p>
    );
  }

  const birth = points[0];
  const last = points[points.length - 1];
  const dayNo = Math.max(0, Math.round((last.at - birth.at) / DAY));

  // Одно-единственное измерение — это не повод рисовать «график» из одной точки.
  if (points.length === 1) {
    return (
      <p className="chart-empty">
        Это пока единственное взвешивание — точка отсчёта. Следующее покажет динамику.
      </p>
    );
  }

  const minT = birth.at;
  const maxT = Math.max(last.at, minT + DAY);
  const values = points.map((p) => p.value);
  // В шкалу обязательно входит линия рождения: иначе провал первых дней «уедет» за край.
  const lo = Math.min(...values, birth.value);
  const hi = Math.max(...values, birth.value);
  const padV = Math.max(40, (hi - lo) * 0.25);
  const vMin = lo - padV;
  const vMax = hi + padV;

  const x = (t: number) => PAD_L + ((t - minT) / (maxT - minT)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - vMin) / (vMax - vMin)) * (H - PAD_T - PAD_B);

  const baseY = y(birth.value);
  const line = points.map((p) => `${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

  // Заливка между кривой и линией рождения: показывает расстояние до неё.
  const areaBelow = `${line} ${x(last.at).toFixed(1)},${baseY.toFixed(1)} ${x(birth.at).toFixed(1)},${baseY.toFixed(1)}`;

  return (
    <>
      <svg className="weight" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Вес: при рождении ${formatWeight(birth.value)}, сейчас ${formatWeight(last.value)}`}>
        {/* Заливка между кривой и линией рождения — одним тоном по обе стороны.
            Зелёное сверху и янтарное снизу читались как «хорошо» и «плохо», а
            потеря веса в первые дни — это физиология, а не беда. Направление и
            так видно по кривой относительно пунктира. */}
        <polygon points={areaBelow} fill="var(--t-measure)" opacity="0.14" />

        {/* Линия рождения — то, с чем сравнивают */}
        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={baseY}
          y2={baseY}
          stroke="var(--text-3)"
          strokeWidth="1"
          strokeDasharray="4 4"
        />
        <text x={PAD_L} y={baseY - 5} className="weight__base">
          рождение · {formatWeight(birth.value)}
        </text>

        <polyline
          points={line}
          fill="none"
          stroke="var(--t-measure)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {points.map((p, i) => (
          <circle
            key={p.at}
            cx={x(p.at)}
            cy={y(p.value)}
            r={i === points.length - 1 ? 4 : 2.8}
            fill={i === points.length - 1 ? 'var(--t-measure)' : 'var(--bg-card)'}
            stroke="var(--t-measure)"
            strokeWidth="1.6"
          />
        ))}

        <text x={PAD_L} y={H - 6} className="weight__axis">
          {formatDayShort(birth.at)}
        </text>
        <text x={W - PAD_R} y={H - 6} textAnchor="end" className="weight__axis">
          {formatDayShort(last.at)}
        </text>
      </svg>

      <p className="card__note">
        {points.length} {plural(points.length, 'измерение', 'измерения', 'измерений')}
        {/* «за 0 дней» — пустой промежуток: все взвешивания попали в один день. */}
        {dayNo > 0 ? ` за ${dayNo} ${plural(dayNo, 'день', 'дня', 'дней')}` : ''}. Точки —
        реальные взвешивания, линия между ними проведена для наглядности.
      </p>
    </>
  );
}
