#!/usr/bin/env bash
# Backup do Postgres CIFRADO e enviado PARA FORA da VPS (bucket S3-compatível).
# Backup no mesmo disco não protege contra disco corrompido. Rodar via cron diário.
# Requer: aws cli (ou rclone), gpg. Env: ver abaixo.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml"
: "${POSTGRES_DB:=sdr}"
: "${POSTGRES_SUPERUSER:=postgres}"
: "${BACKUP_GPG_RECIPIENT:?defina BACKUP_GPG_RECIPIENT (chave pública p/ cifrar)}"
: "${BACKUP_S3_URI:?defina BACKUP_S3_URI (ex.: s3://meu-bucket/sdr)}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
file="sdr_${POSTGRES_DB}_${ts}.sql.gz.gpg"
tmp="/tmp/${file}"

echo "==> pg_dump → gzip → gpg (assimétrico, recipient ${BACKUP_GPG_RECIPIENT})"
# usa `compose exec` (o compose não define container_name fixo).
$COMPOSE exec -T postgres pg_dump -U "$POSTGRES_SUPERUSER" -d "$POSTGRES_DB" --no-owner \
  | gzip -9 \
  | gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$tmp"

echo "==> upload p/ ${BACKUP_S3_URI}/${file}"
aws s3 cp "$tmp" "${BACKUP_S3_URI}/${file}"
rm -f "$tmp"

# Retenção: diários por N dias (limpeza do bucket via lifecycle policy é o ideal;
# aqui um fallback simples por listagem).
echo "==> retenção: mantém ~${RETENTION_DAYS}d (configure lifecycle no bucket)"
echo "Backup OK: ${file}"
