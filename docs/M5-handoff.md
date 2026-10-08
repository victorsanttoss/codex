# Handoff M5 → M6 (contexto para escrever o prompt do Módulo 6)

Plataforma **SDR de IA multi-tenant** no WhatsApp. **M1 (fundação), M2 (canal Cloud
API + pipeline), M3 (Embedded Signup), M4 (LLM real: adaptadores + roteamento) e M5
(conhecimento/RAG: embeddings + pgvector) entregues e verificados ao vivo** (136
testes, 7 rodadas de revisão Codex). **M6 = o AGENTE**: o cérebro que recebe a
mensagem, recupera conhecimento, conversa via LLM (com tool-calling), qualifica o
lead e responde — **trocando o `EchoMessageHandler` stub** que a pipeline do M2 usa
desde então.

> Regra de ouro: **plugar, não reconstruir.** Canal, pipeline, FIFO, janela 24h,
> metering, `LlmService`, `KnowledgeRetriever` e `EmbeddingService` já existem. O M6
> escreve a LÓGICA do agente e a liga no **seam** que já está pronto.

## Princípios (todo o projeto)
- Hexagonal (ports & adapters); núcleo agnóstico a fornecedor. Isolamento rígido por
  tenant (RLS `FORCE`); segredos por tenant cifrados, plataforma via config; nunca
  em log. TS strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`);
  testes sem rede real (clientes injetáveis).

## Stack
Node 20+ · TS strict · NestJS · Next.js · PostgreSQL 16 + pgvector · Drizzle ·
Redis + BullMQ · Vitest · pnpm.

## Estrutura
```
apps/api   NestJS — auth, webhook+pipeline WhatsApp, Embedded Signup, LlmService, knowledge (RAG)
apps/web   Next.js — login, painel, /connect
packages/core            ports (Channel, LLM, Embedding) + registry + contract tests + cripto/contexto
packages/config          12-factor (zod) — whatsapp, llm, embeddings
packages/db              schema/migrations RLS, repos (withTenant, secrets, metering, knowledge)
packages/whatsapp-cloud  adaptador Cloud API (M2/M3)
packages/llm-anthropic | llm-openai-compat | llm-router   LLM + roteamento/custo (M4)
packages/embeddings-openai-compat   adaptador de embeddings (M5)
docs/adr   ADRs 0001-0021
```

---

## O SEAM do agente (é AQUI que o M6 se liga)
`apps/api/src/whatsapp/message-handler.ts` — a pipeline do M2 já entrega tudo
mastigado e chama `INBOUND_HANDLER.handle(ctx)`:
```ts
interface InboundMessageContext {
  tenantId: string;
  conversationId: string;
  conversationKey: string;
  from: string;
  message: { externalMessageId: string; type: string; text?: string };
  reply(text: string): Promise<void>; // já cuida de janela 24h + envio + persistência + metering
}
interface InboundMessageHandler { handle(ctx: InboundMessageContext): Promise<void>; }
export const INBOUND_HANDLER = "INBOUND_HANDLER";
```
Hoje: `{ provide: INBOUND_HANDLER, useExisting: EchoMessageHandler }` em
`whatsapp.module.ts`. **O M6 cria o `AgentMessageHandler` e troca esse provider** —
sem tocar a pipeline. Roda no contexto do tenant (`runWithTenant`), dentro do FIFO
por conversa (ordem garantida) e do worker BullMQ (com retry). `reply()` respeita a
janela de 24h e persiste a mensagem outbound.

## O que o M6 CONSOME (pronto, exportado)
- **LLM:** `LlmService.complete(req)` (api) — roteia por custo/fallback no contexto do
  tenant e grava `recordUsage`. `req`: `{ messages: LLMMessage[], tools?, temperature?,
  maxTokens? }`. Suporta **tool-calling** (round-trip `tool_use`/`tool_result` via
  `LLMMessage.toolCalls` + `role:'tool'`) e streaming. Erros → `LlmError` (categoria
  segura). Modelos Claude atuais: `claude-opus-4-8/4-7/4-6`, `claude-sonnet-4-6`,
  `claude-haiku-4-5`, `claude-fable-5` — IDs exatos sem sufixo de data; em
  opus-4.7/4.8/fable `temperature`/`top_p` dão 400 (o adaptador já faz o gating).
- **Conhecimento:** `KnowledgeRetriever.search(query, { topK?, minScore? })` (api,
  exportado do `KnowledgeModule`) — embeda a query, KNN isolado por tenant (RLS) e
  devolve `{ content, title, score, ... }[]`. É o RAG para ancorar respostas.
- **Embeddings:** `EmbeddingService` (se precisar embedar algo direto).
- **Metering:** `recordUsage`/`aggregateUsage`. Segredos: `TenantSecretsStore`
  (kinds `whatsapp_token`, `crm_api_key`, `llm_api_key`, `embedding_api_key`).
- **Contexto/fila:** `runWithTenant`/`requireTenantContext`/`withTenant`;
  `SerializedRunner` (FIFO por conversa); padrão BullMQ (ver `webhook.queue.ts`).

## Estado de conversa que o M6 provavelmente precisa
A tabela `messages` (M2) já guarda inbound/outbound por conversa (com `content`
jsonb, `direction`, `createdAt`). O M6 deve **montar o histórico** da conversa a
partir dela para alimentar o LLM (e talvez um resumo/estado de qualificação). Se
precisar de estado estruturado do lead (campos qualificados, etapa do funil),
**criar tabela(s) tenant-scoped novas** (RLS FORCE + policy NULLIF + catálogo,
migrations a partir de **0008**) — não inflar `messages`.

---

## Escopo provável do M6 (o prompt do M6 manda; isto é orientação)
1. **`AgentMessageHandler`** implementando `InboundMessageHandler`, ligado no seam.
2. **Montagem de contexto**: histórico da conversa (de `messages`) + **RAG**
   (`KnowledgeRetriever`) → `system`/mensagens para o `LlmService`.
3. **Tool-calling**: ferramentas do agente (ex.: buscar conhecimento, agendar,
   qualificar/gravar campos, escalar para humano) com round-trip completo.
4. **Qualificação**: lógica de funil/estado do lead (provável tabela nova).
5. **Resposta** via `reply()` (respeita janela 24h; fora da janela, decidir
   template/estratégia — ver M2/M3).
6. **Guard-rails**: limites de custo/turnos, fallback quando o LLM falha, mensagens
   não-texto (áudio/imagem) — política de tratamento.

## Contratos a honrar (continuam valendo)
- Núcleo agnóstico (teste estrutural passa — manter). Segredos nunca em log.
- Tudo no contexto do tenant; tabelas novas tenant-scoped com RLS `FORCE` + policy
  `NULLIF(current_setting('app.tenant_id', true), '')::uuid` + catálogo RLS +
  teste de isolamento. Migrations `.sql` a partir de **0008** (nunca `.sh`).
- Toda chamada de LLM/embeddings reporta `usage`/`costMicros` (já automático via
  `LlmService`/`EmbeddingService`). Clientes injetáveis; testes sem rede real.

## Dívida conhecida (o M6 deve/pode resolver)
- **Idempotência de envio outbound** (pendente desde o M2, #5): com retry do worker,
  garantir que a resposta do agente não seja enviada 2×. Resolver no M6.
- **M4**: expor **streaming** pelo `LlmRouter`/`LlmService` (hoje só `complete`);
  **config multi-provedor** `llm.providers[]` (cross-provider já existe no router,
  falta schema p/ ligar o `openai_compat`); **timeout/`AbortSignal`** no streaming;
  **`LLMMessage` união discriminada** (`role:'tool'` exige `toolCallId`).
- **M3**: `TokenExpiryService` reloga tokens expirados sem estado de alerta/refresh.
- **M5**: busca híbrida (vetor+keyword) e tuning de params HNSW — futuro.
- e2e HTTP do Nest via SWC não feito (pipeline coberta por integração).

## Fora de escopo (M6)
- Curadoria / niche packs / loop de melhoria do conhecimento (camada de nicho usa
  storage próprio — ADR 0021); CRM e verticais (M7–M10). A camada de conhecimento
  do M6 consome só o que o M5 expõe (`KnowledgeRetriever`).

## Como rodar/verificar
Docker Desktop 4.41.2 (macOS 12). `.env` na raiz (gitignored; segredos via openssl).
```bash
docker compose up -d postgres redis
set -a && . ./.env && set +a
pnpm db:migrate && pnpm db:seed
pnpm -r --filter './packages/**' build   # project references → dist
pnpm -r test     # com .env carregado, roda também integração ao vivo
```
Estado: **136 testes** (config 4 · core 27 · whatsapp-cloud 16 · db 23 ·
llm-anthropic 8 · llm-openai-compat 7 · llm-router 7 · embeddings-openai-compat 11 ·
api 33). Bugs aprendidos: GUC custom do PG volta a `''` (não NULL) → `NULLIF` na
policy; `AsyncLocalStorage` com `enterWith` não propaga no guard Nest → `storage.run`
+ mutação; bigint volta como string de postgres.js → cast `::int` no SELECT; literal
de `vector` é `[v1,v2,...]` (parametrizado, sem injeção).
