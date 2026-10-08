# Handoff M8 → M9 (contexto para escrever o prompt do Módulo 9)

Plataforma **SDR de IA multi-tenant** no WhatsApp. **M1–M8 entregues e verificados
ao vivo** (209 testes, 10 rodadas de revisão Codex): fundação, canal Cloud API +
pipeline, Embedded Signup, LLM (roteamento custo/fallback), conhecimento/RAG, agente
SDR, CRM + agendamento + handoff, e cadência/follow-up proativo + outbox.

**O loop de ponta a ponta já funciona**: lead chega → agente conversa (RAG +
tool-calling) → qualifica (determinístico) → CRM/handoff/agendamento → cadência
proativa se esfriar, com compliance/anti-ban. Falta a **inteligência coletiva** e a
**operação**.

**M9 (provável): camada de NICHO + loop de curadoria** — o diferencial do produto.
Hoje cada tenant só tem o próprio conhecimento. O M9 adiciona a camada **de nicho**
(conhecimento curado, compartilhado entre tenants do mesmo nicho) e o **loop de
melhoria** (o que funcionou numa conta vira ativo do nicho, após curadoria). O
escopo final é do prompt do M9; isto é orientação. *(Alternativas igualmente
válidas: unificar o `reply()` no outbox; painel/observabilidade; verticais.)*

> Regra de ouro: **plugar, não reconstruir.** O retriever é componível, o prompt é
> em camadas (nicho já é um no-op registrado), e os seams de curadoria estão
> abertos. O M9 preenche a camada de nicho **sem refatorar** agente/RAG.

## Princípios (todo o projeto)
- Hexagonal (ports & adapters); núcleo agnóstico a fornecedor. Isolamento rígido por
  tenant (RLS `FORCE` + policy `NULLIF`); segredos por tenant cifrados; nunca em log.
  TS strict; testes sem rede real (clientes injetáveis).
- **Compliance é primeira classe** (LGPD/anti-ban) — qualquer coisa que dispare
  mensagem reusa os guardrails do M8.

## Estrutura
```
apps/api   NestJS — auth, pipeline WhatsApp, LLM, RAG, agente, CRM, outbox, cadência
apps/web   Next.js — login, painel, /connect
packages/core    ports (Channel, LLM, Embedding, CRM/Scheduling/Notification) + registry
packages/db      schema/migrations RLS, repos (secrets, metering, knowledge, agente, CRM, outbox/cadência)
packages/whatsapp-cloud · llm-* · embeddings-openai-compat · crm-http   adaptadores
docs/adr   ADRs 0001-0029
```

---

## Os SEAMS prontos para a camada de NICHO (M9 preenche)
1. **Retriever componível** (`apps/api/src/knowledge/knowledge-retriever.service.ts`):
   ```ts
   interface KnowledgeSource { id; search(queryVector, topK, minScore): RetrievedChunk[] }
   private readonly sources = [new TenantKnowledgeSource()]; // M9 adiciona NicheKnowledgeSource aqui
   ```
   O `KnowledgeRetriever.search(query)` já mescla por score; somar uma fonte de
   nicho é **adicionar à lista** — não muda a assinatura nem o agente (ADR 0021).
2. **Prompt em camadas** (`prompt-builder.ts`): `nicheLayer` é um **no-op registrado**
   (`render → null`) entre base e tenant. O M9 implementa o `render` da camada de
   nicho (persona/diretrizes do nicho) sem tocar o `composeSystemPrompt` (ADR 0022).
3. **Config/tools por nicho**: `AgentConfigService` resolve default→tenant; a camada
   de nicho entra **entre** os dois (ADR 0022). O **registry de tools** aceita tools
   por nicho/vertical sem mexer no loop.
4. **Storage próprio do nicho (importante)**: a camada de nicho é **compartilhada**
   entre tenants do mesmo nicho — então **NÃO** vive nas tabelas tenant-scoped (RLS
   por tenant). Precisa de storage **de plataforma/por-nicho**, com seu próprio
   controle de acesso (read-only por nicho). Ver ADR 0021 — é proibido injetar
   conteúdo compartilhado na tabela do tenant (vazaria/duplicaria).
5. **Sinais de curadoria** (matéria-prima do loop): `lead_profiles` (o que
   qualificou), `messages` (transcrições), `usage_events` (custo/uso), `activities`/
   `appointments` (desfechos), `outbox_messages` (o que foi enviado e entregue). O M9
   minera isto (com curadoria humana) para promover conhecimento ao nicho.

## O que o M8 ENTREGOU (consumir)
- **Outbox de entrega** (`OutboxService`/`outbox_messages`) at-least-once + worker +
  reconciliação. Qualquer envio proativo novo deve passar por ele (reusa idempotência
  + guardrails-no-envio).
- **Cadência** (`CadenceService`, data-driven, opt-in) + **compliance** (opt-out
  LGPD, stop-on-engagement, horário/fuso, frequência) + **catálogo de templates HSM**.
- Config por tenant em `agent_configs` (jsonb, validado/clampado): chaves `crm`,
  `cadence` — o M9 pode adicionar `niche`.

## Escopo provável do M9 (orientação)
1. **Modelo de nicho**: tabela(s) de plataforma (NÃO tenant-scoped) `niches`,
   `niche_knowledge` (com embeddings próprios, mesma dimensão 1024/bge-m3), e o
   vínculo tenant→nicho. Acesso read-only por nicho.
2. **`NicheKnowledgeSource`** registrada no retriever (busca vetorial no storage de
   nicho, filtrada pelo nicho do tenant). Implementar `nicheLayer.render`.
3. **Loop de curadoria**: pipeline (provável BullMQ) que coleta candidatos a
   conhecimento (de conversas que converteram), passa por **curadoria humana**
   (fila de revisão no painel) e, aprovado, promove ao `niche_knowledge` (re-embeda).
4. **Isolamento revisado**: garantir que nicho é compartilhado SÓ entre tenants do
   mesmo nicho e read-only; nada de PII de um tenant vazar para o nicho sem curadoria.

## Contratos a honrar (continuam valendo)
- Núcleo agnóstico (teste estrutural verde). Segredos nunca em log.
- **Tenant-scoped** → RLS `FORCE` + policy `NULLIF` + catálogo (o teste valida a
  EXPRESSÃO) + isolamento + FK composta `(tenant_id, ...)` (`ON DELETE CASCADE`, não
  `SET NULL` em FK composta). Migrations `.sql` a partir de **0013** (nunca `.sh`).
- **Storage de NICHO é de plataforma** (não tenant-scoped) — modelar o controle de
  acesso explicitamente (por nicho), com seu próprio teste de isolamento entre
  nichos. Qualquer URL do tenant passa pelo guard anti-SSRF.
- Clientes externos injetáveis; testes sem rede real.

## Dívida conhecida (escolher o que atacar)
- **Unificar o `reply()` reativo no outbox** (M8): hoje há dois caminhos de saída
  (reativo grava direto; proativo via outbox). Unificar dá um caminho único com
  garantia — bom candidato a módulo próprio ou parte do M9.
- **M8**: claim "duro" de cadência (hoje `SELECT FOR UPDATE`; idempotência por passo
  é o guard); E.164 do telefone.
- **M7**: sync bidirecional com CRM; Google Calendar/Slack como adaptadores.
- **M4**: streaming pelo `LlmService`; config multi-provedor `llm.providers[]`.
- **M5**: busca híbrida (vetor+keyword) — sinérgica com a camada de nicho.
- **M3**: `TokenExpiryService` reloga tokens expirados sem estado de refresh.
- **Geral**: painel/observabilidade (apps/web é scaffold); e2e HTTP do Nest via SWC.

## Fora de escopo (do M9, provavelmente)
- Transcrição de áudio/visão; novos canais (Baileys/Instagram). Verticais
  específicas (se o M9 for nicho genérico) — M10.

## Como rodar/verificar
Docker Desktop 4.41.2 (macOS 12). `.env` na raiz (gitignored; segredos via openssl).
```bash
docker compose up -d postgres redis
set -a && . ./.env && set +a
pnpm db:migrate && pnpm db:seed
pnpm -r --filter './packages/**' build   # project references → dist
pnpm -r test     # com .env carregado, roda também integração ao vivo
```
Estado: **209 testes** (config 4 · core 29 · whatsapp-cloud 16 · db 38 ·
llm-anthropic 8 · llm-openai-compat 7 · llm-router 7 · embeddings-openai-compat 11 ·
crm-http 5 · api 84). Gotchas: GUC custom do PG volta a `''` (não NULL) → `NULLIF`
na policy; `AsyncLocalStorage`/`enterWith` não propaga no guard Nest → `storage.run`
+ mutação; bigint volta string de postgres.js → cast `::int`; literal de `vector` é
`[v1,...]`; FK composta com `ON DELETE CASCADE` (nunca `SET NULL`); guard anti-SSRF
p/ URL do tenant; vitest do api roda em `singleFork` (integração compartilha 1 PG);
**Codex CLI**: rodar com `</dev/null` senão trava lendo stdin.
