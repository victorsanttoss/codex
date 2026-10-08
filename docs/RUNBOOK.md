# Runbook operacional — SDR IA (VPS única)

Operação numa **VPS Linux com Docker Compose**. Topologia: `caddy` (TLS) →
`api`×2; `worker` (filas); `scheduler` (cron/scans); `postgres`+`redis` internos.

> ⚠️ **Risco de PONTO ÚNICO.** VPS única = se a máquina cair, **todos os tenants
> ficam mudos ao mesmo tempo** e não há máquina para assumir. É consciente e barato
> para começar. **Caminho de HA** (quando o faturamento justificar): Postgres
> gerenciado (RDS/Cloud SQL) + 2ª VPS atrás de um LB + Redis gerenciado. Não está
> construído.

## Comandos do dia a dia
```bash
C="docker compose -f docker-compose.prod.yml"
$C ps                       # estado dos serviços
$C logs -f --tail=200 api   # logs (api|worker|scheduler|caddy|postgres|redis)
$C exec -T caddy wget -qO- http://api:3001/ready   # readiness interno
./deploy/deploy.sh          # deploy (build→migrate→rolling→smoke)
```
Healthchecks: `GET /health` (liveness), `GET /ready` (deps). Monitor **externo**
configurado contra os dois (ver `deploy/uptime-monitor.md`).

---

## Incidentes — o que fazer quando…

### A VPS inteira caiu (monitor externo alertou)
1. Provedor: a instância está *running*? Reinicie/recrie a VM. Confirme disco/CPU.
2. Volta no host: `docker compose -f docker-compose.prod.yml up -d`. Os dados
   persistem nos volumes (`sdr_pgdata`/`sdr_redisdata`).
3. A Meta **reentrega** webhooks falhos e `ensureProcessedOnce` deduplica → o que
   chegou durante a queda é reprocessado sem duplicar.
4. Se o disco/VM estiver corrompido → **restore de backup** (abaixo) num host novo.

### Postgres caiu / não sobe
- `$C logs postgres`. Disco cheio? (ver "disco encheu"). Volume corrompido?
- App degrada (readiness 503) mas não perde dados commitados. Suba o Postgres;
  `api/worker` reconectam.
- Corrupção irrecuperável → restore (abaixo).

### WhatsApp de um tenant desconectou (alerta `connection_down`)
- A conexão saiu de `active` (token inválido/ban/`account_update`). O agente não
  responde aquele tenant.
- Ação: o tenant **reconecta** via Embedded Signup (`/connect` no painel). Verifique
  o motivo em `channel_connections.status`/`last_lifecycle_event_at`.

### Token expirando (alerta `token_expiring`/`token_refresh_needed`)
- O `scheduler` (`TokenRefreshService`) tenta renovar com antecedência (3 dias). Sem
  estratégia de refresh automático → **alerta para reconectar** ANTES de expirar.
- Ação: peça ao tenant para reconectar, ou (se configurado) verifique o refresher.

### Fila travada / backlog (alerta `queue` / jobs `stalled`)
- `$C logs -f worker`. Redis vivo? (`$C exec redis redis-cli ping`).
- Reinicie o `worker`: `$C restart worker`. Jobs `stalled` voltam à fila (BullMQ).
- Backlog grande → escale: mais réplicas de `worker` (`$C up -d --scale worker=2`).

### Outbox acumulando `failed` (alerta `outbox_failed`)
- Envios proativos falhando. Causa comum: token/conexão do tenant caída, ou template
  HSM não aprovado.
- `$C logs scheduler`; cheque `outbox_messages.last_error`. Corrija a causa; o worker
  re-tenta os `pending`. Linhas `canceled` são guardrails (opt-out/janela) — ok.

### LLM todo fora (alerta `llm`)
- O agente usa fallback (mensagem de contenção + handoff — M6). Verifique a chave/
  status do provedor. O lead não fica no vácuo; nada quebra.

### O disco encheu (alerta `disk`)
- `df -h`. Causas: logs do Docker (rotação configurada via daemon.json) ou Postgres.
- Limpeza rápida: `docker system prune -f` (imagens/containers órfãos). **Nunca**
  apague volumes de dados. Cresce sempre? aumente o disco / arquive dados antigos.

### Restore de backup do Postgres (testar ANTES de precisar)
```bash
# 1) baixa do bucket e decifra
aws s3 cp s3://meu-bucket/sdr/sdr_sdr_<ts>.sql.gz.gpg .
gpg --decrypt sdr_sdr_<ts>.sql.gz.gpg | gunzip > restore.sql
# 2) restaura num Postgres LIMPO (host novo ou após recriar o volume)
$C up -d postgres
cat restore.sql | $C exec -T postgres psql -U postgres -d sdr
# 3) sobe a app e valide /ready
$C up -d
```
> **Teste o restore periodicamente** — backup que nunca foi restaurado não é backup.

### Rotação de KEK / segredos (envelope encryption)
- Gere a nova KEK: `openssl rand -base64 32` → `SECRETS_KEK_V2` no `.env`; defina
  `SECRETS_KEK_ACTIVE_VERSION=2` (mantenha a V1 para decifrar o legado).
- Re-encripta os segredos por tenant chamando `TenantSecretsStore.rotateActiveTenant`
  por tenant (script/loop). Só remova a KEK antiga quando 0 segredos a usarem.
- Tokens/segredos **nunca** no repo/imagem — só no `.env` da VPS (gitignored).

---

## Deploy & rollback
- `./deploy/deploy.sh`: build → `db:migrate` → rolling restart das réplicas de `api`
  (Caddy tira a réplica em restart) → smoke em `/health`. Single-host **não** dá
  zero-downtime perfeito; a reentrega da Meta cobre o gap.
- **Rollback:** `git checkout <tag-anterior> && ./deploy/deploy.sh`. Migrations são
  **forward-only** — para reverter schema, escreva uma migration de compensação;
  **nunca** edite uma já aplicada.

## Canal não-oficial Baileys (M13) — operação do session-worker
- ⚠️ **Viola os ToS do WhatsApp** (número pode ser banido). Opt-in por tenant; o
  default do produto é a Cloud API. Ligar: `BAILEYS_ENABLED=true` + serviço
  `session-worker` no compose (ver template comentado) + `pnpm add
  @whiskeysockets/baileys` na imagem.
- **Sticky por número:** cada número mora num worker fixo (`hash(número) %
  SESSION_WORKER_TOTAL === SESSION_WORKER_INDEX`). Rode **N réplicas indexadas**
  (index `0..N-1`, total `N`) — **não** use `docker compose --scale` (todas ficariam
  com o mesmo index e brigariam pelo mesmo socket).
- **Escalar / rebalancear:** aumentar `SESSION_WORKER_TOTAL` **renumera** a posse —
  os números que mudam de dono **caem do worker antigo** (o reconcile fecha o socket
  órfão) e **reconectam no novo dono restaurando a sessão cifrada** (sem novo QR, se
  o blob existir). Faça em janela de baixo tráfego; alguns segundos sem socket por
  número remanejado.
- **Sessão deslogada** (cliente revogou o aparelho / ban): a conexão sai do
  roteamento (`status≠active`), a sessão cifrada é apagada e dispara **alerta** —
  exige **novo QR** em `/connect-baileys`.
- **Onde olhar:** logs do `session-worker` (`docker compose logs session-worker-0`);
  estado de pareamento via `GET /admin/whatsapp/baileys/qr?phoneNumber=`.

## Provisionar uma VPS nova
1. `sudo SSH_PORT=22 DEPLOY_USER=deploy bash deploy/bootstrap-vps.sh` (ufw/SSH/
   updates/swap/log-rotation).
2. Copie sua chave pública para `~deploy/.ssh/authorized_keys`.
3. Crie o `.env` (de `.env.example`; segredos via `openssl rand`).
4. `./deploy/deploy.sh`. Aponte o DNS do `DOMAIN` para a VPS (Caddy emite o TLS).
5. Configure o **monitor externo** (`deploy/uptime-monitor.md`) e o **cron de backup**
   (`deploy/backup.sh`).
