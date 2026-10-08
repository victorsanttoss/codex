# Handoff M6 → M7 (contexto para escrever o prompt do Módulo 7)

Plataforma **SDR de IA multi-tenant** no WhatsApp. **M1–M6 entregues e verificados
ao vivo** (163 testes, 8 rodadas de revisão Codex): fundação, canal Cloud API +
pipeline, Embedded Signup, LLM (roteamento custo/fallback), conhecimento/RAG
(pgvector) e o **agente SDR** (conversa + tool-calling + qualificação determinística
+ guardrails + idempotência de envio). O agente já roda ponta a ponta no seam
`INBOUND_HANDLER`.

**M7 (provável): CRM + cadência/follow-up + integração de agendamento/handoff** —
fechar o ciclo do lead qualificado: registrar/sincronizar no CRM, agendar de fato,
e fazer **follow-up proativo** (fora da janela de 24h, via template). O agente do M6
já produz os **desfechos estruturados** (intenção de agendamento, handoff, lead
qualificado) que o M7 consome. O escopo final é do prompt do M7; isto é orientação.

> Regra de ouro: **plugar, não reconstruir.** O agente, o estado do lead, a
> idempotência de envio e o metering já existem. O M7 conecta os **seams** que o M6
> deixou prontos e resolve a entrega proativa.

## Princípios (todo o projeto)
- Hexagonal (ports & adapters); núcleo agnóstico a fornecedor (CRM vira um **port**
  novo, com adaptador concreto — não acoplar o core a um CRM específico).
- Isolamento rígido por tenant (RLS `FORCE` + policy `NULLIF`); segredos por tenant
  cifrados (`TenantSecretsStore`, já tem kind `crm_api_key`), plataforma via config;
  nunca em log. TS strict; testes sem rede real (clientes injetáveis).

## Stack
Node 20+ · TS strict · NestJS · Next.js · PostgreSQL 16 + pgvector · Drizzle ·
Redis + BullMQ · Vitest · pnpm.

## Estrutura
```
apps/api   NestJS — auth, webhook+pipeline WhatsApp, Embedded Signup, LLM, RAG, agente
apps/web   Next.js — login, painel, /connect
packages/core            ports (Channel, LLM, Embedding) + registry + cripto/contexto
packages/config          12-factor (zod) — whatsapp, llm, embeddings
packages/db              schema/migrations RLS, repos (secrets, metering, knowledge, agente)
packages/whatsapp-cloud  adaptador Cloud API (M2/M3) — JÁ tem sendTemplate
packages/llm-* / embeddings-openai-compat   adaptadores LLM/embeddings
docs/adr   ADRs 0001-0024
```

---

## Os SEAMS que o M6 deixou prontos para o M7
1. **Intenção de agendamento** — a tool `register_scheduling_intent` (M6) marca
   `turn.schedulingIntent = { when, details }`, mas **só sinaliza** (não persiste
   ainda, não integra calendário). O M7 deve: persistir o desfecho e integrar
   (Google Calendar/CRM). Hoje o seam vive em `apps/api/src/agent/tools.ts`.
2. **Handoff** — `request_human_handoff` + a escalada **determinística** de lead
   `qualified` setam `lead_profiles.status = 'handoff'`/`'qualified'`. O M7 deve
   **notificar o time** (CRM/Slack/e-mail) e/ou criar a oportunidade no CRM.
3. **Estado do lead** — `lead_profiles` (tenant-scoped): `stage`, `status`
   (`new`/`qualified`/`disqualified`/`handoff`), `score`, `fields` (jsonb com os
   campos qualificados), `summary`. É a fonte para sincronizar com o CRM.
4. **Idempotência de envio** — `agent_response_claims` + `claimAgentResponse(key)`.
   O follow-up proativo do M7 DEVE usar a mesma tabela com chaves próprias (ex.:
   `cadence:{leadId}:{stepN}`) para não disparar a mesma mensagem 2×.
5. **Envio por TEMPLATE (fora da janela 24h)** — o adaptador `@sdr/whatsapp-cloud`
   já expõe `sendTemplate` (a port `ChannelProvider` tem `sendTemplate`). O `reply()`
   do M6 **recusa** free-form fora da janela; o follow-up proativo do M7 precisa do
   caminho de **template** (HSM aprovado pela Meta) — é o que falta ligar.

## O que o M6 ENTREGOU (consumir)
- **Agente** no `INBOUND_HANDLER` (`AgentMessageHandler`): contexto em camadas, RAG,
  loop de tool-calling com guardrails (teto de iterações/custo), qualificação
  determinística (`decideQualification`, pura), envio idempotente.
- **Config do agente por tenant** (`agent_configs`, data-driven; `AgentConfigService`
  com default + override validado/clampado). O M7 pode adicionar campos de config de
  CRM/cadência aqui (mesmo padrão).
- **LLM/RAG/metering** prontos (`LlmService`, `KnowledgeRetriever`, `recordUsage`).
- **Registry de tools** extensível: tools de CRM/agendamento entram aqui sem mexer
  no loop (mesma `AgentTool`).

## Escopo provável do M7 (orientação)
1. **Port de CRM** (core, agnóstico) + adaptador concreto (ex.: HubSpot/Pipedrive
   ou um genérico HTTP). Injetável; sem rede real nos testes. Chave por tenant via
   `crm_api_key` (já existe o kind).
2. **Sincronização do lead → CRM** no handoff/qualificação (criar/atualizar
   contato + oportunidade), idempotente.
3. **Agendamento real** a partir da intenção registrada (calendário/CRM).
4. **Cadência/follow-up proativo**: jobs BullMQ que, fora da janela de 24h, enviam
   **templates** aprovados, com idempotência (`agent_response_claims`) e respeitando
   opt-out. Estado de cadência em tabela(s) nova(s) tenant-scoped.
5. **Notificação de handoff** ao time humano.

## Contratos a honrar (continuam valendo)
- Núcleo agnóstico: CRM/calendário são **ports** com adaptadores; nada de fornecedor
  no core (o teste estrutural de agnosticismo deve continuar passando — talvez
  estendê-lo p/ banir SDKs de CRM no core).
- Tabelas novas tenant-scoped: `tenant_id` + `ENABLE`+`FORCE` RLS + policy
  `NULLIF(current_setting('app.tenant_id', true), '')::uuid` + **catálogo RLS** +
  **teste de isolamento**. Migrations `.sql` a partir de **0009** (nunca `.sh`).
- Toda chamada externa (CRM) reporta uso/erros tipados; clientes injetáveis; sem
  rede real nos testes. Segredos só via `TenantSecretsStore`/config; nunca em log.

## Dívida conhecida (o M7 deve/pode resolver)
- **Entrega garantida (outbox)**: hoje envio é **at-most-once** (claim antes do
  send, sem estado `pending/sent/failed`). Para cadência confiável, evoluir
  `agent_response_claims` para um **outbox com status + reparo** (ADR 0024 aponta).
  Mesmo padrão no inbound (`ensureProcessedOnce`, M2) se precisar de entrega forte.
- **Templates fora da janela 24h**: ligar `sendTemplate` (HSM) no caminho proativo.
- **M3**: `TokenExpiryService` reloga tokens expirados sem estado de alerta/refresh.
- **M4**: streaming pelo `LlmService` (só `complete` hoje) + config multi-provedor
  `llm.providers[]` — futuros, não bloqueiam o M7.
- **M5**: busca híbrida (vetor+keyword) — futuro.

## Fora de escopo (do M7, provavelmente)
- Curadoria / niche packs / loop de melhoria do conhecimento (camada de nicho com
  storage próprio — ADR 0021/0022); verticais específicas (M8–M10).
- Transcrição de áudio/visão.

## Como rodar/verificar
Docker Desktop 4.41.2 (macOS 12). `.env` na raiz (gitignored; segredos via openssl).
```bash
docker compose up -d postgres redis
set -a && . ./.env && set +a
pnpm db:migrate && pnpm db:seed
pnpm -r --filter './packages/**' build   # project references → dist
pnpm -r test     # com .env carregado, roda também integração ao vivo
```
Estado: **163 testes** (config 4 · core 27 · whatsapp-cloud 16 · db 27 ·
llm-anthropic 8 · llm-openai-compat 7 · llm-router 7 · embeddings-openai-compat 11 ·
api 56). Gotchas: GUC custom do PG volta a `''` (não NULL) → `NULLIF` na policy;
`AsyncLocalStorage` com `enterWith` não propaga no guard Nest → `storage.run` +
mutação; bigint volta como string de postgres.js → cast `::int`; literal de
`vector` é `[v1,v2,...]` (parametrizado); **Codex CLI**: rodar com `</dev/null`
senão trava lendo stdin.
