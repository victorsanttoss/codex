#!/usr/bin/env bash
# Deploy do FORK IMOBILIÁRIO numa VPS que JÁ roda o projeto original.
# Build → migrate (node dist, sem wrapper de dev — revisão Codex) → recreate
# worker/scheduler/session-worker → api → web → smoke via loopback.
# O proxy/TLS público é do Caddy JÁ EXISTENTE na VPS (fora deste compose).
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"
API_SCALE="${API_SCALE:-1}" # VPS compartilhada: 1 réplica por padrão

echo "==> Build das imagens (sdr-imob-app / sdr-imob-web)"
$COMPOSE build

echo "==> Sobe infra (postgres/redis) e aplica migrations (role migrator)"
$COMPOSE up -d postgres redis
# `run --no-deps` NÃO espera healthcheck e o 1º boot do postgres leva ~20s
# inicializando roles — espera explícita (aprendido no 1º deploy real):
echo "==> Aguardando postgres ficar pronto"
for i in $(seq 1 45); do
  $COMPOSE exec -T postgres pg_isready -q -d "${POSTGRES_DB:-sdr_imob}" 2>/dev/null && break
  [ "$i" = 45 ] && { echo "postgres não ficou pronto em 90s"; exit 1; }
  sleep 2
done
# node dist/migrate.js: roda na PRÓPRIA imagem prod (tsx é devDependency e não
# existe na imagem — achado da revisão final do Codex). O runner é idempotente.
$COMPOSE run --rm --no-deps -T scheduler node /repo/packages/db/dist/migrate.js

echo "==> Recria worker/scheduler/session-worker com a imagem nova"
$COMPOSE up -d --force-recreate --no-deps worker scheduler session-worker-0

echo "==> Recria api (${API_SCALE} réplica[s])"
$COMPOSE up -d --force-recreate --no-deps --scale api="$API_SCALE" api

echo "==> Recria o painel web (Next)"
$COMPOSE up -d --force-recreate --no-deps web

echo "==> Smoke via loopback (o Caddy da VPS aponta para estas portas)"
sleep 8
curl -fsS http://127.0.0.1:3101/health | grep -q '"ok"' \
  && echo "Smoke api OK (127.0.0.1:3101)" \
  || { echo "SMOKE DA API FALHOU — investigar (docker compose -f docker-compose.prod.yml logs api)"; exit 1; }
curl -fsS -o /dev/null http://127.0.0.1:3100 \
  && echo "Smoke web OK (127.0.0.1:3100)" \
  || { echo "SMOKE DO WEB FALHOU — investigar"; exit 1; }

echo "==> Deploy do fork concluído."

# ── ROLLBACK ───────────────────────────────────────────────────────────────
#  git checkout <commit-anterior> && ./deploy/deploy.sh
#  Migrations: forward-only — para reverter schema, escreva migration de
#  compensação (nova). NUNCA edite migration já aplicada.
#  Incidente grave: docker compose -f docker-compose.prod.yml down (mantém
#  volumes; NÃO afeta o projeto original — project name sdr-imob é exclusivo).
