#!/usr/bin/env bash
# Настраивает автодеплой по коммиту. Запускать с Mac, один раз.
#
#   BABYTRACKER_HOST=baby-prod GITHUB_REPO=xor777/babytracker ./infra/setup-ci.sh
#
# Схема с двумя разными ключами — намеренно:
#   CI  -> сервер : ed25519, прибит forced command к ci-deploy.sh.
#                   Утёк секрет из Actions — атакующий может только выкатить
#                   main, но не получить шелл.
#   сервер -> GitHub : отдельный read-only deploy key. Сервер умеет только
#                   читать репозиторий и ничего не может в него записать.
# Личный ключ из 1Password в GitHub не попадает вообще.
set -euo pipefail

HOST="${BABYTRACKER_HOST:?укажи BABYTRACKER_HOST}"
REPO="${GITHUB_REPO:?укажи GITHUB_REPO в виде owner/repo}"
SSH_USER="${DEPLOY_USER:-dmitry}"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }

# ---------- 1. Ключ CI -> сервер ----------
log "Генерирую ключ CI -> сервер"
ssh-keygen -t ed25519 -N '' -C "babytracker-ci" -f "$WORK/ci_key" -q

log "Прописываю его на сервере с forced command"
ssh "$HOST" bash -s -- "$(cat "$WORK/ci_key.pub")" <<'REMOTE'
set -euo pipefail
# ssh склеивает аргументы в одну строку, и удалённый шелл разбирает её заново —
# кавычки теряются, поэтому публичный ключ приезжает разбитым на слова.
# Собираем обратно через "$*", иначе в authorized_keys ляжет огрызок "ssh-ed25519".
PUB="$*"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
# Старую запись убираем, чтобы повторный запуск не плодил дубликаты
grep -v 'babytracker-ci' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.new || true
cat >> ~/.ssh/authorized_keys.new <<LINE
command="$HOME/babytracker/infra/ci-deploy.sh",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding $PUB
LINE
mv ~/.ssh/authorized_keys.new ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Проверяем, что ключ приехал целиком, а не огрызком
if ! grep -q 'babytracker-ci$' ~/.ssh/authorized_keys; then
  echo "ОШИБКА: публичный ключ записан не полностью" >&2
  grep -o 'ssh-ed25519.*' ~/.ssh/authorized_keys >&2
  exit 1
fi
echo "authorized_keys обновлён, ключ записан целиком"
REMOTE

# ---------- 2. Ключ сервер -> GitHub ----------
log "Генерирую read-only deploy key сервер -> GitHub"
ssh "$HOST" 'test -f ~/.ssh/github_babytracker || ssh-keygen -t ed25519 -N "" -C "babytracker-server" -f ~/.ssh/github_babytracker -q; cat ~/.ssh/github_babytracker.pub' > "$WORK/server_gh.pub"

ssh "$HOST" 'grep -q "github_babytracker" ~/.ssh/config 2>/dev/null || printf "\nHost github.com\n  IdentityFile ~/.ssh/github_babytracker\n  IdentitiesOnly yes\n" >> ~/.ssh/config; chmod 600 ~/.ssh/config'

log "Регистрирую deploy key в $REPO (только чтение)"
gh repo deploy-key delete -R "$REPO" \
  "$(gh repo deploy-key list -R "$REPO" --json id,title -q '.[]|select(.title=="babytracker-server")|.id' 2>/dev/null || true)" 2>/dev/null || true
gh repo deploy-key add "$WORK/server_gh.pub" -R "$REPO" -t "babytracker-server"

# ---------- 3. Первый клон на сервере ----------
log "Клонирую репозиторий на сервер"
ssh "$HOST" "set -e
  ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
  sort -u ~/.ssh/known_hosts -o ~/.ssh/known_hosts
  if [ -d ~/babytracker/.git ]; then
    cd ~/babytracker && git remote set-url origin git@github.com:$REPO.git && git fetch --quiet origin
  else
    # .env и data уже могли появиться от ручного деплоя — сохраняем
    mkdir -p ~/babytracker
    cd ~/babytracker && git init -q && git remote add origin git@github.com:$REPO.git 2>/dev/null || true
    git fetch --quiet origin main && git reset --hard --quiet origin/main
  fi
  echo 'репозиторий на месте:' \$(git -C ~/babytracker rev-parse --short HEAD)"

# ---------- 4. Секреты GitHub ----------
log "Заполняю секреты в $REPO"
gh secret set DEPLOY_SSH_KEY   -R "$REPO" < "$WORK/ci_key"
gh secret set DEPLOY_HOST      -R "$REPO" --body "$(ssh -G "$HOST" | awk '/^hostname /{print $2}')"
gh secret set DEPLOY_USER      -R "$REPO" --body "$SSH_USER"
ssh-keyscan -t ed25519,rsa "$(ssh -G "$HOST" | awk '/^hostname /{print $2}')" 2>/dev/null \
  | gh secret set DEPLOY_KNOWN_HOSTS -R "$REPO"

log "Проверяю, что forced command работает"
ssh -i "$WORK/ci_key" -o IdentitiesOnly=yes -o BatchMode=yes "$SSH_USER@$(ssh -G "$HOST" | awk '/^hostname /{print $2}')" 'id' 2>&1 | head -5 \
  && log "выше должен быть вывод ci-deploy.sh, а не результат 'id' — тогда forced command на месте"

log "Готово. Пуш в main теперь выкатывает прод."
