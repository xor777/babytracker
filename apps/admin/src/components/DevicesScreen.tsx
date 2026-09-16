import { useEffect, useRef, useState } from 'react';
import type { DevicesData } from '../hooks/useDevices';
import { goToPairing, logout } from '../api';
import { formatWhen } from '../lib/format';
import {
  USER_CODE_LENGTH,
  charsLeft,
  formatUserCode,
  isCompleteUserCode,
  normalizeUserCode,
} from '../lib/usercode';
import type { DeviceSession, PendingDevice } from '../api';

/**
 * Экран устройств: кто просится, кто уже внутри, и поле для одобрения.
 *
 * Живёт на собственном маршруте `#/devices` и никуда сам не всплывает.
 * Заказчик про это сказал прямо: «чтобы на главной не всплывало и жена
 * случайно не одобрила никому». Баннер «N устройств просят доступ», который
 * раньше появлялся поверх любого экрана и уводил в одобрение одним нажатием,
 * убран отсюда вместе с породившим его фоновым опросом.
 *
 * Но главное не в том, что экран спрятан. Спрятанная кнопка остаётся кнопкой:
 * рано или поздно её найдут и нажмут. Поэтому изменилось само действие —
 * одобрение требует НАБРАТЬ код с экрана устройства (RFC 8628 §3.3, где
 * сервер именно «prompts the end user to identify the device authorization
 * session by entering the user_code»). Случайно набрать восемь букв нельзя,
 * а список с кнопками у каждой заявки нажимается одним движением.
 *
 * Побочно закрывается и неприятный случай: чужая заявка приходит ровно в ту
 * минуту, когда человек одобряет свой телевизор, и в списке оказываются две.
 * Набранный код относится к одному устройству и ни к какому другому.
 *
 * Про опознание устройства заказчик высказался отдельно: «проблемы отличать
 * нет, я просто знаю всех по именам, так как это семья». Поэтому здесь нет
 * ни отпечатков браузера, ни геолокации — только тип, время и обратный счёт.
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

/** «8 мин» — сколько код ещё живёт. */
function leftText(seconds: number): string {
  if (seconds <= 0) return 'код истёк';
  if (seconds < 60) return `${seconds} с`;
  return `${Math.ceil(seconds / 60)} мин`;
}

/**
 * Ввод кода — единственная дорога к одобрению.
 *
 * Поле держит нормализованный код, а показывает его так же, как он написан
 * на экране устройства: `WDJB-MJHT`. Тире подставляется само — набирать его
 * человек не обязан, а если наберёт, оно всё равно отбросится.
 */
function ApproveByCode({
  busy,
  onApprove,
  onType,
}: {
  busy: boolean;
  onApprove: (code: string) => Promise<boolean>;
  onType: () => void;
}) {
  const [code, setCode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const complete = isCompleteUserCode(code);
  const left = charsLeft(code);
  const shown = formatUserCode(code);

  /*
   * Каретка всегда в конце — иначе поле переставляет буквы местами.
   *
   * Поле показывает код с тире, а хранит без него, и на пятом символе
   * показанная строка становится длиннее набранной на один знак: было
   * `GXWKZ`, стало `GXWK-Z`. React возвращает каретку на прежнее смещение —
   * пятое, — а оно теперь приходится на позицию ПЕРЕД `Z`. Следующая буква
   * встаёт не в конец, а в середину, и код тихо собирается неверным.
   *
   * Поймано вживую: клик в середину поля, `GXWK-ZZFL` и одна буква сверху
   * дали `GXWK-ZZZF`, то есть совсем другой код. Выглядит это как «сервер
   * не принимает верный код», а стоит одной из пяти попыток за окно.
   *
   * Восьмизначный код набирают одним заходом слева направо, править его
   * посреди строки незачем: ошибся — стёр и набрал заново.
   */
  useEffect(() => {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) return;
    const end = shown.length;
    if (el.selectionStart !== end || el.selectionEnd !== end) el.setSelectionRange(end, end);
  }, [shown]);

  /**
   * То же самое, но для каретки, поставленной ПАЛЬЦЕМ.
   *
   * Одного эффекта выше мало: он срабатывает на изменение строки, а тык в
   * середину поля строку не меняет — каретка просто встаёт туда, куда попали,
   * и следующая буква уходит в середину. Проверено вживую: тык в начало поля
   * и три буквы превратили `GXWKZ` в `ZFLG-XWKZ`.
   *
   * Выделение не трогаем: человек, выделивший всё тройным щелчком, собрался
   * стереть набранное и начать заново — это ему мешать не надо.
   */
  const caretToEnd = () => {
    const el = inputRef.current;
    if (!el || el.selectionStart !== el.selectionEnd) return;
    const end = el.value.length;
    if (el.selectionStart !== end) el.setSelectionRange(end, end);
  };

  const submit = async () => {
    if (!complete || busy) return;
    const ok = await onApprove(code);
    // Поле чистим только при успехе: после отказа человек чаще всего ошибся
    // в одной букве, и стирать всё набранное значило бы заставить его читать
    // код с экрана заново целиком.
    if (ok) setCode('');
  };

  return (
    <section className="devsec">
      <h2 className="devsec__title">Одобрить устройство</h2>

      <div className="devcard">
        <label className="field__label" htmlFor="usercode">
          Код с экрана устройства
        </label>
        <input
          id="usercode"
          ref={inputRef}
          className="input devcode-input"
          value={shown}
          onChange={(e) => {
            setCode(normalizeUserCode(e.target.value));
            onType();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          onFocus={caretToEnd}
          onClick={caretToEnd}
          placeholder="XXXX-XXXX"
          /*
           * Код — из букв без гласных, и ни одна клавиатурная «помощь» ему не
           * нужна: автозамена превращает набранное в слова, автодополнение
           * подставляет прошлые коды (уже недействительные), а заглавная
           * раскладка избавляет от лишнего переключения.
           */
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="done"
          aria-describedby="usercode-hint"
          disabled={busy}
        />

        <button
          type="button"
          className="btn btn--primary devcard__submit"
          disabled={!complete || busy}
          onClick={() => void submit()}
        >
          Одобрить
        </button>

        <p className="field__hint" id="usercode-hint">
          {complete
            ? 'Проверьте, что этот код сейчас написан на экране того устройства, которое вы впускаете.'
            : code.length === 0
              ? `Откройте дневник на новом устройстве — оно покажет код из ${USER_CODE_LENGTH} букв. Наберите его здесь.`
              : `Осталось набрать ${left}. В коде ${USER_CODE_LENGTH} букв, цифр и гласных в нём не бывает.`}
        </p>
      </div>
    </section>
  );
}

/**
 * Ждущая заявка — без кода и без кнопки «Одобрить».
 *
 * Показывается затем, чтобы человек, стоящий перед телевизором, видел: заявка
 * дошла, сервер о ней знает, набирать код есть смысл. Кода здесь нет
 * намеренно — иначе его можно было бы списать отсюда и одобрить чужое
 * устройство, ни разу на него не взглянув, а весь смысл набора именно в том,
 * что одобряющий этот экран видел.
 *
 * «Отклонить» осталось одним нажатием: ошибочный отказ безвреден — устройство
 * просто попросит заново. Опасно ровно обратное действие.
 */
function PendingRow({
  item,
  busy,
  onDeny,
}: {
  item: PendingDevice;
  busy: boolean;
  onDeny: () => void;
}) {
  return (
    <div className="devrow">
      <span className="devrow__icon" aria-hidden="true">
        <KindIcon kind={item.kind} />
      </span>
      <div className="devrow__body">
        <div className="devrow__name">{kindTitle(item.kind, item.label)}</div>
        <div className="devrow__meta">
          Просит доступ {formatWhen(item.requestedAt)} · код живёт ещё {leftText(item.secondsLeft)}
        </div>
      </div>
      <button type="button" className="btn btn--sm" disabled={busy} onClick={onDeny}>
        Отклонить
      </button>
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
 * Данные приходят сверху, а не заводятся здесь своим хуком: так App держит
 * один опрос на весь экран и гасит его, когда экран закрыт.
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

      {devices.notice ? (
        <div className="banner banner--quiet" role="status">
          {devices.notice}
        </div>
      ) : null}

      <ApproveByCode
        busy={devices.busy}
        onApprove={devices.approve}
        onType={devices.clearMessages}
      />

      {/*
        Раздел появляется только когда кто-то действительно ждёт. Пустой
        «Никто не просится» здесь был бы приглашением заглядывать сюда
        «на всякий случай» — ровно то, от чего уходим.
      */}
      {devices.pending.length > 0 ? (
        <section className="devsec">
          <h2 className="devsec__title">Сейчас ждут одобрения</h2>
          <div className="group">
            {devices.pending.map((item) => (
              <PendingRow
                key={item.id}
                item={item}
                busy={devices.busy}
                onDeny={() => void devices.deny(item.id)}
              />
            ))}
          </div>
          <p className="field__hint">
            Код заявки здесь не показан специально: одобрить устройство можно, только набрав
            код с его экрана. Если вы этого экрана не видите — не одобряйте.
          </p>
        </section>
      ) : null}

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
