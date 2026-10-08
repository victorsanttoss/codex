# Revisão Técnica e de Produto — SDR IA (fork imobiliário)

> Documento preparado para revisão por ferramenta/equipe externa.
> Gerado em 2026-10-07 a partir de leitura do código (read-only, sem alterar o produto).
> **Legenda de maturidade:** `[IMPLEMENTADO]` existe no código · `[TESTADO]` tem teste automatizado · `[PLANEJADO]` previsto/parcial/TODO.

> **Repositório:** `sdr-ia-imob` — é um **fork** do projeto genérico `sdr-ia`, especializado na vertical imobiliária. Monorepo pnpm (NestJS + Next.js + Postgres + Redis + BullMQ).

---

## ⚠️ Aviso de segredos/PII antes de compartilhar (leia primeiro)

A pedido do escopo, foi feita uma varredura por segredos e dados pessoais. **Não há segredos reais em arquivos versionáveis de código** (seeds/testes usam placeholders como `owner@demo.local`, telefones fictícios, `parque-das-flores` sobregravável por env). Porém, **existem dois arquivos no diretório de trabalho que NÃO devem ser compartilhados** (ambos estão no `.gitignore`, então não entram em um `git clone` limpo, mas **entrariam em um zip/cópia da pasta**):

| Caminho | Tipo | Ação recomendada |
|---|---|---|
| `secrets/sdr-ia-agenda-sa.json` | Chave privada de Service Account do Google (contém `PRIVATE KEY`). Permissão `0600`. | **Rotacionar a chave** no Google Cloud (precaução) e **nunca** incluir ao compartilhar. Confirmar que nunca foi commitada no histórico. |
| `.env` | Variáveis de produção com valores reais. Permissão `0600`. | Compartilhar apenas `.env.example`. **Excluir `.env`** de qualquer pacote enviado. |

Observações: `.gitignore` cobre `.env`, `.env.*` (exceto `.env.example`) e `secrets/` (`.gitignore:2-6`). Não foi possível confirmar via `git` se esses arquivos entraram no histórico porque as Command Line Tools da máquina estão quebradas (`xcrun` ausente) — **recomenda-se verificar o histórico** (`git log -- secrets/ .env`) antes de publicar o repositório. Se forem compartilhar um zip da pasta, **remover `secrets/` e `.env` antes**.

---

## 1. Visão geral

### O que o produto faz
SDR (pré-vendas) de IA que atende leads no **WhatsApp**, **qualifica** pela conversa, **agenda** visita/avaliação e/ou **transfere para um humano**, registrando o resultado em CRM. É **multi-tenant** (várias empresas isoladas), **multi-vertical** (imobiliária, odontologia, solar — por configuração) e suporta canal **oficial** (Meta Cloud API) e **não-oficial** (Baileys).

### Funcionalidades implementadas `[IMPLEMENTADO]`
- Atendimento no WhatsApp (Cloud API + Baileys) com resposta em "bolhas" humanizadas (`apps/api/src/whatsapp/reply-format.ts`).
- Agente de IA com tools, qualificação determinística, RAG e guardrails de custo (`apps/api/src/agent/*`).
- Transcrição de áudio (nota de voz → texto) `[IMPLEMENTADO] [TESTADO]` (`packages/transcription-openai-compat`, `apps/api/src/transcription/*`).
- Agendamento com agenda interna + espelho no Google Calendar, pool multi-recurso (`apps/api/src/calendar/*`).
- Follow-up por cadência com horário comercial, teto de frequência e opt-out LGPD (`apps/api/src/cadence/*`).
- Captação de leads de campanha (Meta Lead Ads) e intake genérico (`apps/api/src/intake/*`).
- CRM: built-in (interno) + conector HTTP genérico + **conector Kommo** (`apps/api/src/crm/*`, `packages/crm-http`, `packages/crm-kommo`).
- Vertical imobiliária: distribuição para corretor, SLA de aceite, workspace do corretor (`apps/api/src/imobiliario/*`).
- Kits de verticais (data-driven), curadoria de conhecimento anonimizada, painel web.

### Partes incompletas / limitações conhecidas
- **CRM Kommo**: construído e com testes unitários, **ainda não validado ponta a ponta** contra uma conta real do Kommo (shapes conferidos contra a API v4 pública) — `[IMPLEMENTADO]`, validação E2E `[PLANEJADO]`.
- **WhatsApp oficial em produção**: o número real ainda não foi conectado; testes feitos no número de teste da Meta (até 5 destinatários). Há bloqueio de forma de pagamento na BM a resolver (não é código).
- **LGPD — exclusão de dados**: **não há** endpoint de "direito ao esquecimento" nem TTL/expurgo de mensagens `[PLANEJADO]` (ver §7).
- **CRM built-in** é simulação em tabelas internas (dev/demo) — para operação real usa-se HTTP/Kommo ou o painel próprio.
- **Odontologia/Solar**: existem como **kit** (config), sem fluxo comercial específico de distribuição (ver §5).
- **Fork vs genérico**: o motor é ~95% compartilhado com `sdr-ia`; mudanças no núcleo exigem merge manual nos dois repositórios (ver §5).

---

## 2. Arquitetura

### Estrutura de pastas
**Apps** (`apps/`):
- `apps/api` — API NestJS: webhooks, filas, workers, agente, CRM, calendário, imobiliário.
- `apps/web` — painel Next.js: configuração do tenant, conversas, CRM, agenda, atendimento.

**Pacotes** (`packages/`):
- `packages/core` — tipos/portas compartilhados (LLMProvider, CrmProvider, contexto de tenant `runWithTenant`, helpers de rede/SSRF, `toE164`).
- `packages/config` — carga/validação de `.env` (12-factor; rejeita placeholders em produção).
- `packages/db` — schema Drizzle, migrations SQL, queries, RLS, cifra de segredos.
- `packages/whatsapp-cloud` — adaptador Meta Cloud API (normalização de webhook, envio, status).
- `packages/whatsapp-baileys` — adaptador Baileys (WhatsApp não-oficial, sessões cifradas).
- `packages/llm-anthropic`, `packages/llm-openai-compat`, `packages/llm-router` — provedores de LLM + roteador com fallback.
- `packages/embeddings-openai-compat` — embeddings (pgvector).
- `packages/transcription-openai-compat` — transcrição de áudio (Whisper/compatível).
- `packages/crm-http` — conector CRM HTTP genérico (anti-SSRF).
- `packages/crm-kommo` — conector Kommo (API v4).

### Tecnologias
Node 20+, TypeScript, pnpm (monorepo); NestJS (API), Next.js (web); Postgres + **pgvector** (via Drizzle ORM); Redis + **BullMQ** (filas); Docker Compose. Provedores externos: **OpenAI** (LLM/embeddings/Whisper), **Anthropic** (LLM), **Meta WhatsApp Cloud API** + **Graph API** (Lead Ads), **Baileys**, **Google Calendar** (Service Account), **Kommo** (CRM opcional).

### Banco de dados
Schema em `packages/db/src/schema.ts`; **~40 migrations** SQL (`packages/db/migrations/0001…0040`). **~47 tabelas tenant-scoped** com **RLS** (`FORCE ROW LEVEL SECURITY`, policy `tenant_isolation` por `current_setting('app.tenant_id')`). Principais grupos:
- Identidade: `tenants`, `users`, `memberships`, `auth_sessions`, `platform_staff`.
- Segredos/auditoria/metering: `tenant_secrets` (cifrado), `audit_log`, `usage_events`, `platform_usage`.
- WhatsApp: `channel_connections` (mapeia `phone_number_id`→tenant), `contacts`, `conversations`, `messages`, `media_objects`, `processed_messages`, `outbox_messages`, `message_templates`, `baileys_sessions`.
- Agente/CRM/agenda: `lead_profiles`, `agent_configs`, `agent_response_claims`, `crm_contacts`, `opportunities`, `activities`, `crm_external_sync`, `appointments`, `calendars` (pool), `notifications`, `cadence_state`.
- Conhecimento/nicho: `knowledge_sources`, `knowledge_chunks` (vetor 1024), `niches`, `tenant_niche`, `niche_configs`, `niche_knowledge`, `curation_candidates`.
- Imobiliária: `imob_agencies`, `imob_brokers`, `imob_assignments`, `imob_events`, `imob_settings`.
Testes de RLS: `packages/db/src/rls-catalog.test.ts`, `packages/db/src/isolation.test.ts` `[TESTADO]`.

### Filas (BullMQ)
| Fila | Papel | Concorrência | Retry |
|---|---|---|---|
| `whatsapp-webhook` (`apps/api/src/whatsapp/webhook.queue.ts`) | processa inbound | 16 | 3×, backoff 1s; fair-scheduling (máx 8 jobs/tenant em voo) |
| `outbox-dispatch` (`apps/api/src/outbox/outbox.worker.ts`) | envio de saída | scheduler (tick 15s), 4 tenants × 50 msgs | reenvio até maxAttempts |
| `cadence-scan` (`apps/api/src/cadence/cadence.worker.ts`) | dispara follow-ups | scheduler (tick 60s) | — |
| `crm-sync` (`apps/api/src/crm/crm-sync.queue.ts`) | sincroniza lead→CRM | 4 | 5×, backoff 2s; jobId dedup por conteúdo |
| `knowledge-ingest` (`apps/api/src/knowledge/knowledge.queue.ts`) | ingestão/embeddings | 4 | 3×, backoff 1s |
| `imob-sla` (`apps/api/src/imobiliario/imob-sla.worker.ts`) | expira/cobra ofertas | scheduler (tick 60s) | — |
| Baileys outbox (session worker) | envio via socket | por sessão | — |

### Serviços externos
OpenAI/Anthropic (LLM via `apps/api/src/llm/llm.service.ts` + `packages/llm-router`), OpenAI (embeddings e Whisper), Meta Cloud API/Graph (WhatsApp e Lead Ads), Google Calendar (`apps/api/src/calendar/google-calendar.service.ts`), Kommo (`packages/crm-kommo`).

### Fluxo de uma mensagem (lead → resposta) `[IMPLEMENTADO] [TESTADO]`
1. **Webhook** `POST /webhooks/whatsapp` (`apps/api/src/whatsapp/webhook.controller.ts`): valida assinatura **HMAC** `x-hub-signature-256`; enfileira e responde 200 rápido (não processa síncrono; descarta forjados sem poluir a fila).
2. **Worker** (`webhook.queue.ts`): fair-scheduling por tenant; chama o pipeline.
3. **Pipeline** (`apps/api/src/whatsapp/inbound-pipeline.service.ts`): normaliza; **roteia multi-tenant** por `phone_number_id` (`resolveConnectionByPhoneNumberId`, fora de contexto de tenant); se a conexão está fora do ar, guarda em **quarentena** (`inbound_quarantine`) para replay.
4. **Núcleo** (`apps/api/src/whatsapp/inbound-core.service.ts`): `runWithTenant` → **FIFO lock por conversa** (`apps/api/src/queue/serialized-runner.ts` + `redis-mutex.ts`, TTL 30s com renovação, teto 180s) → **dedup** (`isMessageProcessed`/`processed_messages`) → persiste inbound → **download+transcrição** de mídia (áudio vira texto e é gravado no histórico via `setInboundTranscription`) → chama o handler.
5. **Handler do agente** (`apps/api/src/agent/agent-message.handler.ts`): guardrails (opt-out, human takeover, não-texto, teto de custo), monta prompt em camadas, chama o LLM com tools, decide qualificação, roteia (agendar/handoff), responde.
6. **Envio** (`makeReply` em `inbound-pipeline.service.ts`): valida janela de 24h; picota em bolhas (`reply-format.ts`); envio idempotente (claim em `agent_response_claims`); grava `outbox`/ledger.
7. **Status**: webhook de status da Meta atualiza `messages.status`; metering em `usage_events`.

---

## 3. Jornada comercial (o que existe no código)

- **Captação** `[IMPLEMENTADO]`: Meta Lead Ads via `apps/api/src/intake/meta-leads.webhook.controller.ts` (handshake + assinatura `X-Hub-Signature-256`, mapeia `pageId→tenant`); intake genérico `POST /integrations/leads` (Make/Zapier/n8n) via `lead-intake.service.ts` (token `x-intake-token`, allowlist por tenant). Primeiro contato ativo é idempotente. Também orgânico (lead manda a 1ª mensagem).
- **Atendimento/Qualificação** `[IMPLEMENTADO]`: `agent-message.handler.ts` conduz o turno; qualificação determinística (`agent/qualification.ts`) decide com base no schema do nicho.
- **Follow-up** `[IMPLEMENTADO]`: cadência (`apps/api/src/cadence/cadence.service.ts`): para ao engajar (stop-on-engagement), respeita horário comercial, teto de frequência, opt-out; só dispara via template aprovado.
- **Agendamento** `[IMPLEMENTADO]`: `apps/api/src/calendar/scheduling.service.ts` (`suggest`, `listSlots`, `book`), tools `get_available_slots`/`book_appointment`, validações (antecedência, janela, grade, colisão), pool de recursos e espelho no Google Calendar (fail-safe se o Google falhar).
- **Transferência para humano** `[IMPLEMENTADO]`: tool `request_human_handoff` + `handoffMessage`; `isHumanTakeover` pausa a IA; na imobiliária, o handoff aciona distribuição para corretor.
- **Registro no CRM** `[IMPLEMENTADO]`: `apps/api/src/crm/lead-outcome.service.ts` (`onTurnEnd`) enfileira `crm-sync` quando o lead fica qualified/handoff/scheduled; `crm-sync.service.ts` normaliza telefone (E.164) e chama o provider (builtin/http/kommo), idempotente por conversa (`crm_external_sync`).

---

## 4. Funcionamento da IA

### Modelos e roteamento `[IMPLEMENTADO] [TESTADO]`
`apps/api/src/llm/llm.service.ts` + `packages/llm-router/src/router.ts`: cadeia de modelos (`LLM_DEFAULT_MODELS`, ex.: `claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-8`), **ordena por custo** e faz **fallback** (erro transiente → retry no mesmo provedor; permanente/sem crédito → próximo). Chave por tenant (cifrada) com fallback de plataforma. Embeddings: `text-embedding-3-small`/compatível, dimensão validada contra a coluna `vector(1024)` (`apps/api/src/knowledge/embedding.service.ts`). Transcrição: Whisper/compatível (`packages/transcription-openai-compat`).

### Prompts (camadas) `[IMPLEMENTADO]`
`apps/api/src/agent/prompt-builder.ts` compõe: **base** (regras de estilo WhatsApp/anti-robô) → **nicho** (`guidance` do kit) → **negócio** (produtos/tom/pode-dizer/não-pode-dizer) → **persona** (tenant) → **conversa** (etapa, resumo, conhecimento recuperado, campos a qualificar) → **agendamento** (quando aplicável). Regras notáveis no `baseLayer`: mensagens curtas, 1 pergunta por vez, pedir nome natural, nunca markdown/colchetes, responder a fala do lead antes de conduzir, **nunca** expor raciocínio/inglês, não repetir saudação.

### Ferramentas do agente `[IMPLEMENTADO]`
`apps/api/src/agent/tools.ts`: `search_knowledge` (RAG), `update_lead_fields` (extração), `request_human_handoff`, `register_scheduling_intent` (quando agenda desligada), `get_available_slots` (com `prefer_end_of_day`), `book_appointment` (reserva real, valida tudo). Loop com guardrails em `agent.service.ts` (`maxToolIterations=4`, teto de custo por turno).

### Memória e fontes `[IMPLEMENTADO]`
Histórico recente orçado por tokens (`context-builder.ts`; `HISTORY_BUDGET=3000`, `SUMMARY_HISTORY_BUDGET=1200`) + **resumo rolante** (`agent.summarize`, dispara ~a cada 5 turnos acima de 20 mensagens). Conhecimento por tenant e por nicho via **RAG** (pgvector, `knowledge-retriever.service.ts`, `topK`/`minScore`).

### Qualificação `[IMPLEMENTADO] [TESTADO]`
`apps/api/src/agent/qualification.ts`: schema vem do **kit/nicho** (campos tipados, `required`, `weight`, `eliminatory`, `qualifyAtScore`). Decisão **determinística** (código, não IA): eliminatórios → obrigatórios → score; rotas `continue_discovery`/`nurture`(desqualificado)/`handoff`(qualificado). Extração de campos por tool + passe fallback (`field-extractor.ts`) com whitelist/coerção de tipo.

### Anti-alucinação `[IMPLEMENTADO] [TESTADO]`
- Instrução explícita: usar **só** o conhecimento recuperado para fatos; nunca inventar preço/prazo (`prompt-builder.ts`).
- Agendamento **nunca inventa horário** — só oferece horários reais da agenda (tools + `scheduling.service.ts`).
- `reply-format.ts` `[TESTADO]`: remove markdown/colchetes `[n]`, remove **preâmbulo de raciocínio vazado** e **dedup de linhas repetidas**, picota em no máx. 3 bolhas.
- Qualificação é determinística (a IA só preenche campos, não decide).

---

## 5. Segmentos (reuso da versão genérica)

### Motor genérico vs configuração
O **motor é agnóstico de vertical** (`apps/api/src/agent/*`, `packages/db`): agente, qualificação, prompts, RAG, filas, WhatsApp não têm hardcode de vertical. O que muda por vertical é **dados do kit** (config), não código.

### Kits (data-driven) `[IMPLEMENTADO]`
`apps/api/src/verticals/kits/*` + `vertical-kit.ts` (interface) + `kit-applier.service.ts` (aplica a um tenant: cria nicho, grava guidance, embeda conhecimento, grava qualificationSchema, materializa templates). Kits presentes (`kits/index.ts`): `imobiliario` (econômico/MCMV, `qualifyAtScore 5`), `imobiliario_alto_padrao`, `imobiliario_loteamento`, `imobiliario_usados`, `odonto` (`qualifyAtScore 2`, compliance CFO), `solar` (`qualifyAtScore 3`, eliminatório conta de luz ≥ R$150). Mapa `IMOB_KIT_BY_PADRAO` escolhe o kit por "padrão" do empreendimento. O nicho governa o `motion` (imob → handoff direto a corretor; odonto → agendamento).

### Odontologia e Solar
`[IMPLEMENTADO como kit]` — são **apenas configuração** (kit + conhecimento), **sem** código específico. Busca por `odonto`/`solar` fora de `kits/` e testes não retorna módulo próprio. Odonto usa o agendamento genérico.

### Imobiliária (código específico — "plugin") `[IMPLEMENTADO]`
`apps/api/src/imobiliario/*` pluga via **hooks `@Optional`** (sem ciclo de módulos): `ImobDistributionService` (distribui no handoff, round-robin por região/capacidade), `ImobBrokerInboundService` (desvia mensagens de corretor do fluxo SDR; menu numérico aceite/status), `ImobSlaWorker` (expira oferta/cobra status), workspace do corretor (JWT com `access_token_version` para revogação). Tabelas `imob_*` (migrations 0037–0040) com RLS. `broker_mode` (`ficha` × `workspace`) grava o modo **na oferta**.

### Duplicação / fork
`sdr-ia-imob` é fork de `sdr-ia`. O motor é ~95% compartilhado; o fork adiciona **agendamento (0034)**, os **4 kits imobiliários** e todo o **módulo imobiliário**. Kits `solar`/`odonto` são praticamente idênticos entre os repositórios. **Implicação:** correções no núcleo (agente/qualificação/tools) precisam ser aplicadas manualmente nos dois repositórios — risco de divergência. Dentro deste repo, os 4 kits imobiliários têm estrutura repetida (cada "padrão" é um arquivo próprio) — duplicação de dados, não de lógica.

---

## 6. Operação em alto volume

- **Concorrência**: webhook worker 16 paralelos com **fair-scheduling** (máx 8 jobs/tenant em voo; excedente reenfileira) — evita que um tenant monopolize (`webhook.queue.ts`). CRM-sync e knowledge-ingest a 4; outbox e cadence por scheduler.
- **FIFO por conversa** `[TESTADO]`: mutex Redis com heartbeat + fencing (`redis-mutex.ts`, TTL 30s renovado, teto 180s, espera 2s). Garante ordem e exclusão por conversa.
- **Dedup em 4 camadas**: inbound (`processed_messages`), outbox (`idempotencyKey`), resposta do agente (`agent_response_claims`), CRM (jobId por conteúdo). Mitiga a reentrega dupla da Meta.
- **Rate-limit de inbound**: `InboundRateLimitService` (~20 msgs/min por conversa, fail-open) `[TESTADO]`.
- **Teto de custo** `[TESTADO]`: `TenantCostGuard` reserva atômica antes do LLM e reconcilia depois; teto por turno e **por dia** por tenant; fail-open se o Redis cair (billing real fica no Postgres).
- **Retries/recuperação**: filas com backoff; **quarentena + replay** para inbound quando a conexão está fora (ADR 0032); semântica **at-least-once** (ADR 0024) — reprocesso é seguro por causa do dedup; contenção de lock vira **requeue** (não queima tentativas).
- **Latência**: pré-trabalho paralelo (RAG + histórico + download/transcrição); resumo rolante reduz tokens por turno. Resposta típica alguns segundos (depende do LLM).
- **Limites de APIs**: timeouts configuráveis (LLM 60s; Kommo/CRM 15s); Meta Cloud API ~80 msg/s por número (limite externo); número de **teste** fala com até 5 destinatários; 1º contato ativo exige **template aprovado**.

---

## 7. Segurança e privacidade

- **Autenticação** `[IMPLEMENTADO] [TESTADO]`: JWT **access/refresh** HS256 (`apps/api/src/auth/*`), verificação pinada ao algoritmo, refresh com `jti` guardado server-side (`auth_sessions`, hash SHA256), **rotação** com detecção de reuso (revoga todas as sessões). Login timing-safe (hash dummy). Throttle de login.
- **Permissões** `[IMPLEMENTADO]`: papéis `owner/admin/agent` (`@Roles` + `roles.guard.ts`); **staff da plataforma** via `x-platform-token` (hash + comparação em tempo constante, `platform-staff.guard.ts`); **token do corretor** (workspace) JWT com `access_token_version` para revogação em massa.
- **Isolamento entre empresas** `[IMPLEMENTADO] [TESTADO]`: **RLS `FORCE`** em ~47 tabelas, deny-by-default, `current_setting('app.tenant_id')`; `runWithTenant`/`withTenant` (`packages/db/src/client.ts`). Caminhos "system" explícitos (resolução por `phone_number_id`, scheduler) rodam fora de tenant. Testes `isolation.test.ts` e `rls-catalog.test.ts`.
- **Armazenamento de conversas** `[IMPLEMENTADO]`: `messages.content` (JSONB), isoladas por RLS. **Sem TTL/expurgo automático** (ver pendências).
- **Dados sensíveis** `[IMPLEMENTADO] [TESTADO]`: `tenant_secrets` com **envelope encryption AES-GCM**, **KEK versionado** (`SECRETS_KEK_V1…` + `SECRETS_KEK_ACTIVE_VERSION`), AAD `tenantId:kind` (impede transplante entre tenants). Cifrados: `whatsapp_token`, `llm_api_key`, `crm_api_key`, `embedding_api_key`, `transcription_api_key`. Conectores de CRM com **anti-SSRF** em 2 barreiras (validação de string + DNS-pin). Redação de segredos no logger.
- **Consentimento/LGPD** `[IMPLEMENTADO parcial]`: opt-out (`contacts.opted_out`, `isOptOutText`, cadência respeita), **mascaramento de telefone em log** (`maskPhone`), curadoria **anonimizada** (rejeita se sobrar PII). **Não há** opt-in explícito antes do processamento por IA.
- **Exclusão de dados** `[PLANEJADO]`: há cascata de FK ao deletar tenant/conversa, mas **não existe endpoint de "direito ao esquecimento"** (anonimizar/apagar um lead específico), nem retenção/expurgo de `messages`/`audit_log`. **Recomendado implementar** para conformidade LGPD.

---

## 8. Métricas

### Eventos registrados `[IMPLEMENTADO]`
- `usage_events` (`recordUsage`, `packages/db/src/usage.ts`): `type` (`llm_call`, `inbound_message`, `outbound_message`, `transcription`, `embedding`), `model`, `channel`, `tokens_in/out`, **`cost_micros`**, `metadata`, `occurred_at` (tenant-scoped). Agregação por período (`aggregateUsage`).
- `platform_usage`: custo de plataforma (ex.: embeddings de curadoria).
- `imob_events`: timeline do funil imobiliário (`qualified`/`offered`/`accepted`/`declined`/`expired`…).
- `audit_log`: operações sensíveis (curadoria, staff) append-only.

### O que dá para medir hoje vs. o que falta
- **Tempo de resposta**: derivável de timestamps de `messages` (inbound→outbound) — **não há métrica pronta**; calculável.
- **Taxa de qualificação**: `lead_profiles.status` via funil do painel (`GET /admin/dashboard`, `crm-read.ts:leadFunnel`) `[IMPLEMENTADO]`.
- **Taxa de agendamento**: `appointments` + status do lead `scheduled` — calculável; sem KPI dedicado no painel genérico.
- **Comparecimento (no-show)**: **não rastreado** (não há status pós-visita) `[PLANEJADO]`.
- **Conversão (venda)**: **não rastreada** no produto (depende do CRM externo) `[PLANEJADO]`.
- **Custo por resultado**: `usage_events.cost_micros` dá custo por tenant/período; "por lead/por agendamento" exige cruzamento (calculável, sem dashboard pronto).
- **Imobiliária**: `GET /admin/imob/overview` traz ofertas/aceites/aceite-no-SLA/tempo médio de aceite/por corretor `[IMPLEMENTADO]`.

---

## 9. Execução e testes

### Como rodar (local)
1. `pnpm install`.
2. `cp .env.example .env` e gerar segredos (`openssl rand -base64 48` p/ JWT; `openssl rand -base64 32` p/ `SECRETS_KEK_V1`).
3. `docker compose up -d postgres redis`.
4. Migrations e seed: `pnpm db:migrate` e `pnpm db:seed` (fork: wrapper `with-imob-env.sh` / `env.imob.sh` força banco/portas do fork; `db:seed:imob` cria o tenant imobiliário).
5. Subir: `./dev-local.sh` (fork roda **web :3100 / api :3101**; o README genérico cita 3000/3001). Login de dev do fork: `owner@demo.local` (senha de seed).
Referências: `README.md`, `package.json` (scripts), `docker-compose.yml`, `dev-local.sh`, `deploy/RUNBOOK-VPS-IMOB.md`.

### Variáveis de ambiente (nomes, sem valores)
- **Banco**: `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `POSTGRES_*`, `APP_DB_*`, `MIGRATOR_DB_*`.
- **Cache/fila**: `REDIS_URL`, `REDIS_PORT`, `REDIS_PASSWORD`.
- **Auth**: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `AUTH_COOKIE_DOMAIN`, `AUTH_COOKIE_SECURE`.
- **Cifra de segredos**: `SECRETS_KEK_V1` (…`V2`…), `SECRETS_KEK_ACTIVE_VERSION`.
- **WhatsApp Cloud**: `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_API_BASE`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_APP_ID`, `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, `WHATSAPP_SYSTEM_USER_TOKEN`.
- **LLM**: `LLM_ANTHROPIC_API_KEY`, `LLM_OPENAI_BASE_URL`, `LLM_OPENAI_API_KEY`, `LLM_DEFAULT_MODELS`.
- **Embeddings**: `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_DIM`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MAX_BATCH`, `EMBEDDINGS_TIMEOUT_MS`, `EMBEDDINGS_RETRIEVAL_TIMEOUT_MS`.
- **Transcrição**: `TRANSCRIPTION_ENABLED`, `TRANSCRIPTION_BASE_URL`, `TRANSCRIPTION_MODEL`, `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_LANGUAGE`, `TRANSCRIPTION_MAX_DURATION_SECONDS`, `TRANSCRIPTION_MAX_BYTES`.
- **Baileys**: `BAILEYS_ENABLED`, `SESSION_WORKER_INDEX`, `SESSION_WORKER_TOTAL`, `BAILEYS_RECONNECT_*`, `BAILEYS_QR_TTL_SECONDS`.
- **Meta Lead Ads**: `META_APP_SECRET`, `META_LEADGEN_VERIFY_TOKEN`, `META_LEADGEN_PAGES`, `META_PAGE_ACCESS_TOKEN`.
- **Intake/CRM**: `LEAD_INTAKE_TOKEN`, `LEAD_INTAKE_TENANTS`.
- **Google Calendar**: `GOOGLE_CALENDAR_SA_JSON`.
- **Plataforma/curadoria**: `PLATFORM_ADMIN_TOKEN`.
- **Imobiliária**: `IMOB_ACCEPT_SLA_MINUTES`, `IMOB_MAX_ATTEMPTS`, `IMOB_FOLLOWUP_HOURS`, `IMOB_MAX_FOLLOWUPS`, `IMOB_PROJECT_NAME`, `IMOB_PLATFORM_READ_TENANTS`, `IMOB_NAME/SLUG/OWNER_EMAIL/OWNER_PASSWORD`.
- **Operação/observabilidade**: `APP_ROLE`, `NODE_ENV`, `LOG_LEVEL`, `WEB_ORIGIN`, `API_PORT`, `WEB_PORT`, `OTEL_*`, `SENTRY_DSN`, `ALERTS_*`, `DOMAIN`, `ACME_EMAIL`, `BACKUP_*`.

### Testes (resultado real desta revisão)
- **~232 arquivos `.test.ts`** no monorepo. Nesta revisão foram executados os **unitários** (sem banco): **~366 testes passando, 0 falhas** (pacotes `core`, `config`, `llm-*`, `whatsapp-*`, `crm-http`, `crm-kommo`, `embeddings`, `transcription`, e unitários da API: agente, qualificação, reply-format, cost-guard, mutex, rate-limit, cadência etc.).
- Os testes de **integração/DB** (`@sdr/db` e `*.integration.test.ts`/`*.e2e.test.ts`, ~34 arquivos) **não foram executados** nesta máquina por falta de Postgres local (ECONNREFUSED 5433) — eles **auto-pulam** sem `DATABASE_URL` e são rodados em ambiente com banco (CI/VPS). Observação: durante o desenvolvimento desta semana, suítes específicas (agente, calendário, CRM, reply-format, kommo) foram executadas e passaram.
- **Limitação do ambiente:** as Command Line Tools da máquina estão quebradas (`xcrun`/`git` indisponíveis), o que impediu checagens via `git` nesta revisão.

---

## 10. Pendências e riscos

### Riscos de segurança (ação imediata)
1. **Chave de Service Account do Google em `secrets/sdr-ia-agenda-sa.json`** — rotacionar por precaução e garantir que não seja compartilhada nem esteja no histórico git.
2. **`.env` presente no diretório de trabalho** — excluir ao empacotar; compartilhar só `.env.example`.

### Pendências de produto/engenharia
- **LGPD**: implementar **exclusão/anonimização de lead** (right-to-be-forgotten) e **retenção/expurgo** de `messages`/`audit_log`; avaliar **opt-in** explícito.
- **WhatsApp oficial**: conectar número real (depende de forma de pagamento na BM + verificação) e aprovar **templates** para 1º contato ativo.
- **Kommo**: validar E2E com conta real (funil/etapa/custom-fields); limitações documentadas (dedup por formato de telefone; nota de sync só na 1ª vez).
- **Métricas de resultado**: não há tracking de **comparecimento (no-show)** nem **conversão/venda**; KPIs de tempo de resposta e custo-por-resultado são calculáveis mas sem dashboard dedicado.
- **Fork × genérico**: definir estratégia para evitar divergência do motor entre `sdr-ia` e `sdr-ia-imob` (merge manual hoje).
- **Verticais**: odonto/solar existem como kit sem fluxo comercial específico; avaliar se precisam de distribuição/integrações próprias.
- **Observabilidade**: há hooks (`OTEL_*`, `SENTRY_DSN`, alertas) — confirmar o que está efetivamente ligado em produção.

### Decisões em aberto
- Modelo(s) de LLM padrão por vertical/tenant (custo × qualidade).
- Estratégia de CRM: built-in próprio vs. Kommo/HTTP por cliente.
- Política de retenção de conversas e de áudio.
- Unificação (ou não) do fork imobiliário com o projeto genérico.

---

*Nota de método:* este documento foi produzido por leitura do código-fonte (read-only); as citações `arquivo:linha` apontam os pontos de verificação. Onde há divergência entre o README genérico e o fork (ex.: portas), prevalece o comportamento do fork. Nenhum segredo, token, dado pessoal ou conversa real de cliente foi incluído neste documento.
