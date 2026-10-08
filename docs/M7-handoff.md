# Handoff M7 → M8 (contexto para escrever o prompt do Módulo 8)

Plataforma **SDR de IA multi-tenant** no WhatsApp. **M1–M7 entregues e verificados
ao vivo** (182 testes, 9 rodadas de revisão Codex): fundação, canal Cloud API +
pipeline, Embedded Signup, LLM (roteamento custo/fallback), conhecimento/RAG, agente
SDR e **CRM + agendamento + handoff** (fechamento reativo do ciclo do lead).

**M8 (provável): cadência / follow-up proativo + OUTBOX de entrega garantida.**
Hoje o agente só responde **reativamente** (o lead acabou de escrever, dentro da
janela de 24h). O M8 adiciona o envio **proativo** — reengajar leads que pararam de
responder, fora da janela, via **templates aprovados (HSM)** — e evolui a entrega de
*at-most-once* para um **outbox confiável** com estado e reparo. O escopo final é do
prompt do M8; isto é orientação.

> Regra de ouro: **plugar, não reconstruir.** Canal (`sendTemplate` já existe),
> idempotência (`agent_response_claims`), estado do lead, CRM/agenda/notificação,
> metering e o padrão BullMQ já existem. O M8 liga o caminho proativo e endurece a
> entrega.

## Princípios (todo o projeto)
- Hexagonal (ports & adapters); núcleo agnóstico a fornecedor. Isolamento rígido por
  tenant (RLS `FORCE` + policy `NULLIF`); segredos por tenant cifrados; nunca em log.
  TS strict; testes sem rede real (clientes injetáveis).

## Estrutura
```
apps/api   NestJS — auth, webhook+pipeline, Embedded Signup, LLM, RAG, agente, CRM
apps/web   Next.js — login, painel, /connect
packages/core            ports (Channel, LLM, Embedding, CRM/Scheduling/Notification) + registry
packages/db              schema/migrations RLS, repos (secrets, metering, knowledge, agente, CRM)
packages/whatsapp-cloud  adaptador Cloud API — JÁ tem sendTemplate (HSM)
packages/llm-* / embeddings-openai-compat / crm-http   adaptadores
docs/adr   ADRs 0001-0026
```

---

## Os SEAMS que o M7/M6 deixaram prontos para o M8
1. **`sendTemplate` (HSM)** — a port `ChannelProvider.sendTemplate(msg)` e o adaptador
   `@sdr/whatsapp-cloud` já enviam template:
   ```ts
   interface OutboundTemplateMessage {
     to: string; templateName: string; languageCode: string;
     variables?: Record<string, string>; clientMessageId?: string;
   }
   ```
   É o caminho para falar **fora da janela de 24h**. Hoje o `reply()` do agente
   **recusa** free-form fora da janela; o M8 usa template no lugar.
2. **Idempotência de envio** — `agent_response_claims` + `claimAgentResponse(key)`
   (M6). O M8 reusa com chaves próprias (ex.: `cadence:{conversationId}:{stepN}`)
   para não disparar o mesmo follow-up 2×. **Mas** hoje é *at-most-once* (claim antes
   do send, sem estado `pending/sent/failed`) — o M8 deve evoluir isso (ver dívida).
3. **Estado do lead** — `lead_profiles` (`stage`/`status`/`score`/`fields`/`summary`)
   + `crm_external_sync`/`opportunities` (M7). Fonte para decidir **quem** reengajar e
   **quando parar** (qualificado/handoff/opt-out → não cadenciar).
4. **Janela de 24h** — `conversations.windowExpiresAt` + `isWithinServiceWindow()`
   (M2). Dentro da janela → free-form; fora → template. O M8 decide a estratégia.
5. **Padrão de jobs** — BullMQ (`crm-sync.queue`, `knowledge.queue`, `webhook.queue`)
   + `runWithTenant` no worker. A cadência é mais um produtor/consumidor desse padrão
   (provavelmente com **jobs agendados/delayed** ou um scan periódico).
6. **`clientMessageId`** em `OutboundTextMessage`/`OutboundTemplateMessage` — gancho de
   idempotência no lado do provedor (a Cloud API deduplica por ele).

## O que o M7 ENTREGOU (consumir)
- **CRM/agenda/notificação** (ports + built-in default + `crm-http`), `LeadOutcomeService`
  (facade chamada no fim do turno), `CrmSyncService` idempotente.
- **Config por tenant** (`AgentConfigService`/`CrmConfigService`, data-driven, validada
  e **clampada**; `CrmConfigService` tem **guard anti-SSRF** para URLs do tenant —
  reusar o padrão em qualquer URL nova do M8).
- Tudo no contexto do tenant; metering automático; segredos por tenant.

## Escopo provável do M8 (orientação)
1. **OUTBOX de saída** (resolver a dívida de entrega): tabela tenant-scoped com estado
   `pending → sent → delivered/failed`, `external_message_id`, tentativas, e um
   worker que envia + concilia com os **status de entrega** (a pipeline do M2 já
   processa `delivered`/`read`/`failed` via `markMessageStatusByExternalId`). Tornar
   o envio **at-least-once com dedup** (em vez de at-most-once).
2. **Motor de cadência**: regras por tenant (passos, atrasos, condição de parada) —
   data-driven (padrão `agentConfigService`). Agenda follow-ups (BullMQ delayed/cron)
   para leads que esfriaram; **respeita opt-out**, janela 24h (template fora dela),
   horário comercial/fuso `America/Sao_Paulo`, e **para** ao qualificar/handoff/responder.
3. **Templates (HSM)**: catálogo de templates por tenant + envio via `sendTemplate`;
   idempotente (claim/outbox). Cadastro de templates aprovados (a aprovação na Meta é
   externa).
4. **Opt-out / compliance**: detectar e honrar "pare"/descadastro; nunca cadenciar
   quem optou por sair (LGPD).

## Contratos a honrar (continuam valendo)
- Núcleo agnóstico (teste estrutural verde). Segredos nunca em log. Tudo no contexto
  do tenant.
- Tabelas novas tenant-scoped: `tenant_id` + `ENABLE`+`FORCE` RLS + policy
  `NULLIF(current_setting('app.tenant_id', true), '')::uuid` + **catálogo RLS** (o
  teste de catálogo agora valida a EXPRESSÃO NULLIF) + **teste de isolamento** +
  **FK composta** `(tenant_id, ...)` em referências cruzadas (padrão 0007/0010).
  Migrations `.sql` a partir de **0011** (nunca `.sh`).
- Qualquer URL vinda do tenant passa pelo **guard anti-SSRF** (ver `CrmConfigService`).
- Clientes externos injetáveis; testes sem rede real.

## Dívida que o M8 deve resolver
- **Entrega at-most-once → outbox**: `claimAgentResponse`/`ensureProcessedOnce`
  reivindicam antes do send sem estado `pending/sent` — para cadência confiável é
  preciso outbox com reparo (ADR 0024 já aponta). **Esta é a dívida central do M8.**
- **Templates fora da janela 24h**: ligar `sendTemplate` no caminho proativo.
- **M3**: `TokenExpiryService` reloga tokens expirados sem estado de alerta/refresh.

## Dívida que pode ficar para depois (não bloqueia o M8)
- **M4**: streaming pelo `LlmService` (só `complete`); config multi-provedor
  `llm.providers[]`.
- **M5**: busca híbrida (vetor+keyword).
- **M7**: sync **bidirecional** com CRM (webhooks de volta); normalização E.164 fina;
  Google Calendar/Slack como adaptadores externos.

## Fora de escopo (do M8, provavelmente)
- Curadoria / niche packs / loop de melhoria do conhecimento (storage próprio —
  ADR 0021/0022); verticais específicas (M9–M10); transcrição de áudio/visão.

## Como rodar/verificar
Docker Desktop 4.41.2 (macOS 12). `.env` na raiz (gitignored; segredos via openssl).
```bash
docker compose up -d postgres redis
set -a && . ./.env && set +a
pnpm db:migrate && pnpm db:seed
pnpm -r --filter './packages/**' build   # project references → dist
pnpm -r test     # com .env carregado, roda também integração ao vivo
```
Estado: **182 testes** (config 4 · core 29 · whatsapp-cloud 16 · db 32 ·
llm-anthropic 8 · llm-openai-compat 7 · llm-router 7 · embeddings-openai-compat 11 ·
crm-http 5 · api 63). Gotchas: GUC custom do PG volta a `''` (não NULL) → `NULLIF` na
policy; `AsyncLocalStorage`/`enterWith` não propaga no guard Nest → `storage.run` +
mutação; bigint volta como string de postgres.js → cast `::int`; literal de `vector`
é `[v1,...]` (parametrizado); guard anti-SSRF para URLs do tenant; **Codex CLI**:
rodar com `</dev/null` senão trava lendo stdin.
