# M11 — Revisão do Codex (operação/VPS) + triagem

Revisor: OpenAI Codex (`gpt-5.5`, read-only) sobre o bootstrap por role, shutdown,
ops (alertas/refresh), e toda a infra (compose/Dockerfile/Caddy/scripts/CI/runbook).
**1 crítico, 3 altos, vários médios.** Confirmou: Postgres/Redis sem `ports`; só
Caddy publica 80/443; ufw só SSH/80/443; `.dockerignore` exclui `.env`; runtime
não-root; CI cria roles `NOBYPASSRLS`; Caddy com TLS automático.

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 1 | **CRÍTICO** | URLs com `localhost` no `.env` apontam para o próprio container em prod | compose injeta `DATABASE_URL`/`MIGRATION_*`/`REDIS_URL` com **nomes de serviço** (`@postgres`/`redis`), sobrescrevendo o `.env` (que fica para dev/CI) |
| 4 | ALTO | `TokenRefreshService` atualizava só `token_expires_at`, NÃO gravava o token novo → envio seguia com token velho | `ExpiringConnection.secretRef` adicionado; no sucesso com `res.token`, `TenantSecretsStore.put(secretRef, token)` no contexto do tenant |
| 2 | ALTO | `deploy.sh` reiniciava containers ANTIGOS (`--no-recreate`+`docker restart`) — não pegava a imagem nova | recreate correto com a imagem nova (`up -d --force-recreate --no-deps api`); Caddy health-check + reentrega da Meta cobrem o gap |
| 3 | ALTO | `backup.sh` usava `PG_CONTAINER` fixo mas o compose não define `container_name` | usa `docker compose exec -T postgres pg_dump` |
| 5 | MÉDIO | `HEALTHCHECK` HTTP no Dockerfile deixava worker/scheduler `unhealthy` (não fazem listen) | healthcheck movido p/ o serviço `api` no compose; Dockerfile sem healthcheck |
| 6 | MÉDIO | Nada chamava `closeDb()` no shutdown (Postgres fechava abrupto) | `ShutdownService` (`OnApplicationShutdown`) chama `closeDb()` |
| 8 | MÉDIO | `TokenExpiryService` (M3) duplicava o novo `TokenRefreshService` (só logava) | removido do `WhatsappModule` — `TokenRefreshService` o substitui |
| 9 | MÉDIO | `queueBacklogThreshold` prometido mas não medido | `gatherSignals` conta BullMQ (`waiting+delayed+failed`) das filas; `evaluateAlerts` emite `queue_backlog` |
| 10 | BAIXO | Smoke test só interno (não pega Caddy/TLS quebrado) | smoke interno + `curl https://$DOMAIN/ready` externo no fim do deploy |

## Documentado (consciente)
- **#7 (MÉDIO)** drain vs `stop_grace_period`: `worker.close()` espera os jobs ativos;
  job que exceder o grace é morto e **reexecutado** (stalled) — seguro pela
  idempotência (outbox/ensureProcessedOnce). Runbook nota o comportamento.
- **#11 (BAIXO)** retenção de backup: a limpeza fica a cargo do **lifecycle do
  bucket** (recomendado no runbook) — o script não apaga remoto.
