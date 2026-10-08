# Guia — acessar a plataforma e deixá-la online

Dois caminhos: **(A)** testar **localmente** agora (sem servidor) e **(B)** colocar
**online numa VPS** para testes reais com WhatsApp.

---

## A. Acessar localmente (testar agora, sem servidor)

**Pré-requisitos:** Docker Desktop rodando, Node 20+, pnpm (`corepack enable`).

```bash
cd ~/projetos/sdr-ia

# 1) Sobe Postgres + Redis locais
docker compose up -d postgres redis

# 2) Carrega o .env (já existe na raiz, gitignored)
set -a; . ./.env; set +a

# 3) Dependências + schema + dados demo
pnpm install
pnpm db:migrate
pnpm db:seed

# 4) Sobe API (:3001) e painel (:3000) juntos
pnpm dev
```

Abra **http://localhost:3000**:
- **Login** (área do cliente): `owner@demo.local` / `demo-owner-123456`.
- **Início / Leads / Conversas / Configuração / Conta** — área do tenant.
- **Playground** (`/playground`): **testa a SDR sem WhatsApp** — escreve como um lead
  e vê a IA responder, qualificar e o custo. (É o jeito mais rápido de validar agora.)
- **Onboarding** (`/onboarding`): wizard de ativação.
- **Área da plataforma** (`/plataforma/visao-global`): pede o **token de plataforma**
  = o valor de `PLATFORM_ADMIN_TOKEN` no seu `.env`.

> **Testar a conversa de verdade (com WhatsApp) localmente** exige expor o webhook à
> internet (ex.: `cloudflared tunnel` ou `ngrok http 3001`) e apontar o webhook da
> Meta para a URL do túnel. Para validar a lógica da SDR **sem** isso, use o
> **Playground**.

---

## B. Deixar online numa VPS (testes reais)

Arquitetura: **uma VPS Linux** com Docker Compose servindo `api` + `worker` +
`scheduler` + `web` (painel) + `caddy` (TLS automático). Postgres/Redis internos.

### B.1 — Provisionar
1. **Contrate uma VPS** Linux (Ubuntu 22.04; ex.: Hetzner CX22, DigitalOcean,
   Contabo). ~2 vCPU / 4 GB já roda bem o piloto.
2. **DNS:** aponte **dois** registros A para o IP da VPS:
   - `seudominio.com.br` → painel
   - `api.seudominio.com.br` → API/webhook
3. **Endurecer a VPS** (firewall/SSH/swap/logrotate):
   ```bash
   sudo SSH_PORT=22 DEPLOY_USER=deploy bash deploy/bootstrap-vps.sh
   ```
   Copie sua chave pública para `~deploy/.ssh/authorized_keys`.

### B.2 — Configurar
4. **Clone o repo** na VPS e crie o **`.env` de produção** (a partir de
   `.env.example`), com segredos fortes:
   ```bash
   # gere segredos:
   openssl rand -hex 32   # JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, PLATFORM_ADMIN_TOKEN
   openssl rand -base64 32 # SECRETS_KEKS (chave de criptografia)
   ```
   Defina pelo menos: `DOMAIN`, `ACME_EMAIL`, senhas do Postgres
   (`APP_DB_PASSWORD`/`MIGRATOR_DB_PASSWORD`), `JWT_*`, `SECRETS_KEKS`,
   `LLM_ANTHROPIC_API_KEY` (ou o provedor de LLM), `PLATFORM_ADMIN_TOKEN`.
   > O `.env` **fica só na VPS** — nunca no git/imagem.

### B.3 — Subir
5. **Deploy** (build + migrate + sobe tudo + TLS automático):
   ```bash
   ./deploy/deploy.sh
   ```
   O Caddy emite os certificados de `seudominio.com.br` e `api.seudominio.com.br`.
   Ao fim, o smoke valida `https://api.SEU/ready` e `https://SEU/`.
6. Acesse **https://seudominio.com.br** (painel) e
   **https://api.seudominio.com.br** (API/webhook).

### B.4 — Conectar o WhatsApp
- **Oficial (Cloud API) — recomendado:** crie um app no Meta for Developers + WhatsApp
  Business; configure o webhook para **`https://api.seudominio.com.br/webhooks/whatsapp`**
  (verify token = `WHATSAPP_VERIFY_TOKEN` do `.env`); conecte o número pelo painel
  (`/connect`, Embedded Signup) ou pelo endpoint admin. Sem risco de ban.
- **Não-oficial (Baileys) — rápido, com risco:** `BAILEYS_ENABLED=true`, suba o
  serviço `session-worker` (template no `docker-compose.prod.yml`) com
  `@whiskeysockets/baileys` instalado, e pareie por QR em `/connect-baileys`.
  ⚠️ Viola os ToS do WhatsApp; o número pode ser banido (ver ADR 0041).

### B.5 — Operar
- **Backup** cifrado externo: agende `deploy/backup.sh` (cron).
- **Monitor externo** de uptime: `deploy/uptime-monitor.md`.
- **Runbook** de incidentes: `docs/RUNBOOK.md`.
- **Atualizar:** `git pull && ./deploy/deploy.sh` (rolling, quase sem downtime).

> VPS única = ponto único de falha (trade-off assumido — ADR 0036). Caminho de HA
> documentado no runbook.
