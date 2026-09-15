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

### Два домена, и они не взаимозаменяемы

Один и тот же сервер, один и тот же Caddy, но снаружи доступен двумя путями:

| Домен | Путь | Для кого |
|---|---|---|
| **`bt.nuanu.ai`** | через **Cloudflare** | **телевизор и люди** |
| `bt.adbgw.ru` | прямо на IP сервера | только вебхук Алисы |

Разделение не косметическое, у каждой стороны своя причина.

**Почему телевизору нужен Cloudflare.** Прямой путь до IP сервера часть провайдеров
режет: крупные ответы обрываются на 11–20 КБ. JS-бандл дашборда весит 265 КБ — с
пострадавшей машины он приходил обрывком за 20 секунд, с другой целиком за 2. То есть
телевизор в такой сети дашборд просто **не загрузил бы**. Через Cloudflare тот же файл
приезжает целиком за 0.3 с.

**Почему вебхук остаётся на прямом пути.** У Яндекса проблем с прямым IP нет, а лимит
ответа Алисе — 3 секунды: лишний посредник тратит этот бюджет. Плюс защита от ботов
перед вебхуком рано или поздно начнёт фильтровать запросы Яндекса.

Поэтому `bt.adbgw.ru` **намеренно не входит** в белый список приложения: телевизор
туда не ходит. Нужен для отладки — передайте оба хоста явно:
`-PDASHBOARD_URL_HOSTS=bt.nuanu.ai,bt.adbgw.ru`.

### Как поменять

Адрес **не захардкожен**: он лежит в `gradle.properties` и попадает в код через
`BuildConfig.DASHBOARD_URL`. Исходники ради смены адреса трогать не нужно.

```properties
# apps/tv/gradle.properties
DASHBOARD_URL=https://bt.nuanu.ai/
```

Разово, без правки файла:

```bash
./gradlew assembleDebug -PDASHBOARD_URL=http://192.168.1.42:8787/
```

Либо через переменную окружения — именно с префиксом `ORG_GRADLE_PROJECT_`, это
штатный механизм Gradle:

```bash
ORG_GRADLE_PROJECT_DASHBOARD_URL=http://192.168.1.42:8787/ ./gradlew assembleDebug
```

> Голая `DASHBOARD_URL=… ./gradlew …` **не работает**: значение из `gradle.properties`
> всё равно окажется сильнее. Приоритет (проверен фактом):
> `-PDASHBOARD_URL` > `ORG_GRADLE_PROJECT_DASHBOARD_URL` > `gradle.properties` > дефолт в коде.

Проверить, с каким адресом соберётся APK:

```bash
./gradlew :app:printDashboardUrl -q
# DASHBOARD_URL = http://192.168.1.42:8787/
```

> **Важно.** `localhost` и `127.0.0.1` указывают на сам телевизор — работать не будут.
> Нужен адрес машины с сервером в той же сети (`ipconfig getifaddr en0` на macOS)
> либо публичный https-адрес домена.

### Логин и пароль (HTTP Basic)

`/api/*` и админка закрыты HTTP Basic на Caddy. Клавиатуры у телевизора нет, поэтому
приложение отвечает на запрос аутентификации само. Учётные данные — такие же параметры
сборки, как адрес:

```bash
./gradlew assembleDebug -PDASHBOARD_USER=tv -PDASHBOARD_PASSWORD='…'
```

Приоритет тот же (`-P` > `ORG_GRADLE_PROJECT_*` > `gradle.properties`). В
`gradle.properties` проекта обе строки пустые и такими должны остаться — **файл в git**.
Постоянные значения кладите в `~/.gradle/gradle.properties`:

```properties
DASHBOARD_USER=tv
DASHBOARD_PASSWORD=…
```

Проверить, что попадёт в APK (пароль не печатается, только факт):

```bash
./gradlew :app:printDashboardUrl -q
# DASHBOARD_USER      = tv
# DASHBOARD_PASSWORD  = (задан)
```

Правила отправки:

- **пусто = аутентификации нет.** Локальная разработка без Caddy работает как раньше;
- пароль уходит **только на хост из `DASHBOARD_URL` и только по HTTPS**. Оказался
  WebView на чужом хосте или на http — пароль не отправляется, на экране будет
  «Логин и пароль не отправлены: этот адрес не HTTPS»;
- **один раз за загрузку.** Если сервер отверг пару, приложение не уходит в цикл
  401 → повтор, а показывает отдельный экран «СЕРВЕР НЕ ПРИНЯЛ ЛОГИН И ПАРОЛЬ» и
  перепроверяет раз в 5 минут — чтобы телевизор вернулся сам, если пароль поправят
  на сервере;
- пароль не попадает ни в logcat, ни в лог консоли страницы, ни на экран: всё, что
  выводится, проходит через маскирование, а `user:pass@` из URL вырезается.

> **Пароль в APK — не секрет.** `BuildConfig` лежит в dex, его достанет любой, у кого
> есть файл APK. Это общий пароль домашней сети, а не персональный: раздавать APK
> посторонним нельзя, при утечке — сменить пароль в Caddy и пересобрать.

### Белый список хостов

Приложение — киоск: оно ходит только на хост из `DASHBOARD_URL` и на адреса локальной
сети (`10.*`, `192.168.*`, `172.16–31.*`, `127.*`, `localhost`, `*.local`). Всё остальное
блокируется и при навигации внутри WebView, и при подмене адреса через adb.

Открытый `http://` разрешён **только для локальной сети**: публичный домен по http
не откроется ни по ссылке, ни по редиректу — так выглядит downgrade-атака.

Если телевизору нужно ходить на несколько доменов, перечислите их через запятую:

```properties
# apps/tv/gradle.properties
DASHBOARD_URL=https://bt.nuanu.ai/
DASHBOARD_URL_HOSTS=bt.nuanu.ai,bt.adbgw.ru
```

### Смена адреса без пересборки

На телевизоре нечем набрать URL, поэтому адрес можно подменить через adb.
Значение сохраняется и переживает перезапуск приложения:

```bash
adb shell am start -n com.nuanu.babytracker.tv/.MainActivity -e url http://192.168.1.42:8787/
adb shell am start -n com.nuanu.babytracker.tv/.MainActivity -e url reset   # вернуть значение из сборки
```

Extra `url` принимается **только от adb**: activity экспортирована (без этого лаунчер TV
её не запустит), поэтому приложение сверяет `referrer` с `android-app://com.android.shell`
и игнорирует команду от любого стороннего приложения на телевизоре. Адрес вне белого
списка не принимается даже от adb. Отказ виден в `adb logcat -s BabyTrackerTV`.

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

### Линт

```bash
./gradlew lintDebug
```

`abortOnError = true`, а правила `AcceptsUserCertificates`, `TrustAllX509TrustManager`
и `WebViewClientOnReceivedSslError` подняты с warning до error: вернуть ослабление TLS
незаметно не получится, сборка упадёт. `InsecureBaseConfiguration` осознанно оставлен
предупреждением — cleartext нужен, пока сервер отдаёт http (см. §4).

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
# W BabyTrackerTV: load failed: https://bt.nuanu.ai/ — net::ERR_CONNECTION_REFUSED
```

Отключиться: `adb disconnect 192.168.1.55:5555`.

---

## 4. Что делает приложение

**Экран.** Полноэкранный immersive без ActionBar и системных панелей, фон — настоящий
чёрный. `KEEP_SCREEN_ON` (флаг окна + `android:keepScreenOn` на корне разметки):
дашборд висит сутками, заставка не включается.

**WebView.** JavaScript и DOM storage включены, зум выключен, системный масштаб шрифта
игнорируется (`textZoom = 100`), доступ к локальным файлам запрещён.

**Сеть и TLS.** Доверяются **только системные CA** — пользовательские сертификаты не
принимаются, иначе подсунутый на телевизор CA штатно ломал бы HTTPS. Смешанный контент
запрещён (`MIXED_CONTENT_NEVER_ALLOW`). Навигация ограничена белым списком хостов и схем
(§1): `shouldOverrideUrlLoading` не выпускает киоск наружу ни по ссылке, ни по редиректу.

Про cleartext. Формат `network-security-config` не умеет диапазоны адресов — правила
«разрешить http только в RFC1918» в нём не выразить, а генерировать конфиг под каждую
сборку ради этого не стоит. Поэтому сделано с двух сторон:

- `cleartextTrafficPermitted="true"` остаётся в `base-config` — иначе отвалится
  локальный сценарий `http://192.168.x.x:8787`, который заказчику ещё нужен;
- для публичных доменов стоит отдельный `domain-config` с
  `cleartextTrafficPermitted="false"` — платформа не даст открыть их по http.
  Там перечислены **оба**: `nuanu.ai` (ходит телевизор) и `adbgw.ru` (сервер по нему
  отвечает, строгий HTTPS нужен и там), у обоих `includeSubdomains`. Появится третий
  домен — дописать туда же;
- в коде открытый http разрешён только для локальных адресов, так что до NSC дело
  обычно и не доходит.

`InsecureBaseConfiguration` из-за первого пункта остаётся предупреждением линта. Если
локальный http-сценарий когда-нибудь отменят — выключить cleartext в `base-config`
и поднять правило до error в `app/build.gradle.kts`, это одна строка.

**Устойчивость к сети.** Телевизор включается раньше, чем поднимается Wi-Fi, поэтому
первая загрузка почти всегда падает. Вместо белого экрана и стандартной ошибки движка
показывается свой экран с причиной, текущим URL и обратным отсчётом; попытка повторяется
сама с нарастающей паузой **2 → 3 → 5 → 8 → 15 → 30 → 60 с** (дальше — раз в минуту,
бесконечно). Плюс подписка на `ConnectivityManager`: как только сеть появилась, попытка
делается сразу, не досиживая паузу. Загрузка, висящая дольше 20 с, считается неудачей.

> **Явная зависимость от дашборда.** Переподключение делается только если страница
> **не загрузилась**. Если она уже открыта, а Wi-Fi пропал и вернулся, приложение не
> делает ничего — выкарабкивается сам дашборд, переподключая SSE (CONTRACT §6). Уберёте
> из дашборда watchdog переподключения — телевизор останется с мёртвой страницей
> до перезагрузки пультом.

**Гибель renderer'а.** System WebView обновляется через Play и убивает renderer'ы
работающих приложений; плюс ночной OOM на слабом ТВ-железе. Без обработки процесс
приложения умирает целиком, и телевизор в детской молча показывает лаунчер.
`onRenderProcessGone` возвращает `true`, старый WebView уничтожается, на его место
встаёт новый и дашборд грузится заново.

**Пульт.**

| Кнопка | Действие |
|---|---|
| `BACK` | назад по истории WebView; на «корне» — первое нажатие показывает подсказку, второе в течение 2.5 с закрывает приложение. Одним нажатием приложение не закрыть. Работает и на экране ошибки |
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
| Экран «СЕРВЕР НЕ ПРИНЯЛ ЛОГИН И ПАРОЛЬ» | `DASHBOARD_USER`/`DASHBOARD_PASSWORD` не совпали с настройками Caddy — пересобрать с верными |
| «Сервер требует логин и пароль (401), а в сборке их нет» | APK собран без `-PDASHBOARD_USER/-PDASHBOARD_PASSWORD` |
| «Логин и пароль не отправлены: этот адрес не HTTPS» | закрытый сервер открывают по http — пароль намеренно не уходит; используйте https-адрес |
| `подмена адреса отклонена, referrer=…` в логе | `-e url` пришёл не от adb; с телевизора адрес не меняется по замыслу |
| `адрес вне белого списка отклонён` | хост не из `DASHBOARD_URL_HOSTS` и не из локальной сети (§1) |
| Белая/пустая страница, в логе `renderer умер` | System WebView обновился; приложение пересоздаёт WebView само, вмешательства не нужно |
| Сборка падает на `Unsupported class file major version` | Gradle запущен не на Java 17 — выставить `JAVA_HOME` (§2) |
| `SDK location not found` | нет `local.properties` с `sdk.dir` (§2) |
