#!/usr/bin/env bash
# Одноразовая подготовка codex-vm. Идемпотентен — безопасно запускать повторно.
# Ничего не ставит системно: всё живёт в ~/.local, сервисы — systemd --user.
set -euo pipefail

NODE_MAJOR=24
PREFIX="$HOME/.local"
BIN="$PREFIX/bin"
mkdir -p "$BIN"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }

# ---------- Node ----------
if [ -x "$PREFIX/node/bin/node" ] && "$PREFIX/node/bin/node" -v | grep -q "^v${NODE_MAJOR}\."; then
  log "Node $("$PREFIX/node/bin/node" -v) уже установлен"
else
  log "Определяю последнюю версию Node ${NODE_MAJOR}.x"
  VER=$(curl -fsSL https://nodejs.org/dist/index.json \
        | grep -o "\"version\":\"v${NODE_MAJOR}\.[0-9.]*\"" | head -1 | cut -d'"' -f4)
  [ -n "$VER" ] || { echo "не удалось определить версию Node" >&2; exit 1; }
  log "Ставлю Node $VER в $PREFIX/node"
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://nodejs.org/dist/${VER}/node-${VER}-linux-x64.tar.xz" -o "$TMP/node.tar.xz"
  rm -rf "$PREFIX/node"; mkdir -p "$PREFIX/node"
  tar -xJf "$TMP/node.tar.xz" -C "$PREFIX/node" --strip-components=1
fi
export PATH="$PREFIX/node/bin:$BIN:$PATH"
ln -sf "$PREFIX/node/bin/node" "$BIN/node"
ln -sf "$PREFIX/node/bin/npm"  "$BIN/npm"
ln -sf "$PREFIX/node/bin/npx"  "$BIN/npx"

# node:sqlite — единственная причина требовать Node >= 24. Проверяем сразу,
# чтобы не выяснять это уже во время деплоя.
log "Проверяю встроенный node:sqlite"
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('create table t(x)');console.log('node:sqlite OK')"

# ---------- pnpm ----------
if ! command -v pnpm >/dev/null 2>&1; then
  log "Ставлю pnpm"
  npm install -g pnpm@10 --silent
  ln -sf "$PREFIX/node/bin/pnpm" "$BIN/pnpm" 2>/dev/null || true
fi
log "pnpm $(pnpm -v)"

# ---------- cloudflared ----------
# VM за NAT, публичного IP нет, Tailscale Funnel на кастомном тайлнете недоступен.
# Cloudflare Tunnel — способ дать Алисе валидный публичный HTTPS.
if [ ! -x "$BIN/cloudflared" ]; then
  log "Ставлю cloudflared"
  curl -fsSL -o "$BIN/cloudflared" \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$BIN/cloudflared"
fi
log "cloudflared $("$BIN/cloudflared" --version 2>&1 | head -1)"

# ---------- claude CLI ----------
if ! command -v claude >/dev/null 2>&1; then
  log "Ставлю Claude Code CLI"
  npm install -g @anthropic-ai/claude-code --silent
  ln -sf "$PREFIX/node/bin/claude" "$BIN/claude" 2>/dev/null || true
fi
if command -v claude >/dev/null 2>&1; then
  log "claude $(claude --version 2>&1 | head -1)"
else
  log "ВНИМАНИЕ: claude CLI не установился. Сервер будет работать без LLM-разбора."
fi

# ---------- PATH в профиле ----------
if ! grep -q 'babytracker PATH' "$HOME/.profile" 2>/dev/null; then
  log "Прописываю PATH в ~/.profile"
  { echo ''; echo '# babytracker PATH'; echo "export PATH=\"$PREFIX/node/bin:$BIN:\$PATH\""; } >> "$HOME/.profile"
fi

mkdir -p "$HOME/.config/systemd/user" "$HOME/babytracker/data"

log "Готово."
echo
echo "Осталось сделать вручную (нужен твой браузер):"
echo "  1) claude setup-token   — авторизовать CLI, иначе LLM-разбор будет пропускаться"
echo "  2) infra/deploy.sh      — выкатить код"
