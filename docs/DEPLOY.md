# Развёртывание

Сервер — любая Ubuntu 22.04/24.04 машина, до которой есть SSH. Целевой хост задаётся
переменной `BABYTRACKER_HOST` (имя из `~/.ssh/config`), жёстко в скриптах он не прописан.

```bash
BABYTRACKER_HOST=my-server ./infra/deploy.sh
```

## Требования к машине

| Что | Зачем |
|-----|-------|
| SSH-доступ, пользователь с `sudo` не обязателен | всё ставится в `~/.local`, сервисы — `systemctl --user` |
| ~2 ГБ свободного диска | Node, зависимости, база, снимки |
| Публичный HTTPS до порта 8787 | Алиса ходит только по HTTPS с валидным сертификатом |
| Авторизованный `claude` CLI | без него LLM-разбор пропускается, остальное работает |

`bootstrap-vm.sh` ставит Node 24, pnpm, cloudflared и Claude Code CLI — всё в домашний каталог,
системные пакеты не трогает. Скрипт идемпотентен.

## Почему устроено именно так

- **Без Docker.** Воркеру нужен авторизованный `claude` CLI с домашним каталогом пользователя;
  в контейнере это лишняя возня с пробросом токенов. Обычные systemd-сервисы проще.
- **`systemctl --user` вместо системных юнитов.** Не нужен root. Нужен лишь включённый lingering,
  иначе сервисы не переживут выход из сессии: `sudo loginctl enable-linger $USER`.
- **`node:sqlite` вместо `better-sqlite3`.** Нативный модуль требует C++ тулчейна на сервере;
  встроенный в Node драйвер не требует компиляции. Отсюда требование Node ≥ 24.
- **TypeScript запускается напрямую**, без сборки: Node 24 умеет снимать типы сам.
  Поэтому `ExecStart` указывает на `src/index.ts`, а `dist/` не существует.
- **Порт 8787**, не 3000 — 3000 слишком часто занят чем-то другим.

## Как дать Алисе публичный HTTPS

Зависит от того, что у сервера есть.

**Есть публичный IP и домен** — самый надёжный вариант. Поставь Caddy, он сам получит
сертификат Let's Encrypt:

```
baby.example.com {
    reverse_proxy localhost:8787
}
```

**Сервер за NAT, публичного IP нет** — Cloudflare Tunnel, `cloudflared` уже стоит после
bootstrap. Быстрый туннель работает без аккаунта и без домена:

```bash
ssh $BABYTRACKER_HOST 'systemctl --user start babytracker-tunnel'
ssh $BABYTRACKER_HOST 'bash ~/babytracker/infra/tunnel-url.sh'
```

Он выдаёт случайный `https://…trycloudflare.com`, **который меняется при каждом перезапуске** —
для первых проверок нормально, для постоянной работы нет: URL придётся переписывать в консоли
Яндекс Диалогов. Постоянный адрес даёт именованный туннель (нужен аккаунт Cloudflare и домен):

```bash
ssh -t $BABYTRACKER_HOST
cloudflared tunnel login
cloudflared tunnel create babytracker
cloudflared tunnel route dns babytracker baby.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: babytracker
credentials-file: /home/<user>/.cloudflared/<UUID>.json
ingress:
  - hostname: baby.example.com
    service: http://localhost:8787
  - service: http_status:404
```

И в `infra/systemd/babytracker-tunnel.service` заменить `ExecStart` на
`%h/.local/bin/cloudflared tunnel --no-autoupdate run babytracker`, затем передеплоить.

## Доступ и пароль

Всё, кроме двух путей, закрыто HTTP Basic Auth на уровне Caddy: история ребёнка и возможность
её менять не должны быть доступны любому, кто знает домен.

Открыты без пароля ровно:

- `/alice/<секрет>` — Алиса не умеет basic auth, её защищает секрет в URL;
- `/healthz` — нужен выкатке и мониторингу.

Пароль задаётся при провижининге и хранится хешем в `~/.config/babytracker-auth.hash`;
повторный запуск скрипта без переменной пароль не меняет.

```bash
BABYTRACKER_DOMAIN=bt.adbgw.ru \
BABYTRACKER_AUTH_USER=dmitry \
BABYTRACKER_AUTH_PASSWORD='новый-пароль' \
  ssh $BABYTRACKER_HOST 'bash -s' < infra/provision.sh
```

Телевизор отдаёт эти же логин и пароль сам — они зашиты в сборку APK
(`DASHBOARD_USER` / `DASHBOARD_PASSWORD`), вводить с пульта ничего не нужно.

## Первый запуск

```bash
export BABYTRACKER_HOST=my-server

ssh $BABYTRACKER_HOST 'bash -s' < infra/bootstrap-vm.sh   # Node 24, pnpm, cloudflared, claude CLI
ssh -t $BABYTRACKER_HOST 'claude setup-token'             # авторизация CLI, нужен браузер
./infra/deploy.sh                                          # код, сборка, сервисы
```

Дальше — [ALICE_SETUP.md](ALICE_SETUP.md).

## Повседневное

```bash
./infra/deploy.sh                                                  # выкатить изменения
ssh $BABYTRACKER_HOST 'journalctl --user -u babytracker -f'        # логи
ssh $BABYTRACKER_HOST 'systemctl --user restart babytracker'
ssh $BABYTRACKER_HOST 'curl -s localhost:8787/healthz'
```

`.env` на сервере создаётся при первом деплое и **больше не перезаписывается** — иначе секрет
вебхука менялся бы при каждой выкатке и URL в консоли Яндекса приходилось бы переписывать.

## Данные, снимки, бэкапы

Всё живёт в одном файле `~/babytracker/data/babytracker.db`.

Физическое удаление событий невозможно: его запрещает триггер SQLite (см. §9 контракта).
Любая правка журналируется и обратима, а перед каждым запуском модели снимается копия базы
в `data/snapshots/` (хранятся последние 50). Это защищает от ошибок модели — но **не от потери
самой машины**. Это история жизни ребёнка, восстановить её неоткуда, так что внешний бэкап нужен:

```bash
# .backup корректно снимает копию работающей базы; обычный cp при WAL может дать битый файл
ssh $BABYTRACKER_HOST 'sqlite3 ~/babytracker/data/babytracker.db ".backup /tmp/baby.db"'
scp $BABYTRACKER_HOST:/tmp/baby.db ./backups/baby-$(date +%F).db
```

Поставь это в cron на своей машине — раз в сутки достаточно.

## Подписка и лимиты

Разбор идёт на `claude-opus-5` через **подписку Claude**, а не по API-ключу: вызовы входят
в стоимость подписки и отдельно не тарифицируются.

**Авторизация обязана быть OAuth-овой.** Если в окружении сервиса окажется `ANTHROPIC_API_KEY`,
CLI молча переключится на поштучную оплату по API — мимо подписки. Поэтому systemd-юнит гасит
эту переменную через `UnsetEnvironment`. Проверить, что всё по подписке:

```bash
ssh $BABYTRACKER_HOST 'systemctl --user show-environment | grep -i anthropic'   # должно быть пусто
ssh $BABYTRACKER_HOST 'claude setup-token'                                      # OAuth-логин
```

Раз денег за вызов нет, ограничителем становится **не счёт, а лимиты подписки**: они считаются
скользящими окнами, и исчерпав окно, воркер начнёт получать отказы. Поэтому:

- Воркер обязан отличать «лимит исчерпан» от настоящей ошибки и **ждать, а не жечь попытки**.
  Фраза остаётся в очереди и разбирается, когда окно откроется.
- Политика `LLM_QUEUE_POLICY=smart` (по умолчанию) оставлена, но уже по другой причине.
  Дело не в деньгах, а в том, что гонять Opus на уверенно распознанное «Андрей заснул» —
  это а) тратить окно лимита на то, что и так разобрано, б) давать модели повод «исправить»
  то, что не сломано. Меньше вмешательств в корректные данные — меньше сюрпризов.
- Хочешь максимальное качество и не жаль лимита — `LLM_QUEUE_POLICY=all`, одна строка в `.env`
  и рестарт. Ломаться ничего не должно: fast-path и так пишет события, модель лишь уточняет.

Сколько реально расходуется — видно в логах воркера, там же остаются отказы по лимиту:

```bash
ssh $BABYTRACKER_HOST 'journalctl --user -u babytracker | grep -iE "limit|usage"'
```
