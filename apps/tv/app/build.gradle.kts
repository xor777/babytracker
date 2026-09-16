import java.net.URI
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * Адрес дашборда. Берётся из project property DASHBOARD_URL, то есть из
 * `-PDASHBOARD_URL=...`, из переменной окружения `ORG_GRADLE_PROJECT_DASHBOARD_URL`
 * или из gradle.properties — именно в этом порядке приоритета (правила Gradle).
 * Исходники ради смены адреса править не нужно.
 */
val dashboardUrl: String =
    (project.findProperty("DASHBOARD_URL") as String?)?.trim()?.takeIf { it.isNotEmpty() }
        ?: "https://bt.nuanu.ai/"

/**
 * Белый список хостов, на которые приложению вообще разрешено ходить: и для навигации
 * внутри WebView, и для подмены адреса через adb. По умолчанию — только хост из
 * DASHBOARD_URL; плюс в коде всегда разрешены адреса локальной сети.
 *
 * bt.adbgw.ru сюда намеренно НЕ попадает: этот домен идёт прямо на IP и оставлен
 * вебхуку Алисы, а телевизору нужен путь через Cloudflare. Нужен он для отладки —
 * передайте оба через запятую: -PDASHBOARD_URL_HOSTS=bt.nuanu.ai,bt.adbgw.ru
 */
val dashboardHosts: String =
    (project.findProperty("DASHBOARD_URL_HOSTS") as String?)?.trim()?.takeIf { it.isNotEmpty() }
        ?: runCatching { URI(dashboardUrl).host }.getOrNull().orEmpty()

/**
 * HTTP Basic для закрытого Caddy — УСТАРЕЛО и больше не требуется.
 *
 * Вход теперь по коду сопряжения (CONTRACT §11): сервер сам показывает код,
 * человек одобряет его с телефона, телевизор получает сессию в куке. Пароль
 * в сборке не нужен — а это ровно тот пароль, из-за которого репозиторий
 * обязан был быть приватным: он лежал в APK открытым текстом и доставался
 * оттуда одной командой.
 *
 * Параметры оставлены до снятия basic auth на боевом сервере, чтобы APK из
 * этой ветки работал и со старым сервером. После переезда собирайте БЕЗ них.
 *
 * Настоящий пароль в gradle.properties проекта не кладём: только `-PDASHBOARD_PASSWORD=...`
 * или ~/.gradle/gradle.properties. Логин с паролем ниже нигде не логируются.
 */
val dashboardUser: String =
    (project.findProperty("DASHBOARD_USER") as String?)?.trim().orEmpty()

val dashboardPassword: String =
    (project.findProperty("DASHBOARD_PASSWORD") as String?).orEmpty()

/** Пароль может содержать кавычки и слеши — экранируем, иначе BuildConfig не скомпилируется. */
fun javaStringLiteral(value: String): String = "\"" + value
    .replace("\\", "\\\\")
    .replace("\"", "\\\"")
    .replace("\n", "\\n")
    .replace("\r", "\\r") + "\""

android {
    namespace = "com.nuanu.babytracker.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nuanu.babytracker.tv"
        minSdk = 21
        targetSdk = 34
        versionCode = 3
        versionName = "0.1.2"

        buildConfigField("String", "DASHBOARD_URL", javaStringLiteral(dashboardUrl))
        buildConfigField("String", "DASHBOARD_URL_HOSTS", javaStringLiteral(dashboardHosts))
        buildConfigField("String", "DASHBOARD_USER", javaStringLiteral(dashboardUser))
        buildConfigField("String", "DASHBOARD_PASSWORD", javaStringLiteral(dashboardPassword))
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        warningsAsErrors = false

        // Ослабления TLS по умолчанию всего лишь warning и проезжают молча.
        // У этих трёх нет ни одного законного применения в киоске на WebView —
        // поднимаем до error, чтобы ./gradlew lintDebug падал на регрессии.
        error += setOf(
            "AcceptsUserCertificates",
            "TrustAllX509TrustManager",
            "WebViewClientOnReceivedSslError",
        )

        // InsecureBaseConfiguration НЕ поднимаем: cleartextTrafficPermitted=true
        // здесь осознанный (сервер стартует по http в локалке, см. CONTRACT §7).
        // Когда дашборд окончательно переедет на HTTPS — выключить cleartext
        // в network_security_config.xml и добавить правило сюда же, в error.

        // Версии зависимостей обновляем осознанно, а не по требованию линта.
        disable += setOf("GradleDependency", "AndroidGradlePluginVersion", "OldTargetApi")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
}

// Напоминание в логе сборки: с каким адресом собрали APK.
// Пароль не печатаем — только факт, что он задан.
tasks.register("printDashboardUrl") {
    val url = dashboardUrl
    val hosts = dashboardHosts
    val user = dashboardUser
    val hasPassword = dashboardPassword.isNotEmpty()
    doLast {
        println("DASHBOARD_URL       = $url")
        println("DASHBOARD_URL_HOSTS = $hosts")
        println("DASHBOARD_USER      = ${user.ifEmpty { "(не задан — так и надо, вход по коду)" }}")
        println("DASHBOARD_PASSWORD  = ${if (hasPassword) "(задан — нужен только старому серверу)" else "(не задан — так и надо)"}")
    }
}
