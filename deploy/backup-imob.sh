#!/usr/bin/env bash
# Backup diário do Postgres do SDR IMOBILIÁRIO (fork) — roda como root na VPS.
# pg_dump lógico (consistente) + retenção 14 dias. Instalado no cron às 03:45
# (depois do backup da Central às 03:30). Restore:
#   gunzip -c ARQ.sql.gz | docker exec -i sdr-imob-postgres-1 psql -U postgres -d sdr_imob
set -euo pipefail

DEST=/root/backups-sdr-imob
CONTAINER=sdr-imob-postgres-1
DB=sdr_imob
STAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$DEST"
# tmp DENTRO do destino: mv atômico exige mesmo filesystem (achado Codex)
TMP=$(mktemp "$DEST/.tmp-$STAMP.XXXXXX")
trap 'rm -f "$TMP"' EXIT

docker exec "$CONTAINER" pg_dump -U postgres -d "$DB" --no-owner | gzip > "$TMP"
# sanity: dump vazio/aborto não pode sobrescrever a rotina em silêncio
[ "$(stat -c %s "$TMP")" -gt 10000 ] || { echo "ERRO: dump suspeito (<10KB)"; exit 1; }
mv "$TMP" "$DEST/sdr-imob-$STAMP.sql.gz"
trap - EXIT

find "$DEST" -name "sdr-imob-*.sql.gz" -mtime +14 -delete
echo "backup ok: sdr-imob-$STAMP.sql.gz ($(du -h "$DEST/sdr-imob-$STAMP.sql.gz" | cut -f1))"
