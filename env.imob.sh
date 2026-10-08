# Isolamento do fork imobiliário — carregar SEMPRE depois do .env.
# O .env é compartilhado com o projeto padrão (protegido, não editar); aqui
# FORÇAMOS o runtime do fork para Postgres localhost:5433/sdr_imob e Redis
# localhost:6380 via parser de URL do Node — substituição textual é frágil
# (':5432' pode aparecer em senha; porta/banco do .env podem divergir).
# Fail-closed: host não-local aborta — o fork nunca deve alcançar o runtime
# do projeto original nem qualquer banco remoto.

_imob_force_url() { # $1 url, $2 porta, $3 pathname ('' = manter o original)
  node -e '
    const u = new URL(process.argv[1]);
    u.port = process.argv[2];
    if (process.argv[3]) u.pathname = process.argv[3];
    if (!["localhost", "127.0.0.1"].includes(u.hostname)) {
      console.error(`env.imob.sh: host nao-local na URL (${u.hostname}) — abortando por seguranca`);
      process.exit(1);
    }
    process.stdout.write(u.href);
  ' "$1" "$2" "$3"
}

DATABASE_URL="$(_imob_force_url "${DATABASE_URL:-postgres://sdr_app:sdr_app_pw@localhost:5432/sdr}" 5433 /sdr_imob)"
MIGRATION_DATABASE_URL="$(_imob_force_url "${MIGRATION_DATABASE_URL:-postgres://sdr_migrator:sdr_migrator_pw@localhost:5432/sdr}" 5433 /sdr_imob)"
REDIS_URL="$(_imob_force_url "${REDIS_URL:-redis://localhost:6379}" 6380 "")"

# guarda interna: aborta mesmo se o chamador não tiver set -e (nunca seguir
# com URL vazia/parcial — poderia cair no runtime do projeto original)
if [ -z "$DATABASE_URL" ] || [ -z "$MIGRATION_DATABASE_URL" ] || [ -z "$REDIS_URL" ]; then
  echo "env.imob.sh: falha ao reescrever URLs de isolamento — abortando" >&2
  return 1 2>/dev/null || exit 1
fi

export DATABASE_URL MIGRATION_DATABASE_URL REDIS_URL
export POSTGRES_PORT=5433 REDIS_PORT=6380 POSTGRES_DB=sdr_imob

# Portas de DEV do fork: 3100 (web) / 3101 (api) — o projeto padrão usa
# 3000/3001 na mesma máquina e os dois podem rodar JUNTOS sem conflito.
export API_PORT=3101 WEB_PORT=3100
export NEXT_PUBLIC_API_URL="http://localhost:3101"
export WEB_ORIGIN="http://localhost:3100"
