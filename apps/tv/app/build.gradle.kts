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
        ?: "http://192.168.1.10:8787/"

/**
 * Белый список хостов, на которые приложению вообще разрешено ходить: и для навигации
 * внутри WebView, и для подмены адреса через adb. По умолчанию — только хост из
 * DASHBOARD_URL; плюс в коде всегда разрешены адреса локальной сети.
 */
val dashboardHosts: String =
    (project.findProperty("DASHBOARD_URL_HOSTS") as String?)?.trim()?.takeIf { it.isNotEmpty() }
        ?: runCatching { URI(dashboardUrl).host }.getOrNull().orEmpty()

android {
    namespace = "com.nuanu.babytracker.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nuanu.babytracker.tv"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "DASHBOARD_URL", "\"$dashboardUrl\"")
        buildConfigField("String", "DASHBOARD_URL_HOSTS", "\"$dashboardHosts\"")
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
tasks.register("printDashboardUrl") {
    val url = dashboardUrl
    doLast { println("DASHBOARD_URL = $url") }
}
