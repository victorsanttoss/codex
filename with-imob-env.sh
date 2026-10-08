#!/usr/bin/env bash
# Executa qualquer comando com o ambiente do FORK imobiliário (.env + isolamento).
# Uso: ./with-imob-env.sh pnpm db:migrate
# Existe para que nenhum comando de banco rode por engano contra o projeto original.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
. ./env.imob.sh
exec "$@"
