import type { CSSProperties } from 'react';
import type { HistoryFilters } from '../hooks/useHistory';
import { TYPES } from '../lib/taxonomy';
import { plural } from '../lib/format';

interface Props {
  value: HistoryFilters;
  onChange: (next: HistoryFilters) => void;
  total: number;
  deletedCount: number;
}

const RANGES = [
  { days: 1, label: 'Сегодня' },
  { days: 3, label: '3 дня' },
  { days: 7, label: 'Неделя' },
  { days: 30, label: 'Месяц' },
];

export function Filters({ value, onChange, total, deletedCount }: Props) {
  const toggleType = (id: string) => {
    const has = value.types.includes(id);
    onChange({
      ...value,
      types: has ? value.types.filter((t) => t !== id) : [...value.types, id],
    });
  };

  return (
    <div className="filters">
      <div className="chiprow" role="group" aria-label="Период">
        {RANGES.map((r) => (
          <button
            key={r.days}
            type="button"
            className="chip"
            aria-pressed={value.days === r.days}
            onClick={() => onChange({ ...value, days: r.days })}
          >
            {r.label}
          </button>
        ))}
        <span className="chip chip--ghost" aria-hidden="true" style={{ opacity: 0.25 }}>
          |
        </span>
        <button
          type="button"
          className="chip"
          aria-pressed={value.showDeleted}
          onClick={() => onChange({ ...value, showDeleted: !value.showDeleted })}
          style={{ '--chip-on': 'var(--text-2)' } as CSSProperties}
        >
          Удалённые{deletedCount > 0 && !value.showDeleted ? ` · ${deletedCount}` : ''}
        </button>
      </div>

      <div className="chiprow" role="group" aria-label="Тип события">
        <button
          type="button"
          className="chip"
          aria-pressed={value.types.length === 0}
          onClick={() => onChange({ ...value, types: [] })}
        >
          Все
        </button>
        {TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="chip"
            aria-pressed={value.types.includes(t.id)}
            onClick={() => toggleType(t.id)}
            style={{ '--chip-on': `var(--t-${t.tone})` } as CSSProperties}
          >
            <span className="chip__dot" aria-hidden="true" />
            {t.short}
          </button>
        ))}
      </div>

      <p className="filters__meta">
        {total} {plural(total, 'запись', 'записи', 'записей')}
        {value.showDeleted && deletedCount > 0 ? `, из них удалённых ${deletedCount}` : ''}
      </p>
    </div>
  );
}
