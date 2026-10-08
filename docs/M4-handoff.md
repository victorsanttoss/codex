# Handoff M4 → M5 (contexto para escrever o prompt do Módulo 5)

Plataforma **SDR de IA multi-tenant** no WhatsApp. **M1 (fundação), M2 (canal Cloud
API + pipeline), M3 (Embedded Signup) e M4 (LLM real: adaptadores + roteamento por
custo/fallback) entregues e verificados ao vivo** (107 testes, 6 rodadas de revisão
do Codex). **M5 = camada de conhecimento (RAG)**: ingestão de conteúdo por tenant,
**embeddings + busca vetorial (pgvector)** e recuperação de trechos relevantes para
ancorar as respostas. O **agente** que USA o conhecimento + LLM é o M6 — o M5
entrega a infraestrutura de conhecimento, não o agente nem o diálogo.

> Regra de ouro: **plugar, não reconstruir.** RLS `FORCE`, `withTenant`, metering,
> a port `LLMProvider`/`LlmRouter` (M4) e o registry já existem. A pipeline do M2
> **não muda** (o handler segue o echo stub até o M6).

## Princípios (todo o projeto)
- Hexagonal (ports & adapters); **núcleo agnóstico a fornecedor** — o core não sabe
  qual provedor de embeddings/LLM nem qual store vetorial está por trás.
- Isolamento rígido por tenant (RLS `FORCE`); segredos por tenant cifrados, da
  plataforma via config; nunca em log. TS strict (`exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`); testes sem rede real (clientes injetáveis).

## Stack
Node 20+ · TS strict · NestJS · Next.js · PostgreSQL 16 + **pgvector** · Drizzle ·
Redis + BullMQ · Vitest · pnpm.

## Estrutura
```
apps/api   NestJS — auth, webhook+pipeline WhatsApp, Embedded Signup, lifecycle, LlmService
apps/web   Next.js — login, painel, /connect
packages/core            ports (Channel + LLM), envelope encryption, contexto, contract tests
packages/config          12-factor (zod) — seções whatsapp, llm
packages/db              schema/migrations RLS, repos (withTenant, secrets, metering)
packages/whatsapp-cloud  adaptador Cloud API (M2/M3)
packages/llm-anthropic   adaptador LLM Anthropic (M4)
packages/llm-openai-compat adaptador LLM OpenAI-compatible (self-hosted/por-token, M4)
packages/llm-router      catálogo de preços + roteamento custo/fallback (M4)
docs/adr   ADRs 0001-0018
```

---

## O que o M4 ENTREGOU e o M5 vai PLUGAR

### LLM + roteamento (M4) — pronto para o M5/M6 consumir
- **`LlmService`** (`apps/api/src/llm/llm.service.ts`): no contexto do tenant ativo,
  monta um `LlmRouter` (chave do tenant via `TenantSecretsStore('llm_api_key')` ou
  plataforma via `cfg.llm.anthropicApiKey`) e expõe `complete(req)`. Grava
  `recordUsage({type:'llm_call', costMicros, ...})` para o modelo que respondeu.
- **`LlmRouter`** (`@sdr/llm-router`): ordena candidatos por custo, retry/backoff em
  transiente, fallback (inclusive cross-provider) em permanente. **Fail-closed de
  preço** (modelo sem preço no catálogo lança; grátis/self-hosted exige `{0,0}`).
- **Adaptadores**: `@sdr/llm-anthropic` (SDK oficial) e `@sdr/llm-openai-compat`
  (`baseURL` configurável). Ambos passam `runLLMProviderContract`. Tool-calling +
  streaming. Erros viram `LlmError` (categoria segura; texto cru só em `detail`).
- **Para embeddings o M5 NÃO tem port ainda** — a port `LLMProvider` é de *completion*.
  O M5 precisa de uma **port nova de embeddings** (ex.: `EmbeddingProvider` com
  `embed(texts: string[]): Promise<{ vectors: number[][], usage }>`), com contract
  suite própria e adaptador(es) concreto(s) injetáveis — espelhando o padrão do M4.

### pgvector — já provisionado, ainda sem uso
- A extensão **pgvector já está instalada** na imagem do Postgres (M1) e usada no
  catálogo de RLS. **Nenhuma tabela de embeddings existe ainda** — o M5 cria.
- Decisão a registrar (ADR): **dimensão do vetor** (depende do modelo de embeddings),
  tipo de índice (`hnsw` vs `ivfflat`) e operador de distância (cosine/L2/IP).

### Metering (já pronto — `@sdr/db`)
`recordUsage({ type, model?, tokensIn?, tokensOut?, costMicros?, metadata? })`. O M5
deve gravar uso de **embeddings** (um `type` novo, ex.: `embedding`) com tokens e
`costMicros` — estender o **catálogo de preços** (`@sdr/llm-router` `DEFAULT_PRICING`
hoje só tem modelos de *completion*; o M5 adiciona preços de embeddings, ou um
catálogo análogo). Lembrar do **fail-closed**: todo modelo cobrado precisa de preço.

### Segredos
- Chave do provedor de embeddings por tenant: cifrada via `TenantSecretsStore`. Kinds
  atuais: `whatsapp_token`, `crm_api_key`, `llm_api_key`. Se o provedor de embeddings
  usar a **mesma** chave do LLM (ex.: Anthropic/OpenAI-compat), reusar `llm_api_key`;
  se for provedor separado, **adicionar um kind** estendendo `tenant_secret_kind`
  (migration nova, padrão `ADD VALUE IF NOT EXISTS`, isolada — ver M4 #12).
- Chaves de plataforma via `packages/config` (seção nova se necessário).

### Contexto, config, ciclo de request
`runWithTenant`/`requireTenantContext`/`withTenant`; config 12-factor (zod); guards/RBAC.

---

## Escopo do M5 — conhecimento / RAG / pgvector
1. **Port de embeddings** (core, agnóstica) + contract suite + adaptador(es)
   concreto(s) injetáveis (sem rede real nos testes). Reusar a estratégia do M4.
2. **Schema + migration** das tabelas de conhecimento **tenant-scoped** (ex.:
   `knowledge_sources`, `knowledge_chunks` com coluna `vector(N)`), todas com
   `ENABLE`+`FORCE` RLS + policy `NULLIF(...)` + catálogo RLS atualizado. Índice
   vetorial (hnsw/ivfflat) + decisão de distância.
3. **Ingestão**: receber conteúdo do tenant → **chunking** → embeddings → persistir
   (idealmente assíncrono via BullMQ, reusando o padrão de fila do M2). Reindexação.
4. **Recuperação**: `search(query, topK)` no contexto do tenant → embedding da query
   → busca vetorial (KNN) → retorna trechos + score, **estritamente isolados por
   tenant** (RLS garante; não confiar só no WHERE).
5. **Metering** de embeddings (tokens + `costMicros`) via `recordUsage`.

## Contratos que o M5 DEVE honrar
1. Port de embeddings passa a contract suite; adaptadores registrados no registry.
2. Toda chamada de embeddings reporta `usage` e grava `recordUsage` com `costMicros`
   (fail-closed: modelo sem preço lança).
3. Segredos só via `TenantSecretsStore`/`config`; nunca em log.
4. Provedores via cliente **injetável**; testes sem rede real.
5. Núcleo agnóstico: nenhuma dependência de fornecedor (SDK de embeddings/store)
   vaza para `packages/core` (o teste estrutural de agnosticismo já cobre — manter).
6. Tabelas tenant-scoped: `tenant_id` + `ENABLE`+`FORCE` RLS + policy
   `NULLIF(current_setting('app.tenant_id',true),'')::uuid` + catálogo RLS atualizado.
   Migrations `.sql` (continuar numeração a partir de **0005**; nunca `.sh`). Init do
   Postgres via `.sql` (noexec do bind-mount no macOS).
7. **Isolamento vetorial cross-tenant é falha crítica** — provar com teste de
   integração (tenant A não recupera chunk de tenant B), como `isolation.test.ts`.

## Fora de escopo (apenas o seam)
- **Agente / motor de qualificação / diálogo** (M6) — a pipeline do M2 segue parando
  no `InboundMessageHandler` (echo stub). O M5 só disponibiliza ingestão + busca.
- **Curadoria / loop de melhoria do conhecimento** (módulos posteriores).
- Idempotência de envio outbound (#5 do M2) e e2e HTTP do Nest via SWC → futuro.

## Dívida conhecida herdada (o M5/M6 pode tocar)
- **M4**: config multi-provedor `llm.providers[]` (cross-provider já existe no router,
  falta o schema); timeout/`AbortSignal` no streaming; `LLMMessage` união
  discriminada (`role:'tool'` exige `toolCallId`) — todos planejados p/ o M6.
- **M3**: `TokenExpiryService` reloga tokens expirados sem estado de alerta/refresh.
- Catálogo de preços precisa de revisão periódica (ou puxar da Models API).

## Como rodar/verificar
Docker Desktop 4.41.2 (macOS 12). `.env` na raiz (gitignored; segredos via openssl).
```bash
docker compose up -d postgres redis
set -a && . ./.env && set +a
pnpm db:migrate && pnpm db:seed
pnpm -r --filter './packages/**' build   # project references → dist
pnpm -r test     # com .env carregado, roda também integração ao vivo
```
Estado: **107 testes** (config 4 · core 24 · whatsapp-cloud 16 · db 16 ·
llm-anthropic 8 · llm-openai-compat 7 · llm-router 6 · api 26).
Bugs aprendidos: GUC custom do PG volta a `''` (não NULL) → `NULLIF` na policy;
`AsyncLocalStorage` com `enterWith` não propaga no guard Nest → `storage.run` no
middleware + mutação; bigint volta como string de postgres.js → cast `::int` no SELECT.
