#!/usr/bin/env bash
# Выкатка на сервере. Запускается CI по SSH как forced command — поэтому
# утёкший CI-ключ даёт не шелл, а ровно этот сценарий и ничего больше.
# Возможные аргументы от клиента ($SSH_ORIGINAL_COMMAND) намеренно игнорируются.
set -euo pipefail

REPO_DIR="$HOME/babytracker"
BRANCH="${DEPLOY_BRANCH:-main}"
HEALTH_URL="http://localhost:8787/healthz"

export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
log() { printf '\033[36m==>\033[0m %s\n' "$*"; }

cd "$REPO_DIR"

PREV=$(git rev-parse HEAD)
log "текущая ревизия $PREV"

log "забираю $BRANCH"
git fetch --quiet origin "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"
NEXT=$(git rev-parse HEAD)

if [ "$PREV" = "$NEXT" ]; then
  log "изменений нет, но сервис всё равно перезапущу для консистентности"
fi
log "выкатываю $NEXT — $(git log -1 --pretty=%s)"

# 1 ядро и 950 МБ RAM: без ограничения heap сборка уходит в swap и может
# словить OOM. Swap на машине есть, но лучше в него не упираться.
export NODE_OPTIONS="--max-old-space-size=512"

# .env создаётся один раз и больше не трогается: секрет вебхука должен пережить
# любую выкатку, иначе URL в консоли Яндекс Диалогов пришлось бы переписывать.
if [ ! -f .env ]; then
  log "первый запуск: создаю .env и генерирую секрет вебхука"
  SECRET=$(openssl rand -hex 16)
  sed -e "s|^ALICE_WEBHOOK_SECRET=.*|ALICE_WEBHOOK_SECRET=$SECRET|" \
      -e "s|^DB_PATH=.*|DB_PATH=$HOME/babytracker/data/babytracker.db|" \
      .env.example > .env
  chmod 600 .env
fi
mkdir -p data

# Юниты ставим на каждой выкатке: так правки в infra/systemd/ доезжают до прода
# сами, а не ждут, пока кто-то вспомнит про них и скопирует руками.
log "systemd-юниты"
mkdir -p "$HOME/.config/systemd/user"
cp infra/systemd/babytracker.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable babytracker.service >/dev/null 2>&1 || true

log "зависимости"
pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -3

log "сборка дашборда"
pnpm --filter ./apps/dashboard build 2>&1 | tail -3

log "перезапуск"
systemctl --user restart babytracker.service

# --- проверка здоровья с откатом ---
ok=false
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then ok=true; break; fi
  sleep 1
done

if [ "$ok" = true ]; then
  log "здоров: $(curl -fsS --max-time 3 "$HEALTH_URL")"
  log "готово, версия $NEXT"
  exit 0
fi

# Сервис не поднялся. Это семейный трекер, он должен работать: откатываемся
# на предыдущую рабочую ревизию, а не оставляем всё лежать до утра.
log "ЗДОРОВЬЕ НЕ ПОДТВЕРЖДЕНО — откатываюсь на $PREV"
git reset --hard --quiet "$PREV"
pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1 || true
pnpm --filter ./apps/dashboard build >/dev/null 2>&1 || true
systemctl --user restart babytracker.service
sleep 5

if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
  log "откат удался, работает предыдущая версия $PREV"
else
  log "откат НЕ помог — сервис лежит, нужна ручная разборка"
  journalctl --user -u babytracker --no-pager -n 30 || true
fi
exit 1
