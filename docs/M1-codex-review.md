# M1 — Revisão do Codex (fundação) + triagem

Revisor: OpenAI Codex (`codex exec`, read-only) sobre `packages/core`, `packages/config`,
`packages/db/sql/init`, `docker-compose.yml`. Executor: Claude Code.

## Aplicado nesta camada (core/config)

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 3 | ALTO | `withContextOverrides` permitia trocar `tenantId` | tipo restrito a campos não-identitários (`conversationKey`/`requestId`) |
| 6 | MÉDIO | `rewrap` redecifrava os dados (expunha plaintext) | rotação agora troca **só o envelope da DEK**; dataNonce/Tag/CT preservados (teste prova) |
| 7 | MÉDIO | parsing sem versão de formato/validação | byte de versão de formato + validação determinística de tamanho mínimo |
| 8 | MÉDIO | `normalizeInboundWebhook` sem headers/assinatura | port passa a receber `InboundWebhookRequest` (headers+query+rawBody) |
| 10 | BAIXO | KEK não validada no boot | `loadConfig()` valida base64 de 32 bytes |

## Contratos pendentes — OBRIGATÓRIOS antes de fechar M1 (camada `db`/`api`)

- [ ] **#1 (CRÍTICO)** Teste de catálogo que FALHA se alguma tabela tenant-scoped não tiver
      `ENABLE` + `FORCE ROW LEVEL SECURITY` + policy por `app.tenant_id`. RLS deny-by-default.
- [ ] **#2 (ALTO)** Toda migration de tabela tenant-scoped aplica `FORCE ROW LEVEL SECURITY`
      (impede o owner/`migrator` de burlar RLS). `migrator` só em DDL controlado.
- [ ] **#4 (ALTO)** Helper transacional único `withTenant()` que faz `SET LOCAL app.tenant_id`
      no começo da transação; proibir query tenant-scoped fora dele.
- [ ] **#5 (MÉDIO)** `SecretsStore` deriva AAD obrigatório e estruturado
      (`tenantId:kind:recordId`) — call sites não passam AAD à mão.

## Aceito por ora (decisão consciente)

- **#9** `ProviderRegistry` com `Record<string, unknown>`: validação por-adapter (schema/parse)
  é responsabilidade dos adaptadores concretos (M2/M4), não da fundação.
