import type { NormRange } from '../types';

interface Props {
  value: number;
  norm?: NormRange | null;
  /** Сегодняшний день ещё не прожит — недобор по нему ничего не значит. */
  partial?: boolean;
  tone: string;
}

/**
 * Факт против ориентира (§10.1). Сознательно без красного, без восклицаний и без диагнозов:
 * это данные о ребёнке, а не приговор. Отклонение — спокойная констатация.
 */
export function NormMeter({ value, norm, partial, tone }: Props) {
  const min = norm?.min ?? null;
  const max = norm?.max ?? null;
  if (min == null && max == null) return null;

  const upper = Math.max(max ?? min! * 2, value, min ?? 0);
  const scale = upper * 1.18 || 1;
  const x = (n: number) => Math.max(0, Math.min(300, (n / scale) * 300));

  const bandFrom = x(min ?? 0);
  const bandTo = max != null ? x(max) : 300;
  const valueX = x(value);

  const low = min != null && value < min;
  const high = max != null && value > max;
  const off = (low && !partial) || high;

  // Неполные сутки — не повод что-то заключать: просто показываем ориентир.
  let status: string | null;
  if (partial && low) status = null;
  else if (low) status = 'Ниже привычного диапазона';
  else if (high) status = 'Выше привычного диапазона';
  else status = 'В привычном диапазоне';

  const label = max != null ? `ориентир ${min}–${max}` : `ориентир ${min} и больше`;

  return (
    <>
      <svg
        className="meter"
        viewBox="0 0 300 26"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${value}, ${label}. ${status ?? 'сутки ещё идут'}`}
      >
        <rect x="0" y="10" width="300" height="6" rx="3" fill="rgba(122,190,212,0.12)" />
        <rect
          x={bandFrom}
          y="10"
          width={Math.max(2, bandTo - bandFrom)}
          height="6"
          fill={tone}
          opacity="0.28"
        />
        <rect x="0" y="10" width={valueX} height="6" rx="3" fill={tone} opacity="0.75" />
        <rect x={Math.max(0, valueX - 1)} y="4" width="2.5" height="18" fill="#dbeaf0" />
        <rect x={Math.max(0, bandFrom - 0.5)} y="6" width="1" height="14" fill={tone} opacity="0.7" />
        {max != null ? (
          <rect
            x={Math.min(299, bandTo - 0.5)}
            y="6"
            width="1"
            height="14"
            fill={tone}
            opacity="0.7"
          />
        ) : null}
      </svg>
      <p className="meter__status" data-tone={off ? 'off' : 'on'}>
        {status ? `${status} · ${label}` : label}
      </p>
      {/* Пояснение приходит от сервера словами — оно точнее любой нашей переформулировки. */}
      {norm?.note ? <p className="meter__note">{norm.note}</p> : null}
    </>
  );
}
