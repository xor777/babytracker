# BabyTracker TV

Тонкая обёртка вокруг WebView для Android TV: открывает веб-дашборд на весь экран,
не даёт телевизору погаснуть и сама переподключается, пока сервер не ответит.

Вся логика трекера — в вебе (`apps/dashboard`). Здесь только то, без чего дашборд
не открыть с пульта: иконка в лаунчере TV, полный экран и устойчивость к сети.
Требования — `docs/CONTRACT.md` §7.

- Kotlin, Gradle (Kotlin DSL), AGP 8.7.3, Gradle 8.11.1
- `minSdk 21` / `targetSdk 34` / `compileSdk 35`
- Единственная зависимость — `androidx.core:core-ktx`
- APK ≈ 1.6 МБ

---

## 1. Адрес дашборда

Адрес **не захардкожен**: он лежит в `gradle.properties` и попадает в код через
`BuildConfig.DASHBOARD_URL`. Исходники ради смены адреса трогать не нужно.

```properties
# apps/tv/gradle.properties
DASHBOARD_URL=http://192.168.1.10:8787/
```

Разово, без правки файла:

```bash
./gradlew assembleDebug -PDASHBOARD_URL=http://192.168.1.42:8787/
```

Либо через переменную окружения (приоритет ниже, чем у `-P`):

```bash
DASHBOARD_URL=http://192.168.1.42:8787/ ./gradlew assembleDebug
```

Проверить, с каким адресом соберётся APK:

```bash
./gradlew :app:printDashboardUrl -q
# DASHBOARD_URL = http://192.168.1.42:8787/
```

> **Важно.** `localhost` и `127.0.0.1` указывают на сам телевизор — работать не будут.
> Нужен адрес машины с сервером в той же сети (`ipconfig getifaddr en0` на macOS)
> либо публичный https-адрес туннеля.

### Смена адреса без пересборки

На телевизоре нечем набрать URL, поэтому адрес можно подменить через adb.
Значение сохраняется и переживает перезапуск приложения:

```bash
adb shell am start -n com.nuanu.babytracker.tv/.MainActivity -e url http://192.168.1.42:8787/
adb shell am start -n com.nuanu.babytracker.tv/.MainActivity -e url reset   # вернуть значение из сборки
```

---

## 2. Сборка

Нужна **Java 17** (Gradle 8.11 не работает на JDK 26, которая в macOS часто стоит по умолчанию)
и Android SDK с `platforms/android-35` + `build-tools/35.0.0`.

```bash
cd apps/tv

# 1. Путь к SDK. Файл машинно-зависимый, в git не попадает (см. корневой .gitignore).
echo "sdk.dir=/opt/homebrew/share/android-commandlinetools" > local.properties

# 2. Сборка
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew assembleDebug
```

Результат: `app/build/outputs/apk/debug/app-debug.apk`.

`ANDROID_HOME` выставлять не обязательно — Gradle возьмёт путь из `local.properties`.
Если JDK 17 лежит в другом месте: `/usr/libexec/java_home -v 17` или `brew --prefix openjdk@17`.

Релизная сборка — `./gradlew assembleRelease`; подпись не настроена, для домашнего
телевизора хватает debug-APK.

### Проверка собранного APK

Самая частая ошибка TV-приложений — приложение собирается, но не появляется в лаунчере.
Проверяется фактом:

```bash
$ANDROID_HOME/build-tools/35.0.0/aapt dump badging app/build/outputs/apk/debug/app-debug.apk \
  | grep -E "leanback|touchscreen|banner|sdkVersion"
```

Должно быть:

```
sdkVersion:'21'
targetSdkVersion:'34'
application: label='BabyTracker' icon='...' banner='res/drawable-xhdpi-v4/banner.png'
leanback-launchable-activity: name='com.nuanu.babytracker.tv.MainActivity' ... banner='res/drawable-xhdpi-v4/banner.png'
  uses-feature-not-required: name='android.hardware.touchscreen'
  uses-feature: name='android.software.leanback'
```

Нет строки `leanback-launchable-activity` — иконки на телевизоре не будет.

---

## 3. Установка на телевизор

### 3.1 Включить отладку по сети на Android TV

1. **Настройки → Об устройстве (Об этом телевизоре)** → семь раз нажать на
   **Сборка / Build** → появится «Режим разработчика включён».
2. **Настройки → Система → Для разработчиков** → включить
   **Отладка по USB (USB debugging)**, а если есть — **Отладка по сети (Wireless/Network debugging)**.
   На многих телевизорах (Sony, Philips, Xiaomi) отдельного пункта «по сети» нет:
   достаточно USB debugging, порт 5555 слушается сам.
3. Узнать IP: **Настройки → Сеть → состояние подключения**.

### 3.2 Подключиться и поставить

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH="$ANDROID_HOME/platform-tools:$PATH"

adb connect 192.168.1.55:5555        # IP телевизора
# На экране телевизора появится запрос «Разрешить отладку?» — принять,
# отметив «Всегда разрешать с этого компьютера».

adb devices                          # должен появиться 192.168.1.55:5555  device
adb install -r apps/tv/app/build/outputs/apk/debug/app-debug.apk
```

Если `adb connect` молчит (`failed to connect`), а телевизор подключён по USB:

```bash
adb usb && adb tcpip 5555 && adb connect 192.168.1.55:5555
```

После установки приложение появляется в ряду приложений лаунчера Android TV
с баннером 320×180. Запустить можно и командой:

```bash
adb shell am start -n com.nuanu.babytracker.tv/.MainActivity
```

Посмотреть, что происходит:

```bash
adb logcat -s BabyTrackerTV
# W BabyTrackerTV: load failed: http://192.168.1.10:8787/ — net::ERR_CONNECTION_REFUSED
```

Отключиться: `adb disconnect 192.168.1.55:5555`.

---

## 4. Что делает приложение

**Экран.** Полноэкранный immersive без ActionBar и системных панелей, фон — настоящий
чёрный. `KEEP_SCREEN_ON` (флаг окна + `android:keepScreenOn` на корне разметки):
дашборд висит сутками, заставка не включается.

**WebView.** JavaScript и DOM storage включены, зум выключен, системный масштаб шрифта
игнорируется (`textZoom = 100`), доступ к локальным файлам запрещён. Открытый HTTP
разрешён явно: `android:usesCleartextTraffic="true"` + `res/xml/network_security_config.xml`
(без этого на Android 9+ локальный `http://…:8787` просто не открылся бы).

**Устойчивость к сети.** Телевизор включается раньше, чем поднимается Wi-Fi, поэтому
первая загрузка почти всегда падает. Вместо белого экрана и стандартной ошибки движка
показывается свой экран с причиной, текущим URL и обратным отсчётом; попытка повторяется
сама с нарастающей паузой **2 → 3 → 5 → 8 → 15 → 30 → 60 с** (дальше — раз в минуту,
бесконечно). Плюс подписка на `ConnectivityManager`: как только сеть появилась, попытка
делается сразу, не досиживая паузу. Загрузка, висящая дольше 20 с, считается неудачей.

**Пульт.**

| Кнопка | Действие |
|---|---|
| `BACK` | назад по истории WebView; на «корне» — первое нажатие показывает подсказку, второе в течение 2.5 с закрывает приложение. Одним нажатием приложение не закрыть |
| `BACK` (долгое) | перезагрузить страницу |
| `MENU` | перезагрузить страницу |
| `OK` / центр | на экране ошибки — повторить попытку немедленно |

**Баннер и иконка.** `res/drawable-xhdpi/banner.png` — 320×180, в стиле дашборда
(чёрный фон, неоновая типографика циан/пурпур). Без баннера и без
`LEANBACK_LAUNCHER` приложение в лаунчере Android TV не появится вообще.

---

## 5. Структура

```
apps/tv/
├── build.gradle.kts              версии AGP и Kotlin
├── settings.gradle.kts
├── gradle.properties             ← DASHBOARD_URL
├── local.properties              путь к SDK (не в git)
├── gradlew / gradle/wrapper/
└── app/
    ├── build.gradle.kts          buildConfigField DASHBOARD_URL
    └── src/main/
        ├── AndroidManifest.xml   LEANBACK_LAUNCHER, uses-feature, cleartext
        ├── java/com/nuanu/babytracker/tv/MainActivity.kt
        └── res/
            ├── layout/activity_main.xml      WebView + экран состояния
            ├── drawable-xhdpi/banner.png     320×180
            ├── mipmap-*/ic_launcher.png
            ├── values/{colors,strings,themes}.xml
            └── xml/network_security_config.xml
```

## 6. Частые проблемы

| Симптом | Причина |
|---|---|
| Приложения нет в лаунчере TV | нет `LEANBACK_LAUNCHER` или баннера — проверить `aapt dump badging` (§2) |
| `ERR_CLEARTEXT_NOT_PERMITTED` | пропал `usesCleartextTraffic` / `network_security_config` |
| Экран «НЕТ СВЯЗИ», адрес `localhost` | `DASHBOARD_URL` указывает на сам телевизор — нужен LAN-адрес сервера |
| `ERR_CONNECTION_REFUSED` | сервер не поднят, другой порт, либо телевизор в другой сети/VLAN |
| Сборка падает на `Unsupported class file major version` | Gradle запущен не на Java 17 — выставить `JAVA_HOME` (§2) |
| `SDK location not found` | нет `local.properties` с `sdk.dir` (§2) |
