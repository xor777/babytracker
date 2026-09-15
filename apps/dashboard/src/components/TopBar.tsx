import { formatClock, formatDate } from '../lib/format';

interface Props {
  now: number;
  childName: string;
}

export function TopBar({ now, childName }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark" />
        <span className="brand__name">BABYTRACKER</span>
        <span className="brand__sub">{childName.toUpperCase()} · МОНИТОР СНА</span>
      </div>
      <div className="topbar__right">
        <span className="topbar__date">{formatDate(now)}</span>
        <span className="topbar__clock">{formatClock(now)}</span>
      </div>
    </header>
  );
}
