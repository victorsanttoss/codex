#!/usr/bin/env bash
# Sobe o stack LOCAL completo de dev com tudo que não mora no .env (protegido):
# embeddings + LLM via Ollama, Baileys ligado. Uso: ./dev-local.sh
# Pré-requisitos: docker (postgres/redis) e `ollama serve` rodando, com os
# modelos `bge-m3` e `qwen2.5:3b` baixados (ollama pull ...).
set -euo pipefail
cd "$(dirname "$0")"

# segredos e config base
set -a; . ./.env; set +a

# isolamento do fork imobiliário (Postgres 5433/sdr_imob, Redis 6380)
. ./env.imob.sh

# Embeddings (bge-m3, dim 1024) via Ollama OpenAI-compat.
# CPU-only: ~3s/chunk → lote pequeno + timeout folgado, senão a ingestão de
# documento estoura o default (15s) e o upload da base de conhecimento FALHA.
export EMBEDDINGS_BASE_URL=http://localhost:11434/v1
export EMBEDDINGS_MODEL=bge-m3
export EMBEDDINGS_API_KEY=ollama
export EMBEDDINGS_DIM=1024
export EMBEDDINGS_MAX_BATCH=8
export EMBEDDINGS_TIMEOUT_MS=180000

# Chat do agente: OpenAI real quando houver OPENAI_API_KEY no .env; senão
# Ollama local (a chave Anthropic do .env é inválida=401). Modelo OpenAI
# customizável via OPENAI_MODEL no .env (default gpt-5.4-mini — geração atual,
# escolha custo-benefício p/ SDR; precisa existir no DEFAULT_PRICING do router).
if [ -n "${OPENAI_API_KEY:-}" ]; then
  export LLM_OPENAI_BASE_URL=https://api.openai.com/v1
  export LLM_OPENAI_API_KEY="$OPENAI_API_KEY"
  export LLM_DEFAULT_MODELS="${OPENAI_MODEL:-gpt-5.4-mini}"
  LLM_LABEL="OpenAI ($LLM_DEFAULT_MODELS)"
else
  export LLM_OPENAI_BASE_URL=http://localhost:11434/v1
  export LLM_OPENAI_API_KEY=ollama
  export LLM_DEFAULT_MODELS=qwen2.5:3b
  LLM_LABEL="Ollama local (qwen2.5:3b) — defina OPENAI_API_KEY no .env p/ usar OpenAI"
fi

# WhatsApp não-oficial (Baileys / QR) ligado; role=all já roda o session-worker
export BAILEYS_ENABLED=1

# Integração de leitura da plataforma (Central Menin): allowlist de tenants.
# Default dev = tenant piloto Parque das Flores (uuid não é segredo).
export IMOB_PLATFORM_READ_TENANTS="${IMOB_PLATFORM_READ_TENANTS:-6d6b6b20-1981-4f1b-b46a-52a7a421ecec,c7db22b3-434c-4e5e-8e67-489b6b6dcf00}"

# Entrada de leads de campanha (Meta Lead Ads / integrações) — defaults de DEV.
# Em produção: token forte + allowlist real (e META_* p/ o webhook direto).
export LEAD_INTAKE_TOKEN="${LEAD_INTAKE_TOKEN:-dev-intake-token}"
export LEAD_INTAKE_TENANTS="${LEAD_INTAKE_TENANTS:-6d6b6b20-1981-4f1b-b46a-52a7a421ecec,c7db22b3-434c-4e5e-8e67-489b6b6dcf00}"

echo "▶ LLM: $LLM_LABEL"
echo "▶ subindo api :3101 + web :3100 (fork imob — o padrão usa 3001/3000)…"
exec pnpm dev
