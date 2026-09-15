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
  .meta {
    margin-top: clamp(18px, 3.5vmin, 40px);
    font-size: clamp(13px, 1.8vmin, 23px);
    color: var(--dim);
    min-height: 1.6em;
  }
  .meta b { color: var(--ink); font-weight: 600; }
  .steps {
    margin: clamp(22px, 4vmin, 48px) auto 0;
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
  <p class="meta" id="meta">Запрашиваю код…</p>
  <ul class="steps" id="steps">
    <li><i>1</i> Откройте дневник на телефоне</li>
    <li><i>2</i> Настройки → Устройства</li>
    <li><i>3</i> Сверьте код и нажмите «Одобрить»</li>
  </ul>
</main>
<script>
(function () {
  "use strict";

  var card = document.getElementById("card");
  var codeEl = document.getElementById("code");
  var metaEl = document.getElementById("meta");
  var titleEl = document.getElementById("title");
  var leadEl = document.getElementById("lead");
  var stepsEl = document.getElementById("steps");
  var barEl = document.getElementById("bar");

  // Куда вернуться после одобрения. Значение приходит из адреса, поэтому
  // доверять ему нельзя: принимаем только два известных пути, иначе «/».
  var params = new URLSearchParams(location.search);
  var rawNext = params.get("next") || "/";
  var next = rawNext === "/dash" || rawNext.indexOf("/dash/") === 0 ? "/dash" : "/";

  // Телевизор или телефон — только подпись в списке одобрения, не проверка.
  function guessKind() {
    if (next === "/dash") return "phone";
    var ua = navigator.userAgent || "";
    if (/android\\s*tv|googletv|smarttv|smart-tv|bravia|aft[a-z]|web0s|webos|tizen|hbbtv|crkey/i.test(ua)) return "tv";
    if (/mobile|iphone|ipod|android/i.test(ua)) return "phone";
    return "browser";
  }

  var deviceCode = null;
  var intervalSec = 5;          // RFC 8628 §3.2: умолчание, если сервер молчит
  var expiresAtMs = 0;
  var ttlMs = 0;
  var stopped = false;
  var pollTimer = null;
  var tickTimer = null;

  function say(text) { metaEl.innerHTML = text; }

  function showCode(display) {
    codeEl.textContent = display;
    codeEl.removeAttribute("data-state");
  }

  function mmss(msLeft) {
    var s = Math.max(0, Math.round(msLeft / 1000));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  function tick() {
    if (stopped || !expiresAtMs) return;
    var left = expiresAtMs - Date.now();
    barEl.style.transform = "scaleX(" + Math.max(0, Math.min(1, ttlMs ? left / ttlMs : 0)) + ")";
    if (left > 0) say("Код действителен ещё <b>" + mmss(left) + "</b>");
  }

  function finish(kind, title, lead, text) {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    card.className = "card " + kind;
    codeEl.classList.remove("pulse");
    titleEl.textContent = title;
    leadEl.textContent = lead;
    stepsEl.style.display = "none";
    barEl.style.transform = "scaleX(0)";
    say(text);
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body || {}),
      cache: "no-store",
      credentials: "same-origin"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }

  function requestCode() {
    post("/api/device/code", { kind: guessKind(), next: next }).then(function (r) {
      if (r.status === 429) {
        // Ограничитель. Ждём и пробуем снова — на стене телевизора некому
        // нажать «повторить».
        say("Сервер попросил подождать. Повторю через минуту.");
        setTimeout(requestCode, 60000);
        return;
      }
      if (r.status !== 200 || !r.data || !r.data.device_code) {
        say("Сервер не выдал код. Повторю через 10 секунд.");
        setTimeout(requestCode, 10000);
        return;
      }
      deviceCode = r.data.device_code;
      intervalSec = r.data.interval || 5;
      ttlMs = (r.data.expires_in || 600) * 1000;
      expiresAtMs = Date.now() + ttlMs;
      showCode(r.data.user_code_display || r.data.user_code);
      tick();
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(tick, 1000);
      schedulePoll();
    }).catch(function () {
      say("Нет связи с сервером. Повторю через 10 секунд.");
      setTimeout(requestCode, 10000);
    });
  }

  function schedulePoll() {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, intervalSec * 1000);
  }

  function poll() {
    if (stopped || !deviceCode) return;
    post("/api/device/token", { device_code: deviceCode }).then(function (r) {
      if (r.status === 200 && r.data && r.data.ok) {
        finish("done", "Устройство подключено", "Открываю дневник.", "Готово");
        setTimeout(function () { location.replace(r.data.redirect || next); }, 900);
        return;
      }
      var err = (r.data && r.data.error) || "authorization_pending";

      if (err === "slow_down") {
        // RFC 8628 §3.5: прибавка к интервалу постоянная, а не разовая.
        intervalSec = r.data.interval || intervalSec + 5;
        schedulePoll();
        return;
      }
      if (err === "authorization_pending") {
        schedulePoll();
        return;
      }
      if (err === "access_denied") {
        finish("fail", "Устройство отклонено", "Код отклонён на стороне сервера.",
               "Перезапустите приложение, если это ошибка");
        return;
      }
      // expired_token и всё прочее: код отжил своё.
      //
      // RFC советует дождаться действия человека, прежде чем начинать заново.
      // Здесь это правило намеренно нарушено: телевизор висит на стене, нажать
      // на нём некому, и «дождаться человека» означало бы вечный экран с
      // кодом, который уже не сработает. Берём новый — раз в десять минут,
      // что укладывается в ограничитель с большим запасом.
      deviceCode = null;
      expiresAtMs = 0;
      codeEl.setAttribute("data-state", "wait");
      codeEl.textContent = "· · · ·";
      say("Код истёк. Беру новый…");
      setTimeout(requestCode, 2000);
    }).catch(function () {
      // Обрыв связи: RFC рекомендует экспоненциальный откат, и он же спасает
      // сервер, когда телевизор проснулся раньше Wi-Fi.
      intervalSec = Math.min(60, intervalSec * 2);
      say("Нет связи с сервером. Пробую снова…");
      schedulePoll();
    });
  }

  requestCode();
})();
</script>
</body>
</html>
`;
