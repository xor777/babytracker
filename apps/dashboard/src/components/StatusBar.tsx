import type { Health, LinkStatus } from '../types';
import { formatClock, plural } from '../lib/format';

interface Props {
  link: LinkStatus;
  health: Health | null;
  /** Наша зона отображения назвала сегодняшний день иначе, чем сервер. */
  tzMismatch: boolean;
  pending: number;
  lastSyncAt: number | null;
  now: number;
  childName: string;
  ageDays: number;
}

function linkChip(link: LinkStatus, lastSyncAt: number | null, now: number) {
  if (link === 'online') {
    return { color: 'var(--green)', text: 'связь в эфире', alert: false, live: true, note: null };
  }
  if (link === 'connecting') {
    return { color: 'var(--cyan)', text: 'подключение', alert: false, live: true, note: null };
  }
  // Строка короткая намеренно: она делит место с остальными чипами.
  const ago = lastSyncAt ? Math.max(0, Math.round((now - lastSyncAt) / 1000)) : null;
  const note =
    ago == null ? null : ago < 60 ? `данные ${ago} с назад` : `данные ${Math.round(ago / 60)} мин назад`;
  return { color: 'var(--amber)', text: 'нет связи · переподключаюсь', alert: true, live: true, note };
}

export function StatusBar({
  link,
  health,
  tzMismatch,
  pending,
  lastSyncAt,
  now,
  childName,
  ageDays,
}: Props) {
  const chip = linkChip(link, lastSyncAt, now);
  // Когда claude недоступен, воркер помечает фразы skipped и очередь всегда пуста —
  // показываем вместо неё честную причину. Два чипа сразу в строку не влезут.
  const llmDown = health?.worker?.claudeAvailable === false;

  return (
    <footer className="statusbar">
      <span
        className={`chip${chip.live ? ' chip--live' : ''}${chip.alert ? ' chip--alert' : ''}`}
        style={{ ['--chip-color' as string]: chip.color }}
      >
        <i className="chip__dot" />
        {chip.text}
        {chip.note && <b>· {chip.note}</b>}
      </span>

      {llmDown ? (
        <span className="chip" style={{ ['--chip-color' as string]: 'var(--text-faint)' }}>
          <i className="chip__dot" />
          разбор фраз недоступен
        </span>
      ) : (
        <span
          className={`chip${pending > 0 ? ' chip--live' : ''}`}
          style={{ ['--chip-color' as string]: pending > 0 ? 'var(--amber)' : 'var(--cyan-deep)' }}
        >
          <i className="chip__dot" />
          очередь разбора <b>{pending}</b>
        </span>
      )}

      {/* Молчаливое расхождение хуже явной поломки: если пояс телевизора
          разошёлся с серверным, счётчики суток соврут — и это надо видеть. */}
      {tzMismatch && (
        <span
          className="chip chip--alert chip--shrink"
          style={{ ['--chip-color' as string]: 'var(--amber)' }}
        >
          <i className="chip__dot" />
          часовой пояс расходится
        </span>
      )}

      <span className="statusbar__spacer" />

      <span className="chip">
        {childName} <b>{ageDays}</b> {plural(ageDays, 'сутки', 'суток', 'суток')} · <b>{formatClock(now)}</b>
      </span>
    </footer>
  );
}
