#!/usr/bin/env bash
# Alertas do SDR IMOBILIÁRIO no Telegram (gestor) — roda como root na VPS via
# cron (*/5min). Varre a tabela `notifications` (todas as tenants; alertas de
# negócio: lead sem corretor, corretor sem resposta, lead da Meta não
# importado…) e envia as NOVAS desde o último envio (estado por timestamp).
# Envio via openclaw (gateway da Bia, já autenticado no Telegram — sem token
# próprio). Config em /root/.sdr-imob-alerts.env: TELEGRAM_ALERT_CHAT_ID.
set -euo pipefail

ENV_FILE=/root/.sdr-imob-alerts.env
STATE=/root/.sdr-imob-alerts-state
LOCK=/root/.sdr-imob-alerts.lock
CONTAINER=sdr-imob-postgres-1
DB=sdr_imob
# node ≥22.22.3 do usuário victor (o node do sistema é mais velho e o CLI recusa)
OPENCLAW_PATH=/home/victor/.local/bin:/home/victor/.npm-global/bin

# lock: execução anterior pendurada não pode sobrepor (achado Codex)
exec 9>"$LOCK"
flock -n 9 || exit 0

# shellcheck disable=SC1090
source "$ENV_FILE"
: "${TELEGRAM_ALERT_CHAT_ID:?configure em $ENV_FILE}"

LAST=$(cat "$STATE" 2>/dev/null || echo "")
# estado corrompido não pode virar injeção/erro em loop (achado Codex):
# só timestamp ISO estrito passa; senão recomeça de agora
if ! [[ "$LAST" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]]; then
  LAST=$(date -u +%Y-%m-%dT%H:%M:%SZ) # 1ª execução: só o que vier daqui p/ frente
fi

# título/corpo achatados no SQL (TAB/quebras → espaço): o loop lê por linha
ROWS=$(timeout 30 docker exec "$CONTAINER" psql -U postgres -d "$DB" -tA -F $'\t' -c "
  SELECT to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),
         regexp_replace(title, E'[\\t\\r\\n]+', ' ', 'g'),
         regexp_replace(left(body, 400), E'[\\t\\r\\n]+', ' ', 'g')
  FROM notifications
  WHERE created_at > '${LAST}'::timestamptz
  ORDER BY created_at
  LIMIT 20;")

if [ -z "$ROWS" ]; then
  printf '%s' "$LAST" > "$STATE"
  exit 0
fi

NOVO_LAST="$LAST"
while IFS=$'\t' read -r ts title body; do
  [ -n "$ts" ] || continue
  # mensagem via env (não via interpolação no bash -c: título/corpo podem ter
  # aspas). Falha de envio NÃO avança o estado (re-tenta no próximo tick).
  if MSG="🏠 SDR Imobiliário — ${title}: ${body}" timeout 25 \
    sudo --preserve-env=MSG -u victor bash -c \
    "export PATH=${OPENCLAW_PATH}:\$PATH; openclaw message send --channel telegram --target ${TELEGRAM_ALERT_CHAT_ID} --message \"\$MSG\"" > /dev/null 2>&1; then
    NOVO_LAST="$ts"
  else
    break # para na primeira falha; estado fica no último ENVIADO
  fi
done <<< "$ROWS"

printf '%s' "$NOVO_LAST" > "$STATE"
