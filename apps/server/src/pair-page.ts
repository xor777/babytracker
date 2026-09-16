/**
 * Страница сопряжения `/pair`.
 *
 * Одним файлом и без единого внешнего ресурса — это не аскетизм, а следствие
 * правила «открыто только перечисленное». Собранный дашборд закрыт дверью
 * целиком, вместе со своими `assets/*`; будь страница сопряжения обычным
 * SPA, пришлось бы открыть и её бандл, и её шрифты, и её иконки — то есть
 * целый каталог, растущий при каждой пересборке. Одна строка HTML открывает
 * ровно один путь, и список открытого остаётся проверяемым глазами.
 *
 * Экран один на всех: телевизор смотрят с трёх метров, телефон — с тридцати
 * сантиметров, поэтому размер кода задан в vmin и сам подстраивается.
 *
 * ── Почему опрос устроен так странно ──────────────────────────────────────
 *
 * На боевой приставке (`Chromecast Build/UTTC…; wv`) страница завела код,
 * человек одобрил его за 39 секунд — и телевизор за сессией не пришёл.
 * В базе у заявки `last_polled_at = NULL`: опроса не было НИ ОДНОГО, хотя
 * обратный отсчёт на экране честно дотикал все десять минут до «0:01».
 * То есть `setInterval(…, 1000)` на этом устройстве работал шестьсот раз
 * подряд, а `setTimeout(poll, 5000)` не привёл к отправке запроса ни разу.
 *
 * Причина осталась неустановленной, и это осознанный размен: телевизор —
 * единственный экран, который нельзя починить руками, и ему нужна страница,
 * которая доводит дело до конца на любом капризном движке. Поэтому здесь:
 *
 * 1. **Ни одного `setTimeout`.** Всё время меряется часами (`Date.now()`),
 *    а решения принимает один «пульс», который дёргают сразу несколько
 *    независимых источников: `setInterval`, кадры отрисовки, событие
 *    CSS-анимации и события возврата к экрану. Достаточно, чтобы работал
 *    любой один из них.
 * 2. **Первый опрос уходит сразу**, из ответа на запрос кода, без всякой
 *    отложенности — той же цепочкой промисов, которая доказанно работает.
 * 3. **Перезагрузка страницы заменяет опрос.** Код и его срок переживают
 *    перезагрузку, и при старте страница первым делом спрашивает сервер,
 *    не одобрен ли уже сохранённый код. На пульте есть MENU (и долгое
 *    «Назад»), оболочка по ним перезагружает страницу — значит у человека
 *    остаётся рабочая дорога даже там, где не тикает вообще ничего.
 * 4. **Состояние, часы и диагностика — разные строки.** Раньше сообщение об
 *    ошибке писалось в тот же элемент, что и обратный отсчёт, и жило меньше
 *    секунды: ошибка была, а на экране её не было. Теперь у отсчёта свой
 *    элемент, у состояния свой, а внизу постоянная строка о том, что с
 *    опросом, — единственный способ понять, что происходит на телевизоре,
 *    к которому нет ни adb, ни консоли.
 */

/**
 * Разметка целиком статична: `next`, код и состояние страница берёт сама —
 * из адреса и из API. Подставлять сюда что-либо со стороны сервера незачем,
 * а значит и подставить чужое через эту страницу нельзя.
 */
export const PAIR_PAGE_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>Подключение устройства — Andreytracker</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    --bg: #04070d;
    --ink: #dff3ff;
    --dim: #6d8ba5;
    --cyan: #3fe0ff;
    --magenta: #ff5ec7;
    --ok: #57f5a8;
    --line: rgba(63, 224, 255, 0.22);
  }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    overflow: hidden;
  }
  /* Мягкое свечение вместо картинки: фон на телевизоре висит сутками. */
  body::before {
    content: "";
    position: fixed;
    inset: -30%;
    background:
      radial-gradient(45% 45% at 30% 25%, rgba(63, 224, 255, 0.13), transparent 70%),
      radial-gradient(40% 40% at 72% 78%, rgba(255, 94, 199, 0.10), transparent 70%);
    pointer-events: none;
  }
  .card {
    position: relative;
    width: min(1100px, 100%);
    text-align: center;
  }
  .brand {
    font-size: clamp(11px, 1.5vmin, 18px);
    letter-spacing: 0.42em;
    color: var(--cyan);
    text-transform: uppercase;
    margin-bottom: clamp(14px, 3vmin, 34px);
  }
  h1 {
    font-size: clamp(19px, 3.4vmin, 44px);
    font-weight: 600;
    margin: 0 0 clamp(6px, 1.4vmin, 16px);
    letter-spacing: 0.01em;
  }
  .lead {
    font-size: clamp(14px, 2vmin, 26px);
    color: var(--dim);
    margin: 0 auto clamp(20px, 4vmin, 44px);
    max-width: 30em;
    line-height: 1.5;
  }
  .code {
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: clamp(44px, 15vmin, 190px);
    font-weight: 700;
    letter-spacing: clamp(2px, 1.1vmin, 14px);
    line-height: 1.05;
    color: var(--cyan);
    /* Свечение умеренное: читаемость важнее эффекта. */
    text-shadow: 0 0 clamp(10px, 2.4vmin, 34px) rgba(63, 224, 255, 0.45);
    margin: 0;
    /* Тире не должно уезжать на другую строку от кода. */
    white-space: nowrap;
    word-break: keep-all;
  }
  .code[data-state="wait"] { color: var(--dim); text-shadow: none; opacity: 0.55; }
  /* Код, доживший до своего срока, обязан выглядеть мёртвым, а не бодрым. */
  .code[data-state="dead"] { color: var(--dim); text-shadow: none; opacity: 0.35; }
  .bar {
    margin: clamp(16px, 2.6vmin, 30px) auto 0;
    width: min(520px, 70%);
    height: 3px;
    border-radius: 3px;
    background: rgba(63, 224, 255, 0.14);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    width: 100%;
    background: linear-gradient(90deg, var(--cyan), var(--magenta));
    transform-origin: left center;
    transition: transform 1s linear;
  }
  /*
   * Часы и состояние — РАЗНЫЕ строки, и это не вёрстка ради красоты.
   * Пока они делили один элемент, отсчёт раз в секунду затирал сообщение об
   * ошибке: «Нет связи с сервером» появлялось и пропадало быстрее, чем
   * человек успевал прочитать. На телевизоре без консоли это означало, что
   * сбой не виден вовсе.
   */
  .clock {
    margin: clamp(14px, 2.6vmin, 30px) 0 0;
    font-size: clamp(13px, 1.8vmin, 23px);
    color: var(--dim);
    min-height: 1.6em;
  }
  .clock b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
  .note {
    margin: clamp(4px, 0.8vmin, 10px) 0 0;
    font-size: clamp(14px, 1.9vmin, 25px);
    color: var(--ink);
    min-height: 1.6em;
  }
  .note[data-bad="1"] { color: var(--magenta); }
  .steps {
    margin: clamp(20px, 3.6vmin, 44px) auto 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: clamp(10px, 2vmin, 26px);
    max-width: 46em;
    font-size: clamp(12px, 1.6vmin, 21px);
    color: var(--dim);
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 0.6em;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.5em 1.1em;
    background: rgba(63, 224, 255, 0.04);
  }
  .steps i {
    font-style: normal;
    color: var(--cyan);
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }
  /* Запасная дорога для пульта: показывается только там, где есть пульт. */
  .remote {
    display: none;
    margin: clamp(14px, 2.4vmin, 28px) auto 0;
    max-width: 40em;
    font-size: clamp(12px, 1.7vmin, 22px);
    line-height: 1.5;
    color: var(--dim);
  }
  .remote[data-show="1"] { display: block; }
  .remote b { color: var(--cyan); font-weight: 600; }
  /*
   * Строка диагностики. Живёт постоянно и тихо: у телевизора нет ни консоли,
   * ни adb, и это единственный способ узнать, доходит ли опрос до сервера.
   */
  .diag {
    position: fixed;
    left: 0;
    right: 0;
    bottom: clamp(10px, 2.4vmin, 30px);
    padding: 0 clamp(16px, 4vmin, 60px);
    text-align: center;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: clamp(10px, 1.35vmin, 17px);
    line-height: 1.5;
    color: var(--dim);
    opacity: 0.7;
    pointer-events: none;
    word-break: break-word;
  }
  .diag div { min-height: 1.4em; }
  .diag .bad { color: var(--magenta); opacity: 1; }
  .done .code { color: var(--ok); text-shadow: 0 0 40px rgba(87, 245, 168, 0.5); }
  .fail .code { color: var(--magenta); text-shadow: none; }
  /* Экран висит сутками — никаких бесконечных анимаций, кроме одной тихой. */
  @media (prefers-reduced-motion: no-preference) {
    .pulse { animation: pulse 3.4s ease-in-out infinite; }
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.86; } }
</style>
</head>
<body>
<main class="card" id="card">
  <div class="brand">Andreytracker</div>
  <h1 id="title">Подключение устройства</h1>
  <p class="lead" id="lead">Назовите этот код тому, кто одобряет устройства, — или одобрите сами в дневнике на телефоне.</p>
  <p class="code pulse" id="code" data-state="wait">· · · ·</p>
  <div class="bar" aria-hidden="true"><i id="bar"></i></div>
  <p class="clock" id="clock"></p>
  <p class="note" id="note">Запрашиваю код…</p>
  <ul class="steps" id="steps">
    <li><i>1</i> Откройте дневник на телефоне</li>
    <li><i>2</i> Настройки → «Одобрить и отозвать»</li>
    <li><i>3</i> Наберите этот код — он подтверждает, что вы видите экран</li>
  </ul>
  <p class="remote" id="remote">Одобрили на телефоне, а этот экран не сменился? Нажмите на пульте
    <b>MENU</b> — или подержите <b>«Назад»</b>. Телевизор проверит сам, и код при этом не поменяется.</p>
</main>
<div class="diag" id="diag" aria-hidden="true">
  <div id="diag-main"></div>
  <div id="diag-last"></div>
</div>
<script>
(function () {
  "use strict";

  var card = document.getElementById("card");
  var codeEl = document.getElementById("code");
  var clockEl = document.getElementById("clock");
  var noteEl = document.getElementById("note");
  var titleEl = document.getElementById("title");
  var leadEl = document.getElementById("lead");
  var stepsEl = document.getElementById("steps");
  var remoteEl = document.getElementById("remote");
  var barEl = document.getElementById("bar");
  var diagMainEl = document.getElementById("diag-main");
  var diagLastEl = document.getElementById("diag-last");

  // Куда вернуться после одобрения. Значение приходит из адреса, поэтому
  // доверять ему нельзя: принимаем только два известных пути, иначе «/».
  var params = new URLSearchParams(location.search);
  var rawNext = params.get("next") || "/";
  var next = rawNext === "/dash" || rawNext.indexOf("/dash/") === 0 ? "/dash" : "/";

  // Телевизор или телефон — только подпись в списке одобрения и решение,
  // показывать ли подсказку про пульт. Проверкой это не является.
  function guessKind() {
    if (next === "/dash") return "phone";
    var ua = navigator.userAgent || "";
    if (/android\\s*tv|googletv|smarttv|smart-tv|bravia|aft[a-z]|web0s|webos|tizen|hbbtv|crkey|chromecast/i.test(ua)) return "tv";
    if (/mobile|iphone|ipod|android/i.test(ua)) return "phone";
    return "browser";
  }

  var kind = guessKind();
  if (kind === "tv") remoteEl.setAttribute("data-show", "1");

  var BEAT_MS = 1000;
  var BASE_INTERVAL_SEC = 5;        // RFC 8628 §3.2: умолчание, если сервер молчит
  var MAX_INTERVAL_SEC = 60;
  var REQUEST_TIMEOUT_MS = 20000;   // ответа нет так долго — считаем попытку пропавшей
  var CODE_RETRY_MS = 10000;
  var CODE_BUSY_MS = 60000;         // после 429
  var EXPIRED_RETRY_MS = 2000;
  var FAILS_BEFORE_XHR = 2;         // столько подряд — и переходим на запасной транспорт
  var STORE_KEY = "bt_pair_v1";

  var st = {
    deviceCode: null,
    display: null,
    expiresAt: 0,
    ttlMs: 0,
    intervalSec: BASE_INTERVAL_SEC,
    nextPollAt: 0,
    nextCodeAt: 0,
    lastPollAt: 0,
    busySince: 0,
    busyWhat: "",
    seq: 0,
    abort: null,
    stopped: false,
    redirectTo: null,
    redirectAt: 0,
    transport: "fetch",
    store: "нет",
    loads: 1,
    codeAt: 0,
    polls: 0,
    answers: 0,
    fails: 0,
    failStreak: 0,
    jsErrors: 0,
    lastLine: "",
    lastAt: 0,
    lastBad: false,
    lastBeatAt: 0,
    beatFixAt: 0
  };

  /* ---------------------------------------------------------------- */
  /* Экран                                                             */
  /* ---------------------------------------------------------------- */

  /*
   * textContent, а не innerHTML. Сегодня сюда приходят только литералы, но это
   * единственный сток разметки на странице входа: попади в него однажды строка
   * с сервера или текст ошибки — получился бы XSS ровно там, где человек вводит
   * код. Единственное место, где нужна была жирность, вынесено в свой элемент.
   */
  function say(text, bad) {
    noteEl.textContent = text;
    if (bad) noteEl.setAttribute("data-bad", "1");
    else noteEl.removeAttribute("data-bad");
  }

  function two(n) { return (n < 10 ? "0" : "") + n; }

  function hms(ms) {
    var d = new Date(ms);
    return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
  }

  function mmss(msLeft) {
    var s = Math.max(0, Math.round(msLeft / 1000));
    return Math.floor(s / 60) + ":" + two(s % 60);
  }

  function showCode(display) {
    st.display = display;
    codeEl.textContent = display;
    codeEl.removeAttribute("data-state");
  }

  /** Код отжил своё: цифры гасим, чтобы никто не набирал мёртвое. */
  function dropCode(reason) {
    st.deviceCode = null;
    st.display = null;
    st.expiresAt = 0;
    st.ttlMs = 0;
    st.lastPollAt = 0;
    st.intervalSec = BASE_INTERVAL_SEC;
    forget();
    codeEl.setAttribute("data-state", "wait");
    codeEl.textContent = "· · · ·";
    barEl.style.transform = "scaleX(0)";
    clockEl.textContent = "";
    if (reason) say(reason);
  }

  function drawClock(now) {
    if (st.stopped) return;
    if (!st.deviceCode) { clockEl.textContent = ""; return; }
    var left = st.expiresAt - now;
    barEl.style.transform = "scaleX(" + Math.max(0, Math.min(1, st.ttlMs ? left / st.ttlMs : 0)) + ")";
    if (left <= 0) {
      /*
       * Раньше отсчёт при нуле просто переставал обновляться, и на экране
       * навсегда застывало «ещё 0:01» у давно мёртвого кода. Теперь истёкший
       * код так и выглядит.
       */
      clockEl.textContent = "Срок кода истёк";
      codeEl.setAttribute("data-state", "dead");
      return;
    }
    clockEl.textContent = "Код действителен ещё ";
    var b = document.createElement("b");
    b.textContent = mmss(left);
    clockEl.appendChild(b);
  }

  function mark(line, bad) {
    st.lastLine = line;
    st.lastAt = Date.now();
    st.lastBad = !!bad;
  }

  function renderDiag() {
    var main = "загрузка " + st.loads;
    if (st.codeAt) main += " · код " + hms(st.codeAt);
    main += " · опросов " + st.polls + " · ответов " + st.answers;
    if (st.fails) main += " · сбоев " + st.fails;
    if (st.jsErrors) main += " · ошибок JS " + st.jsErrors;
    main += " · " + st.transport + " · память " + st.store;
    diagMainEl.textContent = main;
    diagLastEl.textContent = st.lastAt ? hms(st.lastAt) + " · " + st.lastLine : "";
    diagLastEl.className = st.lastBad ? "bad" : "";
  }

  function describe(e) {
    if (!e) return "неизвестная ошибка";
    if (typeof e === "string") return e;
    var name = e.name || "Error";
    var msg = e.message || String(e);
    return (name + ": " + msg).slice(0, 120);
  }

  function fault(where, e) {
    st.jsErrors += 1;
    mark(where + " — " + describe(e), true);
    renderDiag();
  }

  /* ---------------------------------------------------------------- */
  /* Память между перезагрузками                                       */
  /* ---------------------------------------------------------------- */

  /*
   * Зачем вообще: на боевом телевизоре опрос не доходил до сервера ни разу, а
   * перезагрузка страницы (MENU на пульте) — доходила всегда. Значит
   * перезагрузка обязана заменять опрос. Для этого код должен её пережить,
   * иначе каждое нажатие давало бы новый код, и человек, набравший прежний,
   * промахивался бы снова и снова — ровно то, на что жаловался заказчик.
   *
   * Хранилище выбирается проверкой, а не верой: сначала пробуем localStorage,
   * и только если запись не читается обратно — куку. Что получилось, видно на
   * экране в строке диагностики.
   */
  var store = (function () {
    try {
      var probe = STORE_KEY + "_t";
      localStorage.setItem(probe, "1");
      var ok = localStorage.getItem(probe) === "1";
      localStorage.removeItem(probe);
      if (ok) {
        return {
          name: "local",
          get: function () { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } },
          set: function (v) { try { localStorage.setItem(STORE_KEY, v); } catch (e) {} },
          del: function () { try { localStorage.removeItem(STORE_KEY); } catch (e) {} }
        };
      }
    } catch (e) { /* режим без DOM storage — идём к куке */ }

    try {
      // Кука живёт на своём пути: к API она не ходит и лишним заголовком не
      // висит. Секрет тот же, что и в памяти страницы, дольше срока кода не
      // хранится и стирается сразу после обмена на сессию.
      var read = function () {
        var all = document.cookie ? document.cookie.split("; ") : [];
        for (var i = 0; i < all.length; i += 1) {
          if (all[i].indexOf(STORE_KEY + "=") === 0) {
            return decodeURIComponent(all[i].slice(STORE_KEY.length + 1));
          }
        }
        return null;
      };
      document.cookie = STORE_KEY + "_t=1; path=/pair; max-age=60; samesite=Lax";
      if (document.cookie.indexOf(STORE_KEY + "_t=1") >= 0) {
        document.cookie = STORE_KEY + "_t=; path=/pair; max-age=0";
        return {
          name: "кука",
          get: read,
          set: function (v) {
            document.cookie = STORE_KEY + "=" + encodeURIComponent(v) + "; path=/pair; max-age=900; samesite=Lax";
          },
          del: function () { document.cookie = STORE_KEY + "=; path=/pair; max-age=0; samesite=Lax"; }
        };
      }
    } catch (e) { /* ни того, ни другого */ }

    // Совсем без памяти страница тоже работает — просто теряет запасную дорогу.
    return { name: "нет", get: function () { return null; }, set: function () {}, del: function () {} };
  })();

  st.store = store.name;

  function remember() {
    if (!st.deviceCode) return;
    try {
      store.set(JSON.stringify({
        c: st.deviceCode,
        d: st.display,
        e: st.expiresAt,
        t: st.ttlMs,
        i: st.intervalSec,
        p: st.lastPollAt,
        n: next,
        l: st.loads
      }));
    } catch (e) { fault("запись памяти", e); }
  }

  function forget() {
    try { store.del(); } catch (e) {}
  }

  /** Достать код, переживший перезагрузку. Мёртвый — не возвращаем. */
  function recall() {
    var raw = null;
    try { raw = store.get(); } catch (e) { return null; }
    if (!raw) return null;
    var saved = null;
    try { saved = JSON.parse(raw); } catch (e) { forget(); return null; }
    if (!saved || typeof saved.c !== "string" || !saved.e) { forget(); return null; }
    // Чужой «next» — чужая заявка: сессия ушла бы не туда, куда шли.
    if (saved.n !== next) { forget(); return null; }
    if (saved.e - Date.now() <= 1000) { forget(); return null; }
    return saved;
  }

  /* ---------------------------------------------------------------- */
  /* Транспорт                                                         */
  /* ---------------------------------------------------------------- */

  /*
   * Два транспорта, потому что причина отказа на телевизоре не установлена.
   * Если fetch там почему-то не доносит POST — после двух сбоев подряд
   * страница переходит на XMLHttpRequest и продолжает тем же циклом. Какой
   * транспорт в деле, видно на экране.
   */
  function sendFetch(path, body, finish) {
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
    st.abort = ctrl;
    var opts = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body || {}),
      cache: "no-store",
      credentials: "same-origin"
    };
    if (ctrl) opts.signal = ctrl.signal;
    var p;
    try {
      p = fetch(path, opts);
    } catch (e) {
      // fetch умеет бросить и синхронно. Без этого перехвата один такой бросок
      // обрывал бы весь опрос навсегда — и молча.
      finish({ err: describe(e) });
      return;
    }
    p.then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        finish({ status: res.status, data: data });
      });
    }).catch(function (e) { finish({ err: describe(e) }); });
  }

  function sendXhr(path, body, finish) {
    var xhr;
    try { xhr = new XMLHttpRequest(); } catch (e) { finish({ err: describe(e) }); return; }
    st.abort = { abort: function () { try { xhr.abort(); } catch (e) {} } };
    try {
      xhr.open("POST", path, true);
      xhr.setRequestHeader("content-type", "application/json");
      xhr.setRequestHeader("accept", "application/json");
      xhr.onload = function () {
        var data = {};
        try { data = JSON.parse(xhr.responseText || "{}"); } catch (e) { data = {}; }
        finish({ status: xhr.status, data: data });
      };
      xhr.onerror = function () { finish({ err: "XHR: запрос не ушёл" }); };
      xhr.onabort = function () { finish({ err: "XHR: прерван" }); };
      xhr.ontimeout = function () { finish({ err: "XHR: нет ответа" }); };
      xhr.timeout = REQUEST_TIMEOUT_MS;
      xhr.send(JSON.stringify(body || {}));
    } catch (e) {
      finish({ err: describe(e) });
    }
  }

  /**
   * Один запрос. Колбэк зовётся ровно один раз и никогда не «бросает наружу»:
   * цикл опроса не должен уметь умереть от одной неудачной попытки.
   */
  function request(what, path, body, done) {
    var mine = ++st.seq;
    var finished = false;
    st.busySince = Date.now();
    st.busyWhat = what;

    var finish = function (res) {
      if (finished) return;
      finished = true;
      // Попытку уже списали по таймауту — её ответ не должен ничего менять.
      if (mine !== st.seq) return;
      st.abort = null;
      st.busySince = 0;
      st.busyWhat = "";
      try { done(res); } catch (e) { fault("разбор ответа", e); }
      // Итог попытки обязан попасть на экран даже тогда, когда следующего
      // такта уже не будет (например, после успеха пульс останавливается).
      renderDiag();
      // Ответ есть — решать, что дальше, можно прямо сейчас, без таймеров.
      pump();
    };

    if (st.transport === "xhr") sendXhr(path, body, finish);
    else sendFetch(path, body, finish);
  }

  function dropBusy() {
    st.seq += 1;             // всё, что придёт по старой попытке, уже не наше
    var a = st.abort;
    st.abort = null;
    st.busySince = 0;
    st.busyWhat = "";
    if (a) { try { a.abort(); } catch (e) {} }
  }

  function maybeSwitchTransport() {
    if (st.transport === "fetch" && st.failStreak >= FAILS_BEFORE_XHR) {
      st.transport = "xhr";
      mark("перехожу на запасной транспорт XHR", true);
      /*
       * Смена транспорта — это новая попытка, а не продолжение прежней, и
       * копить откат за чужие грехи ей незачем: запросы, которые не ушли,
       * сервер не считал, и спешкой мы его не обидим. Иначе первый запрос по
       * новому пути ждал бы минуту непонятно чего.
       */
      st.failStreak = 0;
      st.intervalSec = BASE_INTERVAL_SEC;
      st.nextPollAt = 0;
      st.nextCodeAt = 0;
    }
  }

  function clampInterval(raw, fallback) {
    var v = Number(raw);
    if (!isFinite(v) || v <= 0) v = fallback || BASE_INTERVAL_SEC;
    return Math.max(BASE_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.round(v)));
  }

  /* ---------------------------------------------------------------- */
  /* Шаги потока                                                       */
  /* ---------------------------------------------------------------- */

  function requestCode() {
    var started = Date.now();
    st.nextCodeAt = started + CODE_RETRY_MS;   // если ответа не будет — повторим сами
    say("Запрашиваю код…");
    request("код", "/api/device/code", { kind: kind, next: next }, function (r) {
      var now = Date.now();
      if (r.err) {
        st.fails += 1;
        st.failStreak += 1;
        mark("код не получен — " + r.err, true);
        say("Нет связи с сервером. Пробую снова…", true);
        st.nextCodeAt = now + CODE_RETRY_MS;
        maybeSwitchTransport();
        return;
      }
      st.failStreak = 0;
      if (r.status === 429) {
        mark("сервер просит подождать (429)", true);
        say("Сервер попросил подождать. Повторю через минуту.");
        st.nextCodeAt = now + CODE_BUSY_MS;
        return;
      }
      if (r.status !== 200 || !r.data || !r.data.device_code) {
        mark("код не выдан, ответ " + r.status, true);
        say("Сервер не выдал код. Повторю через 10 секунд.", true);
        st.nextCodeAt = now + CODE_RETRY_MS;
        return;
      }
      st.deviceCode = r.data.device_code;
      st.intervalSec = clampInterval(r.data.interval, BASE_INTERVAL_SEC);
      var ttlSec = Number(r.data.expires_in);
      st.ttlMs = (isFinite(ttlSec) && ttlSec > 0 ? ttlSec : 600) * 1000;
      st.expiresAt = now + st.ttlMs;
      st.codeAt = now;
      st.lastPollAt = 0;
      showCode(r.data.user_code_display || r.data.user_code);
      say("Жду одобрения.");
      mark("код получен");
      remember();
      // Первый опрос — немедленно, той же цепочкой промисов. Она на телевизоре
      // доказанно работает, в отличие от отложенного вызова.
      st.nextPollAt = 0;
    });
  }

  function poll() {
    var started = Date.now();
    st.polls += 1;
    st.lastPollAt = started;
    // Интервал держим сами и сразу: иначе три события подряд («вернулись к
    // экрану», «появилась сеть», «тик») дали бы три опроса и заслуженный
    // slow_down от сервера.
    st.nextPollAt = started + st.intervalSec * 1000;
    remember();
    request("опрос", "/api/device/token", { device_code: st.deviceCode }, function (r) {
      var now = Date.now();

      if (r.err) {
        st.fails += 1;
        st.failStreak += 1;
        mark("опрос не дошёл — " + r.err, true);
        say("Нет связи с сервером. Пробую снова…", true);
        // Обрыв связи: RFC советует экспоненциальный откат, и он же спасает
        // сервер, когда телевизор проснулся раньше Wi-Fi.
        st.intervalSec = Math.min(MAX_INTERVAL_SEC, st.intervalSec * 2);
        st.nextPollAt = now + st.intervalSec * 1000;
        // Последним: смена транспорта отменяет откат — см. ниже.
        maybeSwitchTransport();
        return;
      }

      st.answers += 1;
      st.failStreak = 0;

      if (r.status === 200 && r.data && r.data.ok) {
        forget();
        st.stopped = true;
        card.className = "card done";
        codeEl.classList.remove("pulse");
        titleEl.textContent = "Устройство подключено";
        leadEl.textContent = "Открываю дневник.";
        stepsEl.style.display = "none";
        clockEl.textContent = "";
        barEl.style.transform = "scaleX(0)";
        say("Готово");
        mark("сессия получена");
        /*
         * Переход исполняет пульс — иначе на устройстве с мёртвым setTimeout
         * сопряжение завершалось бы успешно и никуда не вело. Таймер тут же
         * оставлен вторым исполнителем: где он жив, переход просто быстрее.
         * А если вдруг не сработает ни то, ни другое — сессия уже получена,
         * и подсказка про пульт остаётся на экране: одно нажатие, и оболочка
         * откроет дневник сама.
         */
        st.redirectTo = r.data.redirect || next;
        st.redirectAt = now + 900;
        if (kind === "tv") {
          remoteEl.textContent = "Экран не сменился? Нажмите на пульте MENU — дневник уже открыт для этого телевизора.";
        }
        try { setTimeout(pump, 900); } catch (e) {}
        return;
      }

      var err = (r.data && r.data.error) || "authorization_pending";
      mark("ответ сервера: " + err);

      if (err === "slow_down") {
        // RFC 8628 §3.5: прибавка к интервалу постоянная, а не разовая.
        st.intervalSec = clampInterval(r.data && r.data.interval, st.intervalSec + 5);
        st.nextPollAt = now + st.intervalSec * 1000;
        say("Жду одобрения.");
        remember();
        return;
      }

      if (err === "authorization_pending") {
        say("Жду одобрения.");
        return;
      }

      if (err === "access_denied") {
        forget();
        st.stopped = true;
        card.className = "card fail";
        codeEl.classList.remove("pulse");
        titleEl.textContent = "Устройство отклонено";
        leadEl.textContent = "Код отклонён на стороне сервера.";
        stepsEl.style.display = "none";
        remoteEl.removeAttribute("data-show");
        clockEl.textContent = "";
        barEl.style.transform = "scaleX(0)";
        say("Перезапустите приложение, если это ошибка", true);
        mark("заявка отклонена", true);
        return;
      }

      /*
       * expired_token и всё прочее: код отжил своё.
       *
       * RFC советует дождаться действия человека, прежде чем начинать заново.
       * Здесь это правило намеренно нарушено: телевизор висит на стене, нажать
       * на нём некому, и «дождаться человека» означало бы вечный экран с
       * кодом, который уже не сработает. Берём новый — раз в десять минут,
       * что укладывается в ограничитель с большим запасом.
       */
      dropCode("Код устарел. Беру новый…");
      st.nextCodeAt = now + EXPIRED_RETRY_MS;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Пульс: одно решение, много источников                             */
  /* ---------------------------------------------------------------- */

  /**
   * Всё, что делает страница, решается здесь и только по часам. Сколько раз
   * сработал таймер и сработал ли вообще — неважно: важно, который час.
   */
  function beat() {
    var now = Date.now();
    st.lastBeatAt = now;

    if (st.redirectAt && now >= st.redirectAt) {
      var to = st.redirectTo || next;
      st.redirectAt = 0;
      location.replace(to);
      return;
    }
    if (st.stopped) return;

    drawClock(now);

    // Запрос без ответа дольше всякого приличия: списываем и пробуем заново.
    // Без этого один зависший запрос останавливал бы сопряжение навсегда.
    if (st.busySince && now - st.busySince > REQUEST_TIMEOUT_MS) {
      var what = st.busyWhat;
      dropBusy();
      st.fails += 1;
      st.failStreak += 1;
      maybeSwitchTransport();
      mark(what + ": ответа нет " + Math.round(REQUEST_TIMEOUT_MS / 1000) + " с — пробую снова", true);
      say("Сервер не отвечает. Пробую снова…", true);
    }

    if (st.busySince) { renderDiag(); return; }

    var alive = st.deviceCode && st.expiresAt > now;
    if (!alive) {
      if (st.deviceCode) dropCode("Код устарел. Беру новый…");
      if (now >= st.nextCodeAt) requestCode();
    } else if (now >= st.nextPollAt) {
      poll();
    }

    renderDiag();
  }

  /** Ни одна беда внутри такта не должна останавливать пульс. */
  function pump() {
    try { beat(); } catch (e) { fault("такт", e); }
  }

  var beatTimer = null;
  function startBeat() {
    try { if (beatTimer) clearInterval(beatTimer); } catch (e) {}
    beatTimer = null;
    try { beatTimer = setInterval(pump, BEAT_MS); } catch (e) { fault("setInterval", e); }
  }

  /*
   * Запасной пульс №1 — кадры отрисовки. Их выдаёт компоновщик, а не очередь
   * таймеров, так что страница продолжает жить даже там, где с таймерами
   * что-то не так. Пока экран виден — виден и толк.
   */
  function frame() {
    try {
      var now = Date.now();
      if (now - st.lastBeatAt >= BEAT_MS) {
        // Секундный тик давно не приходил — похоже, интервал потерян.
        // Заводим заново, но не чаще раза в десять секунд.
        if (now - st.lastBeatAt >= BEAT_MS * 3 && now - st.beatFixAt > 10000) {
          st.beatFixAt = now;
          startBeat();
        }
        pump();
      }
    } catch (e) { /* кадр не должен уметь всё сломать */ }
    try { requestAnimationFrame(frame); } catch (e) {}
  }

  /*
   * Запасной пульс №2 — событие CSS-анимации. Приходит от движка анимаций и
   * не зависит ни от таймеров, ни от нашего цикла кадров. Анимация на странице
   * и так есть: код тихо пульсирует.
   */
  try {
    codeEl.addEventListener("animationiteration", function () { pump(); });
  } catch (e) { /* без анимаций — просто одним источником меньше */ }

  /**
   * Вернулись к экрану, в сеть или из фона: ждать ещё и таймера незачем.
   * Если до этого были сбои связи, раздутый интервал сбрасываем — опросы,
   * которые не дошли, сервер не считал, и slow_down за спешку не будет.
   */
  function wake() {
    if (st.failStreak > 0) {
      st.intervalSec = BASE_INTERVAL_SEC;
      st.nextPollAt = 0;
      st.nextCodeAt = 0;
    }
    startBeat();
    pump();
  }

  try {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") wake();
    });
    document.addEventListener("resume", wake);       // Page Lifecycle: разморозка
    window.addEventListener("pageshow", wake);       // возврат из кеша навигации
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
  } catch (e) { /* события — тоже лишь один из источников */ }

  // Ошибки, которых никто не ждал, обязаны оказаться на экране: на телевизоре
  // это единственное место, где их вообще можно увидеть.
  try {
    window.addEventListener("error", function (e) {
      fault("ошибка JS", (e && e.message) || "неизвестно");
    });
    window.addEventListener("unhandledrejection", function (e) {
      fault("необработанный промис", describe(e && e.reason));
    });
  } catch (e) {}

  /* ---------------------------------------------------------------- */
  /* Старт                                                             */
  /* ---------------------------------------------------------------- */

  var saved = recall();
  if (saved) {
    /*
     * Код пережил перезагрузку — показываем ТОТ ЖЕ код и первым делом
     * спрашиваем сервер, не одобрен ли он. Это и есть запасная дорога:
     * человек одобрил с телефона, нажал MENU на пульте — и телевизор вошёл,
     * не потребовав набрать новый код.
     */
    st.deviceCode = saved.c;
    st.expiresAt = saved.e;
    st.ttlMs = saved.t || (saved.e - Date.now());
    st.intervalSec = clampInterval(saved.i, BASE_INTERVAL_SEC);
    st.lastPollAt = saved.p || 0;
    st.codeAt = saved.e - st.ttlMs;
    st.loads = (saved.l || 1) + 1;
    if (saved.d) showCode(saved.d);
    say("Проверяю, одобрен ли код…");
    mark("код взят из памяти, загрузка " + st.loads);
    // Уважаем интервал сервера: опрос раньше срока он не рассматривает вовсе,
    // а отвечает slow_down — то есть впустую потратил бы нажатие на пульте.
    st.nextPollAt = st.lastPollAt ? st.lastPollAt + st.intervalSec * 1000 : 0;
    remember();
  } else {
    mark("новый код");
  }

  renderDiag();
  startBeat();
  try { requestAnimationFrame(frame); } catch (e) {}
  pump();
})();
</script>
</body>
</html>
`;
