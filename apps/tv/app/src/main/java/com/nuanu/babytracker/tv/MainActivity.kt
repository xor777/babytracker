package com.nuanu.babytracker.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.annotation.RequiresApi
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Единственный экран приложения: полноэкранный WebView с дашбордом.
 *
 * Вся логика трекера живёт в вебе. Задача этого класса — открыть страницу,
 * не дать экрану погаснуть и пережить то, что телевизор включается раньше,
 * чем поднимается Wi-Fi, а System WebView обновляется через Play и убивает
 * renderer работающего приложения.
 */
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var overlay: LinearLayout
    private lateinit var overlayTitle: TextView
    private lateinit var overlayDetail: TextView
    private lateinit var overlayUrl: TextView
    private lateinit var overlayStatus: TextView
    private lateinit var overlayHint: TextView

    private lateinit var prefs: SharedPreferences
    private val handler = Handler(Looper.getMainLooper())

    /** Адрес, который грузим прямо сейчас. */
    private var targetUrl: String = ""

    /** Текущая загрузка уже провалилась — не показывать её результат. */
    private var failed = false

    /** Номер попытки: задаёт паузу перед следующим повтором. */
    private var attempt = 0

    /** В истории WebView остался наш служебный about:blank — вычистить после успеха. */
    private var historyDirty = false

    /** Сколько раз подряд отдавали учётные данные без единой удачной загрузки. */
    private var authAttempts = 0

    /** Когда отдавали в последний раз — чтобы отличить серию отказов от новых запросов. */
    private var lastAuthAt = 0L

    /** Страница дашборда сейчас показана пользователю. */
    private var contentShown = false

    /** Сервер не принял логин/пароль — отдельное состояние, не «нет связи». */
    private var authRejected = false

    /** Учётные данные в сборке есть, но отдавать их этому адресу нельзя. */
    private var authWithheld = false

    /** Момент (elapsedRealtime), когда надо повторить загрузку. */
    private var retryAt = 0L

    private var lastBackAt = 0L
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    // --- Отсчёт до следующей попытки; он же запускает повтор. ---------------
    private val countdown = object : Runnable {
        override fun run() {
            val left = retryAt - SystemClock.elapsedRealtime()
            if (left <= 0L) {
                load()
                return
            }
            overlayStatus.text = if (authRejected) {
                // Пароль неверен — долбить сервер незачем, но и сдаваться нельзя:
                // если пароль поправят на сервере, телевизор вернётся сам.
                getString(R.string.auth_retry_in, ((left + 59_999L) / 60_000L).toInt())
            } else {
                getString(R.string.retry_in, ((left + 999L) / 1000L).toInt(), attempt)
            }
            handler.postDelayed(this, 500L)
        }
    }

    // --- Страница висит слишком долго: считаем это отказом. -----------------
    private val loadTimeout = Runnable {
        fail(getString(R.string.err_timeout, (LOAD_TIMEOUT_MS / 1000L).toInt()))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        root = findViewById(R.id.root)
        web = findViewById(R.id.web)
        overlay = findViewById(R.id.overlay)
        overlayTitle = findViewById(R.id.overlayTitle)
        overlayDetail = findViewById(R.id.overlayDetail)
        overlayUrl = findViewById(R.id.overlayUrl)
        overlayStatus = findViewById(R.id.overlayStatus)
        overlayHint = findViewById(R.id.overlayHint)

        setUpWebView()
        enterImmersive()
        registerNetworkCallback()

        applyUrlFromIntent(intent)
        load()
    }

    // ------------------------------------------------------------------ URL

    /**
     * Куда приложению вообще разрешено ходить: хосты из BuildConfig (по умолчанию —
     * хост самого DASHBOARD_URL) плюс адреса локальной сети. Всё остальное отсекается
     * и при подмене адреса через adb, и при навигации внутри WebView.
     */
    private fun isAllowedUrl(url: String): Boolean {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return false
        val host = uri.host?.lowercase()?.trim().orEmpty()
        if (host.isEmpty()) return false
        // Открытый HTTP — только для локальной сети. Публичный домен по http
        // не открываем никогда: это ровно то, как выглядит downgrade-атака.
        if (scheme == "http" && !isLanHost(host)) return false
        val allowed = BuildConfig.DASHBOARD_URL_HOSTS
            .split(',')
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
        return host in allowed || isLanHost(host)
    }

    private fun isLanHost(host: String): Boolean = when {
        host == "localhost" || host.endsWith(".local") -> true
        host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("127.") -> true
        else -> PRIVATE_172.containsMatchIn(host)
    }

    /** Адрес из BuildConfig; может быть переопределён через adb (см. README). */
    private fun currentUrl(): String {
        val saved = prefs.getString(KEY_URL, null)?.trim()
        if (!saved.isNullOrEmpty()) {
            if (isAllowedUrl(saved)) return saved
            // Белый список мог сузиться новой сборкой — не тащим старое значение.
            Log.w(TAG, "сохранённый адрес вне белого списка, откат к сборочному: $saved")
            prefs.edit().remove(KEY_URL).apply()
        }
        return BuildConfig.DASHBOARD_URL
    }

    /**
     * `adb shell am start -n <pkg>/.MainActivity -e url http://192.168.1.42:8787/`
     * — сменить адрес на телевизоре, где нечем набрать текст, без пересборки APK.
     * `-e url reset` возвращает значение из сборки.
     *
     * Activity экспортирована (иначе её не запустит лаунчер TV), поэтому extra принимается
     * ТОЛЬКО от adb: у `am start` из шелла referrer равен android-app://com.android.shell.
     * Любое стороннее приложение на телевизоре получит отказ и в логи.
     */
    private fun applyUrlFromIntent(intent: Intent?): Boolean {
        val extra = intent?.getStringExtra(EXTRA_URL)?.trim() ?: return false

        // getReferrer() отдаёт EXTRA_REFERRER/EXTRA_REFERRER_NAME из самого интента,
        // а их подделает кто угодно. Вычищаем их — тогда остаётся только тот источник,
        // который проставляет система и приложение подменить не может.
        intent.removeExtra(Intent.EXTRA_REFERRER)
        intent.removeExtra(Intent.EXTRA_REFERRER_NAME)

        val from = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            referrer?.toString()
        } else {
            null // до API 22 вызывающего не установить — значит, не доверяем никому
        }
        if (from != SHELL_REFERRER) {
            Log.w(TAG, "подмена адреса отклонена, referrer=$from")
            return false
        }

        return when {
            extra.isEmpty() || extra.equals("reset", ignoreCase = true) -> {
                prefs.edit().remove(KEY_URL).apply()
                toast(getString(R.string.url_reset))
                true
            }
            isAllowedUrl(extra) -> {
                prefs.edit().putString(KEY_URL, extra).apply()
                toast(getString(R.string.url_changed, extra))
                true
            }
            else -> {
                Log.w(TAG, "адрес вне белого списка отклонён: $extra")
                toast(getString(R.string.url_rejected, extra))
                false
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (applyUrlFromIntent(intent)) {
            attempt = 0
            load()
        }
    }

    // -------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        web.setBackgroundColor(Color.BLACK)
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.overScrollMode = View.OVER_SCROLL_NEVER

        // Белая рамка по периметру телевизора — это focus ring Chromium из его
        // UA-таблицы: на D-pad устройстве сфокусированный элемент попадает под
        // :focus-visible, а на полноэкранной сцене обводка идёт по краю экрана.
        // В стилях дашборда такого правила нет и быть не может — рисует движок.
        // Дашборд неинтерактивен (CONTRACT §6), фокусировать в нём нечего, поэтому
        // клавиатурный фокус WebView не отдаём вовсе. Кнопки пульта от этого не
        // страдают: BACK/MENU/OK разбирает Activity, ей фокус View не нужен.
        web.isFocusable = false
        web.isFocusableInTouchMode = false
        // Заодно снимаем подсветку фокуса самого Android (API 26+) — здесь она не
        // проявилась, но на другой прошивке нарисует ровно такую же рамку.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.defaultFocusHighlightEnabled = false
            root.defaultFocusHighlightEnabled = false
            overlay.defaultFocusHighlightEnabled = false
        }

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            // Дашборд отдаётся по HTTPS: http-подресурсы на такой странице — это
            // возможность подсунуть свой JS в страницу с включённым JavaScript.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // Локальные файлы дашборду не нужны — закрываем.
            allowFileAccess = false
            allowContentAccess = false
            // Системный масштаб шрифта не должен ломать вёрстку 1920×1080.
            textZoom = 100
        }

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        web.webViewClient = object : WebViewClient() {

            override fun onPageFinished(view: WebView?, url: String?) {
                if (url == null) return
                if (url.startsWith(BLANK)) {
                    // Наш служебный about:blank уже отрисован — самое время выкинуть
                    // из истории и его, и упавшие навигации перед ним.
                    view?.clearHistory()
                    return
                }
                if (failed) return
                handler.removeCallbacks(loadTimeout)
                attempt = 0
                // Страница отдана — значит пару приняли; серия попыток закрыта.
                authAttempts = 0
                // Служебные about:blank не должны оставаться в истории: иначе BACK
                // уводит пользователя на пустую страницу вместо выхода.
                if (historyDirty) {
                    view?.clearHistory()
                    historyDirty = false
                }
                showContent()
            }

            // Киоск: наружу не уходим ни по ссылке, ни по редиректу.
            @RequiresApi(Build.VERSION_CODES.N)
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?,
            ): Boolean = blockForeignNavigation(request?.url)

            @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) return false
                return blockForeignNavigation(url?.let { Uri.parse(it) })
            }

            @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?,
            ) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) return // придёт новый колбэк
                if (failingUrl != null && failingUrl != targetUrl) return
                fail(description ?: getString(R.string.err_unknown))
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (request?.isForMainFrame != true) return
                val text = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    error?.description?.toString()
                } else {
                    null
                }
                fail(text ?: getString(R.string.err_unknown))
            }

            override fun onReceivedHttpError(
                view: WebView?,
                request: WebResourceRequest?,
                errorResponse: WebResourceResponse?,
            ) {
                if (request?.isForMainFrame != true) return
                val code = errorResponse?.statusCode ?: return
                val reason = when {
                    code != HTTP_UNAUTHORIZED -> getString(R.string.err_http, code)
                    authWithheld -> getString(R.string.err_http_401_withheld)
                    BuildConfig.DASHBOARD_USER.isEmpty() ||
                        BuildConfig.DASHBOARD_PASSWORD.isEmpty() ->
                        getString(R.string.err_http_401_missing)
                    else -> getString(R.string.err_http_401)
                }
                fail(reason)
            }

            override fun onReceivedHttpAuthRequest(
                view: WebView?,
                authHandler: HttpAuthHandler?,
                host: String?,
                realm: String?,
            ) {
                if (authHandler == null) {
                    super.onReceivedHttpAuthRequest(view, authHandler, host, realm)
                    return
                }
                handleAuthRequest(authHandler, host)
            }

            /**
             * System WebView обновляется через Play и убивает renderer'ы работающих
             * приложений; плюс ночной OOM на слабом ТВ-железе. Если не вернуть true,
             * система убивает процесс приложения целиком — и телевизор в детской молча
             * показывает лаунчер до следующего ручного запуска.
             */
            @RequiresApi(Build.VERSION_CODES.O)
            override fun onRenderProcessGone(
                view: WebView?,
                detail: RenderProcessGoneDetail?,
            ): Boolean {
                Log.w(TAG, "renderer умер (didCrash=${detail?.didCrash()}) — пересоздаю WebView")
                recreateWebView()
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage?): Boolean {
                if (message != null) {
                    Log.d(TAG, "web: ${safe(message.message().orEmpty())} @${message.lineNumber()}")
                }
                // false — пусть движок пишет своё в logcat: в релизе это
                // единственный способ понять, почему дашборд показал белый экран.
                return false
            }
        }
    }

    /** true — навигацию не пропускаем. */
    private fun blockForeignNavigation(uri: Uri?): Boolean {
        if (uri == null) return false
        val url = uri.toString()
        if (url.startsWith(BLANK)) return false
        val host = uri.host?.lowercase()
        val target = runCatching { Uri.parse(targetUrl).host?.lowercase() }.getOrNull()
        // Тот же хост И разрешённая схема: редирект https -> http на публичный
        // домен тоже должен упереться, а не проехать «это же наш хост».
        if (host != null && host == target && isAllowedUrl(url)) return false
        Log.w(TAG, "навигация наружу заблокирована: ${safe(url)}")
        return true
    }

    // ------------------------------------------------------ Аутентификация

    /**
     * Дашборд закрыт HTTP Basic на Caddy, а у телевизора есть пульт и нет клавиатуры —
     * пароль вводить некому. Отдаём его сами.
     *
     * Условия жёсткие: только на хост из DASHBOARD_URL и только по HTTPS.
     *
     * Ограничение на число попыток — по СЕРИИ, а не по загрузке страницы. Дашборд
     * после отрисовки сам ходит в /api/state и держит /api/stream, и эти запросы тоже
     * за basic auth: каждый из них — законный новый запрос учётных данных, а не признак
     * того, что пару отвергли. Признак отказа — несколько запросов подряд в пределах
     * короткого окна: так выглядит цикл 401 → proceed → 401, и вот его мы обрываем.
     */
    private fun handleAuthRequest(authHandler: HttpAuthHandler, host: String?) {
        val user = BuildConfig.DASHBOARD_USER
        val password = BuildConfig.DASHBOARD_PASSWORD

        if (user.isEmpty() || password.isEmpty()) {
            // Сборка без учётных данных: ведём себя как раньше. Сервер вернёт 401,
            // его подхватит onReceivedHttpError и покажет внятную причину.
            Log.w(TAG, "сервер требует аутентификацию, а в сборке учётных данных нет")
            authHandler.cancel()
            return
        }
        if (!mayAuthenticate(host)) {
            authWithheld = true
            Log.w(
                TAG,
                "учётные данные НЕ отправлены: запрос от host=$host, " +
                    "целевой ${displayUrl(targetUrl)}",
            )
            authHandler.cancel()
            return
        }

        val now = SystemClock.elapsedRealtime()
        if (now - lastAuthAt > AUTH_SERIES_WINDOW_MS) authAttempts = 0
        lastAuthAt = now

        if (authAttempts < MAX_AUTH_ATTEMPTS) {
            authAttempts += 1
            authHandler.proceed(user, password)
            return
        }

        // Несколько запросов подряд за секунды — пару не приняли.
        authHandler.cancel()
        if (contentShown) {
            // Страница уже на экране: это сорвался её собственный запрос к API.
            // Гасить рабочий дашборд нельзя — он сам покажет «связь потеряна».
            Log.w(TAG, "запрос дашборда не прошёл аутентификацию, экран не трогаю")
        } else {
            Log.w(TAG, "сервер не принял логин и пароль")
            failAuth()
        }
    }

    /** Пароль уходит только своему хосту и только по HTTPS. */
    private fun mayAuthenticate(host: String?): Boolean {
        val challenge = host?.lowercase()?.trim().orEmpty()
        if (challenge.isEmpty()) return false
        val target = runCatching { Uri.parse(targetUrl) }.getOrNull() ?: return false
        if (!"https".equals(target.scheme, ignoreCase = true)) return false
        if (!isAllowedUrl(targetUrl)) return false
        val targetHost = target.host?.lowercase().orEmpty()
        if (targetHost.isEmpty()) return false
        val withPort = if (target.port > 0) "$targetHost:${target.port}" else targetHost
        return challenge == targetHost || challenge == withPort
    }

    /**
     * Полная замена упавшего WebView: старый после гибели renderer'а трогать нельзя,
     * им можно только один раз вызвать destroy().
     */
    private fun recreateWebView() {
        handler.removeCallbacks(loadTimeout)
        handler.removeCallbacks(countdown)

        val dead = web
        val index = root.indexOfChild(dead).coerceAtLeast(0)
        root.removeView(dead)
        dead.destroy()

        web = WebView(this).apply {
            id = R.id.web
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            visibility = View.INVISIBLE
        }
        root.addView(web, index)

        setUpWebView()
        historyDirty = false
        attempt = 0
        load()
    }

    // ------------------------------------------------------- Загрузка/ретрай

    private fun load() {
        handler.removeCallbacks(countdown)
        handler.removeCallbacks(loadTimeout)

        failed = false
        authAttempts = 0
        authRejected = false
        authWithheld = false
        targetUrl = currentUrl()

        showConnecting()
        web.stopLoading()
        web.loadUrl(targetUrl)
        handler.postDelayed(loadTimeout, LOAD_TIMEOUT_MS)
    }

    private fun fail(reason: String) {
        if (failed) return
        failed = true
        handler.removeCallbacks(loadTimeout)

        Log.w(TAG, "load failed: ${safe(displayUrl(targetUrl))} — ${safe(reason)}")

        clearEngineErrorPage()
        showError(reason)
        scheduleRetry()
    }

    /**
     * Сервер отверг логин и пароль. Повторять сразу бессмысленно — пара от этого
     * верной не станет, — но и бросать телевизор нельзя: пароль могут поправить
     * на сервере. Поэтому отдельный экран и редкая проверка.
     */
    private fun failAuth() {
        if (failed) return
        failed = true
        authRejected = true
        handler.removeCallbacks(loadTimeout)

        Log.w(TAG, "аутентификация отклонена сервером: ${safe(displayUrl(targetUrl))}")

        clearEngineErrorPage()
        showAuthError()

        retryAt = SystemClock.elapsedRealtime() + AUTH_RETRY_MS
        handler.removeCallbacks(countdown)
        handler.post(countdown)
    }

    /** Стереть встроенную страницу ошибки движка: пользователь её видеть не должен. */
    private fun clearEngineErrorPage() {
        historyDirty = true
        handler.post {
            web.stopLoading()
            web.loadUrl(BLANK)
        }
    }

    private fun scheduleRetry() {
        val delay = BACKOFF_MS[minOf(attempt, BACKOFF_MS.lastIndex)]
        attempt += 1
        retryAt = SystemClock.elapsedRealtime() + delay
        handler.removeCallbacks(countdown)
        handler.post(countdown)
    }

    private fun retryNow() {
        attempt = 0
        load()
    }

    private fun hardReload() {
        toast(getString(R.string.reloading))
        retryNow()
    }

    // ----------------------------------------------------------- Состояния

    private fun showContent() {
        overlay.visibility = View.GONE
        contentShown = true
        overlayHint.visibility = View.GONE
        web.visibility = View.VISIBLE
        // requestFocus() здесь не вызываем намеренно: он и приводил к focus ring.
    }

    private fun showConnecting() {
        web.visibility = View.INVISIBLE
        contentShown = false
        overlay.visibility = View.VISIBLE
        overlayTitle.setText(R.string.connecting_title)
        overlayTitle.setTextColor(getColorCompat(R.color.bt_cyan))
        overlayDetail.setText(R.string.connecting_detail)
        overlayUrl.text = displayUrl(targetUrl)
        overlayStatus.setText(R.string.connecting_status)
        overlayHint.visibility = View.GONE
    }

    private fun showError(reason: String) {
        web.visibility = View.INVISIBLE
        contentShown = false
        overlay.visibility = View.VISIBLE
        overlayTitle.setText(R.string.error_title)
        overlayTitle.setTextColor(getColorCompat(R.color.bt_magenta))
        overlayDetail.text = safe(reason)
        overlayUrl.text = displayUrl(targetUrl)
        overlayHint.visibility = View.VISIBLE
    }

    private fun showAuthError() {
        web.visibility = View.INVISIBLE
        contentShown = false
        overlay.visibility = View.VISIBLE
        overlayTitle.setText(R.string.auth_error_title)
        overlayTitle.setTextColor(getColorCompat(R.color.bt_magenta))
        overlayDetail.setText(R.string.auth_error_detail)
        overlayUrl.text = displayUrl(targetUrl)
        overlayHint.visibility = View.VISIBLE
    }

    /** Ничего секретного на экран и в логи: ни пароля, ни `user:pass@` из URL. */
    private fun safe(text: String): String {
        val password = BuildConfig.DASHBOARD_PASSWORD
        return if (password.isEmpty()) text else text.replace(password, "***")
    }

    private fun displayUrl(url: String): String = safe(url.replace(USER_INFO, "//"))

    @Suppress("DEPRECATION")
    private fun getColorCompat(id: Int): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) getColor(id) else resources.getColor(id)

    // ------------------------------------------------------------ Сеть

    /**
     * Телевизор включается раньше Wi-Fi. Как только сеть появилась — пробуем сразу,
     * не досиживая паузу бэкоффа.
     *
     * Уже загруженную страницу здесь НЕ перезагружаем: за разрыв связи при живой
     * странице отвечает сам дашборд (переподключение SSE, см. CONTRACT §6).
     */
    private fun registerNetworkCallback() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                handler.post { if (failed) retryNow() }
            }
        }
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            // Сервер может быть в локалке без выхода в интернет.
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        try {
            cm.registerNetworkCallback(request, cb)
            netCallback = cb
        } catch (e: Exception) {
            // Не критично: остаётся повтор по таймеру.
            Log.w(TAG, "registerNetworkCallback failed", e)
        }
    }

    // ------------------------------------------------------------ Пульт

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                // Разбираем в onKeyUp/onKeyLongPress, чтобы отличить долгое нажатие.
                if (event.repeatCount == 0) event.startTracking()
                return true
            }
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_BUTTON_Y -> {
                hardReload()
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER,
            -> if (overlay.visibility == View.VISIBLE) {
                retryNow()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            hardReload()
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (!event.isCanceled) handleBack()
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    /**
     * BACK не закрывает приложение одним нажатием: сначала назад по истории,
     * на «корне» — подтверждение вторым нажатием. Работает одинаково и на экране
     * ошибки: именно там пользователь оказывается каждое утро, когда телевизор
     * включился раньше Wi-Fi, и уйти оттуда он должен уметь.
     * Повторить попытку немедленно — это OK/центр.
     */
    private fun handleBack() {
        // Ходить по истории имеет смысл только когда пользователь видит саму страницу.
        // На экране подключения/ошибки история состоит из неудачных навигаций и
        // служебного about:blank — уводить по ней некуда, и BACK обязан работать
        // на выход: именно там телевизор оказывается каждое утро.
        if (overlay.visibility != View.VISIBLE && web.canGoBack()) {
            web.goBack()
            return
        }
        val now = SystemClock.elapsedRealtime()
        if (now - lastBackAt in 1..EXIT_WINDOW_MS) {
            finish()
        } else {
            lastBackAt = now
            toast(getString(R.string.exit_confirm))
        }
    }

    // ------------------------------------------------------ Полный экран

    private fun enterImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    // -------------------------------------------------------- Жизненный цикл

    override fun onResume() {
        super.onResume()
        web.onResume()
        enterImmersive()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        netCallback?.let { cb ->
            try {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)
                    ?.unregisterNetworkCallback(cb)
            } catch (e: Exception) {
                Log.w(TAG, "unregisterNetworkCallback failed", e)
            }
        }
        netCallback = null
        web.stopLoading()
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show()
    }

    private companion object {
        const val TAG = "BabyTrackerTV"
        const val PREFS = "babytracker_tv"
        const val KEY_URL = "dashboard_url"
        const val EXTRA_URL = "url"
        const val BLANK = "about:blank"

        /** Единственный источник, которому доверяем подмену адреса: adb shell. */
        const val SHELL_REFERRER = "android-app://com.android.shell"

        /** 172.16.0.0/12 — вторая приватная сеть. */
        val PRIVATE_172 = Regex("^172\\.(1[6-9]|2\\d|3[01])\\.")

        /** `//user:pass@` в URL — вырезаем перед показом и логированием. */
        val USER_INFO = Regex("//[^/@]*@")

        const val HTTP_UNAUTHORIZED = 401

        /** Пауза между проверками, когда сервер отверг пару логин/пароль. */
        const val AUTH_RETRY_MS = 5 * 60_000L

        /**
         * Запросы аутентификации, пришедшие подряд в пределах этого окна, считаются
         * одной серией: так выглядит цикл 401 → proceed → 401. Запрос позже —
         * это уже новый запрос страницы (например, переподключение SSE), и он
         * получает свои попытки.
         */
        const val AUTH_SERIES_WINDOW_MS = 10_000L

        /** Сколько раз за серию отдаём пару, прежде чем признать её неверной. */
        const val MAX_AUTH_ATTEMPTS = 2

        /** Сколько ждём ответа, прежде чем считать загрузку провалившейся. */
        const val LOAD_TIMEOUT_MS = 20_000L

        /** Нарастающая пауза между попытками, мс. */
        val BACKOFF_MS = longArrayOf(2_000, 3_000, 5_000, 8_000, 15_000, 30_000, 60_000)

        /** Окно для второго нажатия BACK. */
        const val EXIT_WINDOW_MS = 2_500L
    }
}
