import { useState } from 'react';
import type { DevicesData } from '../hooks/useDevices';
import { goToPairing, logout } from '../api';
import { formatWhen } from '../lib/format';
import type { DeviceSession, PendingDevice } from '../api';

/**
 * Экран устройств: кто просится и кто уже внутри.
 *
 * Про экран одобрения заказчик высказался прямо: «проблемы отличать нет, я
 * просто знаю всех по именам, так как это семья». Поэтому здесь нет ни
 * отпечатков браузера, ни геолокации, ни «войти подтвердил с IP такого-то» —
 * только то, что нужно, чтобы сверить заявку с тем, что видно на экране:
 * тип устройства, время запроса и сам код. Крупно, чтобы читать не щурясь.
 */

const KIND_TITLE: Record<string, string> = {
  tv: 'Телевизор',
  phone: 'Телефон',
  browser: 'Браузер',
};

function kindTitle(kind: string, label: string | null): string {
  return label ?? KIND_TITLE[kind] ?? 'Устройство';
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === 'tv') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2.5" y="4" width="19" height="13" rx="2" stroke="currentColor" strokeWidth="1.7" />
        <path d="M8 20.5h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6" y="2.5" width="12" height="19" rx="2.6" stroke="currentColor" strokeWidth="1.7" />
      <path d="M10.5 18.6h3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/** «через 8 мин» — сколько код ещё живёт. */
function leftText(seconds: number): string {
  if (seconds <= 0) return 'код истёк';
  if (seconds < 60) return `${seconds} с`;
  return `${Math.ceil(seconds / 60)} мин`;
}

function PendingCard({
  item,
  busy,
  onApprove,
  onDeny,
}: {
  item: PendingDevice;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="devcard devcard--pending">
      <div className="devcard__head">
        <span className="devcard__icon" aria-hidden="true">
          <KindIcon kind={item.kind} />
        </span>
        <div>
          <div className="devcard__name">{kindTitle(item.kind, item.label)}</div>
          <div className="devcard__meta">
            Запросил доступ {formatWhen(item.requestedAt)} · осталось {leftText(item.secondsLeft)}
          </div>
        </div>
      </div>

      {/* Главное на экране: код. Его сверяют глазами с тем, что на устройстве. */}
      <div className="devcode" aria-label={`Код ${item.userCode}`}>
        {item.userCode}
      </div>
      <p className="devcard__hint">Этот же код должен быть написан на экране устройства.</p>

      <div className="devcard__actions">
        <button type="button" className="btn btn--primary" disabled={busy} onClick={onApprove}>
          Одобрить
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onDeny}>
          Отклонить
        </button>
      </div>
    </div>
  );
}

function SessionRow({
  item,
  busy,
  onRevoke,
}: {
  item: DeviceSession;
  busy: boolean;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="devrow">
      <span className="devrow__icon" aria-hidden="true">
        <KindIcon kind={item.kind} />
      </span>
      <div className="devrow__body">
        <div className="devrow__name">
          {kindTitle(item.kind, item.label)}
          {item.current ? <span className="devrow__badge">это устройство</span> : null}
        </div>
        <div className="devrow__meta">
          Вошло {formatWhen(item.createdAt)} · видели {formatWhen(item.lastSeenAt)}
        </div>
      </div>

      {confirming ? (
        <div className="devrow__confirm">
          <button
            type="button"
            className="btn btn--danger btn--sm"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              onRevoke();
            }}
          >
            {item.current ? 'Выйти здесь' : 'Точно отозвать'}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Отмена
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn--danger btn--sm"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          Выйти
        </button>
      )}
    </div>
  );
}

/**
 * Данные приходят сверху, а не заводятся здесь своим хуком: тот же список
 * нужен App для баннера «устройство просит доступ», и два независимых опроса
 * означали бы два запроса на каждый тик и экран, который спорит сам с собой
 * о том, есть заявка или уже нет.
 */
export function DevicesScreen({ devices }: { devices: DevicesData }) {
  const [leaving, setLeaving] = useState(false);

  const onLogout = async () => {
    setLeaving(true);
    try {
      await logout();
    } finally {
      goToPairing();
    }
  };

  return (
    <>
      {devices.error ? (
        <div className="banner" role="alert">
          {devices.error}
        </div>
      ) : null}

      <section className="devsec">
        <h2 className="devsec__title">Ждут одобрения</h2>
        {devices.pending.length === 0 ? (
          <div className="empty empty--inline">
            <p className="field__hint" style={{ marginTop: 0 }}>
              Никто не просится. Откройте дневник на новом устройстве — оно покажет код,
              и заявка появится здесь.
            </p>
          </div>
        ) : (
          devices.pending.map((item) => (
            <PendingCard
              key={item.id}
              item={item}
              busy={devices.busy}
              onApprove={() => void devices.approve(item.id)}
              onDeny={() => void devices.deny(item.id)}
            />
          ))
        )}
      </section>

      <section className="devsec">
        <h2 className="devsec__title">Подключённые устройства</h2>
        {devices.sessions.length === 0 ? (
          <div className="empty empty--inline">
            <p className="field__hint" style={{ marginTop: 0 }}>
              {devices.loaded ? 'Пусто.' : 'Загружаю…'}
            </p>
          </div>
        ) : (
          <div className="group">
            {devices.sessions.map((item) => (
              <SessionRow
                key={item.id}
                item={item}
                busy={devices.busy}
                onRevoke={() => void devices.revoke(item.id)}
              />
            ))}
          </div>
        )}
        <p className="field__hint">
          «Выйти» отключает устройство немедленно: оно перестаёт получать данные в ту же
          секунду, даже если сейчас открыто. Потерянный телефон отзывается отсюда.
        </p>
      </section>

      <section className="devsec">
        <button type="button" className="btn btn--danger" disabled={leaving} onClick={() => void onLogout()}>
          Выйти на этом устройстве
        </button>
        <p className="field__hint">
          Сессия завершится, а сохранённые для работы без сети данные будут стёрты с
          телефона — иначе приложение продолжало бы показывать историю из памяти.
        </p>
      </section>
    </>
  );
}
