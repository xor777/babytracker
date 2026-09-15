#!/usr/bin/env bash
# Одноразовая подготовка сервера. Идемпотентен — безопасно запускать повторно.
#
# Приложение целиком живёт в ~/.local и systemd --user: без root, без Docker.
# Sudo нужен только для двух системных вещей — Caddy (ему нужны порты 80/443)
# и правил ufw. Если sudo нет, скрипт про них скажет и пойдёт дальше.
#
# Переменная BABYTRACKER_DOMAIN включает выпуск TLS-сертификата для этого домена.
set -euo pipefail

DOMAIN="${BABYTRACKER_DOMAIN:-}"

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

# ---------- lingering ----------
# Без него systemd гасит пользовательские сервисы вместе с последней сессией:
# вышел по ssh — сервер выключился. Обязательный шаг, не косметика.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  if sudo -n true 2>/dev/null; then
    log "Включаю lingering, чтобы сервисы жили без ssh-сессии"
    sudo loginctl enable-linger "$USER"
  else
    log "ВНИМАНИЕ: нет sudo — выполни вручную: sudo loginctl enable-linger $USER"
  fi
fi

# ---------- Caddy: HTTPS c автоматическим Let's Encrypt ----------
# Нужен root: порты 80/443 привилегированные, а сертификаты должны обновляться
# сами, без участия человека.
if [ -z "$DOMAIN" ]; then
  log "BABYTRACKER_DOMAIN не задан — пропускаю настройку Caddy и TLS"
elif ! sudo -n true 2>/dev/null; then
  log "ВНИМАНИЕ: нет passwordless sudo — Caddy и ufw пропущены, настрой их руками"
else
  if ! command -v caddy >/dev/null 2>&1; then
    log "Ставлю Caddy"
    sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo apt-get update -qq && sudo apt-get install -y -qq caddy
  fi
  log "caddy $(caddy version 2>&1 | head -1)"

  log "Настраиваю Caddy на домен $DOMAIN"

  # Basic Auth. Пароль задаётся через BABYTRACKER_AUTH_PASSWORD; хеш живёт в
  # отдельном файле и переживает повторные запуски — иначе каждый провижининг
  # менял бы пароль и ломал уже настроенный телевизор.
  AUTH_USER="${BABYTRACKER_AUTH_USER:-dmitry}"
  HASH_FILE="$HOME/.config/babytracker-auth.hash"
  if [ -n "${BABYTRACKER_AUTH_PASSWORD:-}" ]; then
    caddy hash-password --plaintext "$BABYTRACKER_AUTH_PASSWORD" > "$HASH_FILE"
    chmod 600 "$HASH_FILE"
    log "хеш пароля обновлён"
  fi
  if [ -s "$HASH_FILE" ]; then
    # Caddyfile не принимает блок в одну строку — собираем с реальными
    # переводами строк, иначе конфиг молча остаётся старым.
    AUTH_BLOCK=$(printf 'basic_auth {\n\t\t\t%s %s\n\t\t}' "$AUTH_USER" "$(cat "$HASH_FILE")")
    log "аутентификация включена, пользователь $AUTH_USER"
  else
    AUTH_BLOCK=""
    log "ВНИМАНИЕ: пароль не задан — сайт настраивается БЕЗ аутентификации."
    log "         Задай BABYTRACKER_AUTH_PASSWORD и запусти скрипт повторно."
  fi

  sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
# BabyTracker. Сертификат Let's Encrypt Caddy получает и продлевает сам.
# Логи — в journald: journalctl -u caddy
$DOMAIN {
	encode gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options SAMEORIGIN
		Referrer-Policy no-referrer
		-Server
	}

	# Без аутентификации ровно два пути: вебхук Алисы (она не умеет basic auth,
	# её защищает секрет в URL) и healthz для выкатки и мониторинга.
	@open path /alice/* /healthz
	handle @open {
		reverse_proxy localhost:8787
	}

	# Всё остальное — история ребёнка и возможность её менять. Под паролем.
	handle {
		$AUTH_BLOCK
		reverse_proxy localhost:8787 {
			# SSE: дашборд держит поток часами, буферизация его убьёт
			flush_interval -1
			transport http {
				read_timeout 24h
			}
		}
	}
}
CADDY
  if ! sudo caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -2; then
    log "ОШИБКА: конфиг Caddy невалиден, не применяю"; exit 1
  fi
  sudo systemctl enable --now caddy
  # reload не перезапускает процесс; если конфиг не принят — падаем на restart,
  # чтобы не остаться молча на старом конфиге
  sudo systemctl reload caddy || sudo systemctl restart caddy
  sleep 2

  # ---------- ufw ----------
  # Фаервол настроен в режиме deny incoming: без этих правил Let's Encrypt
  # не пройдёт HTTP-01 проверку и сертификат не выпустится.
  if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
    log "Открываю 80/443 в ufw (нужно для Let's Encrypt и самого сервиса)"
    sudo ufw allow 80/tcp  >/dev/null
    sudo ufw allow 443/tcp >/dev/null
    sudo ufw status numbered | head -12
  fi
fi

log "Готово."
echo
echo "Осталось сделать вручную:"
echo "  1) claude setup-token                  — авторизовать CLI через подписку (нужен браузер)"
echo "  2) BABYTRACKER_HOST=... ./infra/deploy.sh — выкатить код"
