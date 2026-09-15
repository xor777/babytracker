#!/usr/bin/env bash
# Выкатывает BabyTracker на codex-vm. Идемпотентен.
# Запускать с Mac из корня репозитория: ./infra/deploy.sh
set -euo pipefail

HOST="${BABYTRACKER_HOST:-codex-vm}"
REMOTE_DIR="babytracker"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }

log "Синхронизирую код на $HOST:~/$REMOTE_DIR"
rsync -az --delete \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'data/' \
  --exclude 'dist/' --exclude 'build/' --exclude '.env' \
  --exclude 'apps/tv/' --exclude '*.apk' \
  "$LOCAL_DIR/" "$HOST:$REMOTE_DIR/"

log "Собираю и перезапускаю на $HOST"
ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
cd "$HOME/babytracker"

command -v node >/dev/null || { echo "Node не найден. Сначала запусти infra/bootstrap-vm.sh" >&2; exit 1; }

# .env создаём один раз и больше не трогаем — секрет вебхука должен пережить деплой,
# иначе после каждой выкатки пришлось бы менять URL в консоли Яндекс Диалогов.
if [ ! -f .env ]; then
  echo "==> Создаю .env и генерирую секрет вебхука"
  SECRET=$(openssl rand -hex 16)
  sed -e "s|^ALICE_WEBHOOK_SECRET=.*|ALICE_WEBHOOK_SECRET=$SECRET|" \
      -e "s|^DB_PATH=.*|DB_PATH=$HOME/babytracker/data/babytracker.db|" \
      .env.example > .env
  chmod 600 .env
fi
mkdir -p data

echo "==> pnpm install"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "==> сборка"
pnpm --filter ./apps/server build
pnpm --filter ./apps/dashboard build

echo "==> systemd"
mkdir -p "$HOME/.config/systemd/user"
cp infra/systemd/babytracker.service        "$HOME/.config/systemd/user/"
cp infra/systemd/babytracker-tunnel.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now babytracker.service babytracker-tunnel.service
systemctl --user restart babytracker.service

sleep 3
echo "==> статус"
systemctl --user --no-pager --lines=0 status babytracker.service        | head -5 || true
systemctl --user --no-pager --lines=0 status babytracker-tunnel.service | head -5 || true

echo "==> healthz"
curl -fsS --max-time 5 http://localhost:8787/healthz || echo "healthz не ответил"
echo
REMOTE

log "Жду, пока туннель поднимет публичный адрес"
sleep 6
ssh "$HOST" 'bash ~/babytracker/infra/tunnel-url.sh' || true

log "Готово."
