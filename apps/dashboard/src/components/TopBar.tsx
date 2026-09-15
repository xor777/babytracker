import { formatClock, formatDate } from '../lib/format';

interface Props {
  now: number;
}

export function TopBar({ now }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark" />
        {/* Только видимая надпись: пакеты, каталоги и id приложения не трогаем. */}
        <span className="brand__name">ANDREYTRACKER</span>
        <span className="brand__sub">сон · питание · вес</span>
      </div>
      <div className="topbar__right">
        <span className="topbar__date">{formatDate(now)}</span>
        <span className="topbar__clock">{formatClock(now)}</span>
      </div>
    </header>
  );
}
