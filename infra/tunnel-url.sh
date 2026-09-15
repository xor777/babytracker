#!/usr/bin/env bash
# Достаёт текущий публичный URL быстрого туннеля из journald и печатает
# готовый адрес вебхука для вставки в консоль Яндекс Диалогов.
set -euo pipefail
SECRET=$(grep -E '^ALICE_WEBHOOK_SECRET=' "$HOME/babytracker/.env" 2>/dev/null | cut -d= -f2- || true)
URL=$(journalctl --user -u babytracker-tunnel --since "-24h" --no-pager 2>/dev/null \
      | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
if [ -z "$URL" ]; then
  echo "Публичный URL не найден. Туннель запущен? systemctl --user status babytracker-tunnel" >&2
  exit 1
fi
echo "Публичный адрес : $URL"
echo "Дашборд         : $URL/"
if [ -n "$SECRET" ]; then
  echo "Webhook URL     : $URL/alice/$SECRET"
  echo
  echo "Вставь Webhook URL в консоль Яндекс Диалогов, поле «Backend»."
else
  echo "ALICE_WEBHOOK_SECRET не найден в ~/babytracker/.env" >&2
fi
