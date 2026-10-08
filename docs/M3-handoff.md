# Handoff M3 → M4 (contexto para escrever o prompt do Módulo 4)

Plataforma **SDR de IA multi-tenant** no WhatsApp. **M1 (fundação), M2 (canal Cloud
API + pipeline) e M3 (Embedded Signup) entregues e verificados ao vivo** (83 testes,
5 rodadas de revisão do Codex). **M4 = LLM real**: implementar o(s) adaptador(es)
concreto(s) da port `LLMProvider` + **roteamento por custo/fallback** + metering de
tokens/custo. O **agente** que USA o LLM é o M6 — o M4 entrega a infraestrutura de
LLM, não o agente.

> Regra de ouro: **plugar, não reconstruir.** A port `LLMProvider`, o registry, a
> contract suite e o metering já existem. A pipeline do M2 **não muda** (o handler
> segue o echo stub até o M6).

## Princípios (todo o projeto)
- Hexagonal (ports & adapters); **núcleo agnóstico a fornecedor** — o core não sabe
  se o LLM é aberto/auto-hospedado ou um provedor por token.
- Isolamento rígido por tenant (RLS `FORCE`); segredos por tenant cifrados, da
  plataforma via config; nunca em log. TS strict; testes sem rede real.

## Stack
Node 20+ · TS strict · NestJS · Next.js · PostgreSQL 16 + pgvector · Drizzle ·
Redis + BullMQ · Vitest · pnpm.

## Estrutura
```
apps/api   NestJS — auth, webhook+pipeline WhatsApp, Embedded Signup, lifecycle
apps/web   Next.js — login, painel, /connect
packages/core           ports (Channel + LLM), envelope encryption, contexto, contract tests
packages/config         12-factor (zod) — seção whatsapp
packages/db             schema/migrations RLS, repos (withTenant, secrets, metering)
packages/whatsapp-cloud adaptador Cloud API (M2/M3)
docs/adr   ADRs 0001-0015
```

---

## O que JÁ EXISTE (M1) e o M4 vai PLUGAR

### Port `LLMProvider` (packages/core/src/ports/llm-provider.ts) — você implementa adaptadores
```ts
interface LLMProvider {
  readonly id: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  stream(req: CompletionRequest): AsyncIterable<StreamChunk>;
}
// CompletionRequest: { model, messages: LLMMessage[], tools?: ToolDefinition[], temperature?, maxTokens? }
// LLMMessage: { role: 'system'|'user'|'assistant'|'tool', content, toolCallId?, name? }
// CompletionResult: { content, toolCalls: ToolCall[], usage: { tokensIn, tokensOut }, finishReason }
// StreamChunk: { type:'delta', content } | { type:'tool_call', toolCall } | { type:'done', usage, finishReason }
```
- **Tool-calling** já está no contrato (ToolDefinition/ToolCall).
- **`usage` (tokensIn/tokensOut) é obrigatório** — alimenta o metering.
- **Contrato obrigatório**: o adaptador DEVE passar `runLLMProviderContract(name, () => new MeuLLM(cfg))`
  (packages/core/src/ports/testing/llm-provider.contract.ts). Há um `FakeLLMProvider` de referência.

### Registry por tenant (packages/core/src/ports/registry.ts)
`ProviderRegistry.registerLLM(key, factory)` e `llmFor(TenantProviderSelection)`
selecionam o adaptador conforme a config do tenant. O M4 registra os adaptadores
reais e (provavelmente) um **roteador** por cima.

### Metering (já pronto — de `@sdr/db`)
`recordUsage({ type, model?, channel?, tokensIn?, tokensOut?, costMicros?, metadata? })`
e `aggregateUsage(from, to)`. O M4 deve, a cada chamada de LLM, **gravar uso** com
`tokensIn/Out` e **`costMicros`** (custo calculado pelo modelo de preço). Roda no
contexto do tenant (`requireTenantContext`/`withTenant`).

### Segredos
- Chave de API do LLM por tenant: cifrada via `TenantSecretsStore`. Hoje os kinds
  são `whatsapp_token`, `crm_api_key` — o M4 provavelmente **adiciona um kind**
  (ex.: `llm_api_key`) estendendo o enum `tenant_secret_kind` (**migration nova**).
- Chaves da plataforma (se houver um provedor default da plataforma): via
  `packages/config` (seção nova, ex.: `llm`).

### Contexto, config, ciclo de request
`runWithTenant`/`requireTenantContext`; config 12-factor (zod); guards/RBAC.

---

## Escopo do M4 — LLM real + roteamento por custo/fallback
1. **Adaptador(es) concreto(s)** da port `LLMProvider` (ex.: um provedor por token
   e/ou um modelo aberto auto-hospedado — o prompt do M4 decide quais). HttpClient/SDK
   injetável; **sem rede real nos testes**. Cada um passa a contract suite.
   > Nota: para apps de IA, o default recomendado são os modelos Claude mais recentes
   > (ver skill `claude-api` no repo do Claude Code) — mas a escolha é do prompt do M4.
2. **Roteador** (`LlmRouter` ou via `ProviderRegistry`) que escolhe o provedor/modelo
   por **custo** e faz **fallback** em erro/indisponibilidade/limite, com retry/backoff
   em transientes e erros permanentes tipados.
3. **Modelo de preço** (tabela de custo por modelo) → calcula `cost_micros` por
   chamada e grava via `recordUsage`. Distinguir entrada/saída de tokens.
4. **Tool-calling** funcional (round-trip de tool_call → tool result) — o agente do
   M6 vai depender disso.
5. **Streaming** suportado (a UI/agente vão usar).

## Contratos que o M4 DEVE honrar
1. Adaptadores passam `runLLMProviderContract`; registrados no `ProviderRegistry`.
2. Toda chamada reporta `usage` e grava `recordUsage` com `costMicros` (metering por tenant).
3. Segredos só via `TenantSecretsStore` (por tenant) / `config` (plataforma); nunca em log.
4. Chamadas ao provedor via cliente **injetável**; testes sem rede real.
5. Núcleo agnóstico: nenhuma dependência de fornecedor vaza para `packages/core`.
6. Tabela/coluna tenant-scoped nova: `tenant_id` + `ENABLE`+`FORCE` RLS + policy
   `NULLIF(current_setting('app.tenant_id',true),'')::uuid` + catálogo RLS atualizado.
   Migrations `.sql` (continuar a numeração; nunca `.sh`). Estender enum
   `tenant_secret_kind` se adicionar `llm_api_key`.

## Fora de escopo (apenas o seam)
- **Agente / motor de qualificação** (M6) — a pipeline do M2 segue parando no
  `InboundMessageHandler` (echo stub); o M4 só disponibiliza o LLM.
- **Conhecimento / RAG / pgvector** (M5).
- Idempotência de envio outbound (#5 do M2) e e2e HTTP do Nest via SWC → futuro.

## Dívida conhecida (que o M4 pode tocar)
- `TokenExpiryService` (M3) reloga tokens expirados sem estado de alerta/refresh —
  vale endereçar antes/junto do M4.
- Roteamento de custo precisa de uma fonte de preços atualizável (config/seed).

## Como rodar/verificar
Docker Desktop 4.41.2 (macOS 12). `.env` na raiz (gitignored; segredos via openssl).
```bash
docker compose up -d postgres redis
set -a && . ./.env && set +a
pnpm db:migrate && pnpm db:seed
pnpm -r test     # com .env carregado, roda também integração ao vivo
```
Estado: **83 testes** (config 4 · core 22 · whatsapp-cloud 16 · db 16 · api 25).
Revisões do Codex: `docs/M1-codex-review*.md`, `docs/M2-codex-review.md`, `docs/M3-codex-review.md`.
