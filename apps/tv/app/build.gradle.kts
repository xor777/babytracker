import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * Адрес дашборда. Приоритет:
 *   1. -PDASHBOARD_URL=... (командная строка) или gradle.properties;
 *   2. переменная окружения DASHBOARD_URL;
 *   3. дефолт ниже.
 * Исходники ради смены адреса править не нужно.
 */
val dashboardUrl: String =
    (project.findProperty("DASHBOARD_URL") as String?)?.trim()?.takeIf { it.isNotEmpty() }
        ?: System.getenv("DASHBOARD_URL")?.trim()?.takeIf { it.isNotEmpty() }
        ?: "http://192.168.1.10:8787/"

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
        // Обёртка вокруг WebView: ловить релиз на предупреждениях линта незачем.
        abortOnError = false
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
