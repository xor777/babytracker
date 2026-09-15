# Развёртывание

Прод — `codex-vm` (Ubuntu 24.04, 8 ядер, 15 ГБ RAM, **~6 ГБ свободного диска**), доступна
через Tailscale как `codex-vm`.

## Почему именно так

Несколько решений, принятых из-за особенностей этой машины — чтобы они не выглядели произволом:

- **Без Docker.** Docker на VM требует sudo, а worker'у нужен авторизованный `claude` CLI
  с домашним каталогом пользователя — в контейнере это лишняя возня с пробросом токенов.
  Обычные systemd-сервисы пользователя проще и надёжнее.
- **`systemctl --user` вместо системных юнитов.** `Linger=yes` уже включён, поэтому сервисы
  стартуют при загрузке машины и живут без активной сессии. Sudo для управления не нужен.
- **`node:sqlite` вместо `better-sqlite3`.** На диске ~6 ГБ и нет C++ тулчейна; нативный
  модуль там собирать нечем. Встроенный в Node драйвер не требует компиляции вообще.
- **Cloudflare Tunnel.** У VM нет публичного IP (eth0 в 10.20.10.20/24, наружу через NAT).
  Tailscale Funnel не годится: тайлнет на кастомном домене `tail.nuanu.ai`, а Funnel работает
  только с `*.ts.net`.
- **Порт 8787.** Порт 3000 на машине уже занят другим процессом.

## Первый запуск

```bash
# 1. Подготовить машину: Node 24, pnpm, cloudflared, claude CLI. Идемпотентно.
./infra/bootstrap-vm.sh        # либо: ssh codex-vm 'bash -s' < infra/bootstrap-vm.sh

# 2. Авторизовать claude CLI (нужен браузер). Без этого LLM-разбор
#    будет пропускаться, но сервер и fast-path продолжат работать.
ssh -t codex-vm 'claude setup-token'

# 3. Выкатить код, собрать, поднять сервисы
./infra/deploy.sh

# 4. Узнать публичный адрес вебхука
ssh codex-vm 'bash ~/babytracker/infra/tunnel-url.sh'
```

Дальше — [ALICE_SETUP.md](ALICE_SETUP.md).

## Повседневное

```bash
./infra/deploy.sh                                          # выкатить изменения
ssh codex-vm 'journalctl --user -u babytracker -f'         # логи сервера
ssh codex-vm 'journalctl --user -u babytracker-tunnel -f'  # логи туннеля
ssh codex-vm 'systemctl --user restart babytracker'
ssh codex-vm 'curl -s localhost:8787/healthz | jq'
```

`.env` на сервере создаётся один раз при первом деплое и **больше не перезаписывается** —
иначе секрет вебхука менялся бы при каждой выкатке, и URL в консоли Яндекса пришлось бы
переписывать. Менять его руками: `ssh codex-vm 'nano ~/babytracker/.env'` + рестарт.

## Постоянный домен вместо случайного

Быстрый туннель выдаёт новый `*.trycloudflare.com` при каждом перезапуске. Как только надоест
править URL в консоли Диалогов — переходи на именованный туннель. Нужен аккаунт Cloudflare и
домен, делегированный на их NS.

```bash
ssh -t codex-vm
cloudflared tunnel login                        # откроется браузер
cloudflared tunnel create babytracker
cloudflared tunnel route dns babytracker baby.example.com
```

Затем `~/.cloudflared/config.yml`:

```yaml
tunnel: babytracker
credentials-file: /home/dmitry/.cloudflared/<UUID>.json
ingress:
  - hostname: baby.example.com
    service: http://localhost:8787
  - service: http_status:404
```

И в `infra/systemd/babytracker-tunnel.service` заменить строку `ExecStart` на
`%h/.local/bin/cloudflared tunnel --no-autoupdate run babytracker`, после чего
`./infra/deploy.sh`. Адрес вебхука станет постоянным.

## Резервные копии

Все данные — один файл `~/babytracker/data/babytracker.db`. Это история жизни ребёнка,
восстановить её неоткуда: бэкап нужен, и лучше не откладывать.

```bash
# Корректный бэкап работающей базы (просто cp при включённом WAL может дать битый файл)
ssh codex-vm 'sqlite3 ~/babytracker/data/babytracker.db ".backup ~/baby-backup.db"'
scp codex-vm:~/baby-backup.db ./backups/baby-$(date +%F).db
```

## Деньги

Каждая непонятая fast-path'ом фраза запускает `claude -p`. Один замер на VM дал
**около $0.09 за вызов** — основное съедает разовая загрузка системного промпта.
При 30 фразах в день это порядка $80 в месяц, что для домашнего проекта многовато.

Чем сбивать, по возрастанию усилий:

1. `CLAUDE_MODEL=claude-haiku-4-5-20251001` — разбор коротких русских фраз haiku тянет
   уверенно, а стоит кратно дешевле. **Начни с этого.**
2. Расширять fast-path: каждая фраза, которую он научился понимать сам, стоит ноль.
3. Если станет критично — заменить spawn CLI на прямой вызов Messages API с
   кэшированием промпта, без накладных расходов на системный промпт агента.

Следить за расходом: `ssh codex-vm 'journalctl --user -u babytracker | grep cost'`.
