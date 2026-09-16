import { useEffect } from 'react';
import type { ThemeMode } from '../hooks/useTheme';
import { formatWhen } from '../lib/format';

interface Props {
  mode: ThemeMode;
  onChoose: (mode: ThemeMode) => void;
  cachedAt: string | null;
  online: boolean;
  onDevices: () => void;
  onClose: () => void;
}

const MODES: { id: ThemeMode; label: string }[] = [
  { id: 'system', label: 'Как в системе' },
  { id: 'light', label: 'Светлая' },
  { id: 'dark', label: 'Тёмная' },
];

/**
 * Настройки. Живут за неприметной кнопкой в шапке: темой пользуются один раз,
 * и место на главном экране она не заслужила.
 */
export function SettingsSheet({
  mode,
  onChoose,
  cachedAt,
  online,
  onDevices,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <section className="sheet" role="dialog" aria-modal="true" aria-label="Настройки">
        <div className="sheet__grip" aria-hidden="true" />
        <header className="sheet__head">
          <h2 className="sheet__title">Настройки</h2>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>

        <div className="sheet__body">
          <div className="field">
            <span className="field__label">Тема</span>
            <div className="chipgrid">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="chip"
                  aria-pressed={mode === m.id}
                  onClick={() => onChoose(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="field__hint">
              По умолчанию — как в системе: ночью телефон обычно и так в тёмной. Выбор
              запоминается и переживает перезапуск.
            </p>
          </div>

          <div className="field">
            <span className="field__label">Связь</span>
            <p className="field__hint" style={{ marginTop: 0 }}>
              {!online
                ? 'Сети нет. Показано последнее, что успело загрузиться.'
                : cachedAt
                  ? `Сервер не ответил — данные от ${formatWhen(cachedAt)}.`
                  : 'Данные свежие.'}
            </p>
          </div>

          <div className="field">
            <span className="field__label">Устройства</span>
            {/*
              Кнопка намеренно молчит о том, ждёт ли кто-то одобрения.
              Значок «ждут: 2» был здесь и убран вместе с баннером на главной:
              число заявок на обычном экране — то же приглашение пойти и
              нажать, только мельче. Кто ждёт — видно на самом экране
              устройств, куда идут осознанно.
            */}
            <button
              type="button"
              className="btn"
              style={{ width: '100%' }}
              onClick={onDevices}
            >
              Одобрить и отозвать
            </button>
            <p className="field__hint">
              Кто подключён к дневнику и кто просится. Чтобы впустить новое устройство,
              нужно набрать код с его экрана. Потерянный телефон отзывается здесь одним
              нажатием.
            </p>
          </div>

          <div className="field">
            <span className="field__label">Приложение</span>
            <p className="field__hint" style={{ marginTop: 0 }}>
              Чтобы открывать дневник с домашнего экрана как приложение: в браузере
              выберите «Поделиться» → «На экран „Домой“» на iPhone или меню → «Установить
              приложение» на Android.
            </p>
          </div>
        </div>

        <footer className="sheet__foot">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Готово
          </button>
        </footer>
      </section>
    </>
  );
}
