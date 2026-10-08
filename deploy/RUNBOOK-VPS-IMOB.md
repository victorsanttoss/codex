# Runbook — deploy do SDR IA Imobiliário na VPS cérebro

A VPS **já roda** o SDR original (`/opt/sdr-ia`, Docker, Caddy 80/443 servindo
`sdr.v4souzasantos.com.br` + `menin.v4souzasantos.com.br`) e a Central (PM2
:3010). O fork foi desenhado para conviver **sem tocar em nada disso**:
project name/imagens/volumes exclusivos (`sdr-imob-*`), sem Caddy próprio,
api/web publicados só em loopback (127.0.0.1:3101/3100).

## 1. Código na VPS

```bash
# local (uma vez): remote bare + push
ssh vps 'git init --bare /opt/sdr-ia-imob.git'
git remote add vps vps-souza-santos:/opt/sdr-ia-imob.git
git push vps main

# na VPS (uma vez)
git clone /opt/sdr-ia-imob.git /opt/sdr-ia-imob
# atualizações futuras: git push vps main && ssh vps 'cd /opt/sdr-ia-imob && git pull'
```

## 2. `.env` de produção (em /opt/sdr-ia-imob/.env — NUNCA commitar)

Partir do `.env.example`. Obrigatórios além dos herdados (JWT/LLM/etc.):

```
POSTGRES_DB=sdr_imob
POSTGRES_SUPERUSER_PASSWORD=...   APP_DB_PASSWORD=...   MIGRATOR_DB_PASSWORD=...
REDIS_PASSWORD=...
DOMAIN=imob.v4souzasantos.com.br          # painel; API pública = api.$DOMAIN
BAILEYS_ENABLED=true                      # piloto (Cloud API = go-live oficial)
IMOB_PLATFORM_READ_TENANTS=<uuid-tenant-pqf-prod>
LEAD_INTAKE_TOKEN=<token forte>           # openssl rand -hex 24
LEAD_INTAKE_TENANTS=<uuid-tenant-pqf-prod>
IMOB_PROJECT_NAME="Parque das Flores"
# META_* só quando ligar o webhook direto (ver .env.example)
```

## 3. Subir

```bash
cd /opt/sdr-ia-imob && ./deploy/deploy.sh
# valida: curl -s 127.0.0.1:3101/health ; curl -sI 127.0.0.1:3100
```

## 4. Caddy da VPS (config do ORIGINAL — só ADICIONAR blocos)

No Caddyfile em uso pelo compose do original (`/opt/sdr-ia/deploy/Caddyfile`),
adicionar (mesmo padrão usado p/ o menin→host):

```
imob.v4souzasantos.com.br {
    reverse_proxy host.docker.internal:3100
}
api.imob.v4souzasantos.com.br {
    reverse_proxy host.docker.internal:3101
}
```

Se o serviço caddy do original ainda não tiver, acrescentar em `extra_hosts`:
`host.docker.internal:host-gateway`. Recarregar SÓ o caddy (não derruba a API
nem o Baileys do original):
`cd /opt/sdr-ia && docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile`

**DNS**: criar A records `imob` e `api.imob` → IP da VPS (onde estão os
records de `sdr`/`menin`).

## 5. Bootstrap do tenant de produção (banco novo)

```bash
C="docker compose -f docker-compose.prod.yml"
# staff da plataforma (tokens FORTES via env — NUNCA os defaults dev)
$C run --rm --no-deps -T \
  -e SEED_STAFF_ADMIN_TOKEN=<forte> -e SEED_STAFF_CURATOR_TOKEN=<forte> \
  scheduler node /repo/packages/db/dist/seed.js
# tenant do empreendimento (credenciais REAIS — nunca owner@demo.local/1234)
$C run --rm --no-deps -T \
  -e IMOB_NAME="Menin — Parque das Flores" -e IMOB_SLUG=parque-das-flores \
  -e IMOB_OWNER_EMAIL=<email real> -e IMOB_OWNER_PASSWORD=<senha forte> \
  scheduler node /repo/packages/db/dist/seed-imob.js
# kit + nicho (com o staff token forte)
curl -s -X POST 127.0.0.1:3101/platform/kits/imobiliario/apply -H "x-platform-token: <staff>"
curl -s -X POST 127.0.0.1:3101/platform/tenants/<TENANT_ID>/niche \
  -H "x-platform-token: <staff>" -H "Content-Type: application/json" -d '{"nicheId":"<NICHE_ID>"}'
```

## 6. Central (PM2) — ligar a página /atendimento

No diretório da Central na VPS: `git pull` → adicionar ao `.env`:

```
SDR_IMOB_API_URL="http://127.0.0.1:3101"    # mesma máquina — loopback
SDR_IMOB_TOKEN="<staff token support/admin de produção>"
SDR_IMOB_TENANTS="<uuid-pqf-prod>:Parque das Flores"
```

`npm ci && npm run build && pm2 restart central-menin` (conferir o nome no
`pm2 list`).

## 7. Pós-deploy (com o Victor)

1. Login no painel (`https://imob.v4souzasantos.com.br`) com o owner real.
2. Wizard: conectar WhatsApp (QR Baileys com o chip do empreendimento).
3. Cadastrar corretores reais (etapa 6 / Configuração).
4. Playground → teste real → campanha Meta aponta o clique-para-WhatsApp
   pro número; formulários nativos via /integrations/leads (Make/Zapier) ou
   webhook direto (envs META_*).

## Regras de ouro

- **NUNCA** rodar `docker compose down/restart` dentro de `/opt/sdr-ia`
  (derruba o Baileys do original/OdontoVita). O fork inteiro opera em
  `/opt/sdr-ia-imob` com project name próprio.
- Migrations: só pelo runner (`node /repo/packages/db/dist/migrate.js`).
- Backups: incluir o volume `sdrimob_prod_pgdata` na rotina existente.
