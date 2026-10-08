# SDR IA — Plataforma SDR de IA multi-tenant

Plataforma que atende leads no WhatsApp para vários clientes (tenants) de nichos
diferentes, com um agente de IA. **Módulo 1 (fundação)**: isolamento rígido entre
tenants, credenciais cifradas, autenticação do painel, primitivos de fila e
metering — com as *ports* de canal e LLM definidas (sem adaptador concreto).

## Princípios de arquitetura

- **Hexagonal (ports & adapters).** O núcleo não sabe se a mensagem veio da Cloud
  API da Meta ou de uma via não-oficial, nem se o modelo é aberto/auto-hospedado
  ou por token. Fala com interfaces (`ChannelProvider`, `LLMProvider`).
- **Isolamento rígido por tenant.** Postgres **Row-Level Security** com `FORCE`,
  role de aplicação **sem `BYPASSRLS`**. Vazamento cross-tenant é falha crítica.
- **Tenant-scoped por padrão; caminho "system" explícito e auditado.**

## Stack

Node 24.19.0 · TypeScript strict · NestJS (`apps/api`) · Next.js (`apps/web`) ·
PostgreSQL 16 + pgvector · Drizzle ORM · Redis + BullMQ · Docker · Vitest ·
pnpm workspaces.

## Estrutura

```
apps/
  api/   NestJS — auth/RBAC, contexto, FIFO, metering, webhook+pipeline WhatsApp, LLM, RAG, agente
  web/   Next.js — login + painel (scaffold)
packages/
  core/           domínio: ports, envelope encryption, contexto, contract tests
  config/         validação 12-factor (zod)
  db/             schema Drizzle, migrations (RLS), client withTenant, seed
  whatsapp-cloud/ adaptador concreto da WhatsApp Cloud API (M2)
  llm-anthropic/  adaptador LLM Anthropic (M4)
  llm-openai-compat/ adaptador LLM OpenAI-compatible (self-hosted/por-token, M4)
  llm-router/     catálogo de preços (LLM + embeddings) + roteamento custo/fallback (M4/M5)
  embeddings-openai-compat/ adaptador de embeddings OpenAI-compatible (M5)
  crm-http/       adaptador de CRM externo genérico via HTTP (M7)
docs/adr/ decisões de arquitetura (ADRs curtos)
```
> M8 (cadência/outbox) vive em `apps/api/src/{outbox,cadence}` (sem pacote novo).

## Setup

Pré-requisitos: Node 24.19.0 (`.node-version`), pnpm 9.15.9 (`packageManager`), Docker.

```bash
pnpm install --frozen-lockfile
cp .env.example .env            # preencha os segredos:
#   openssl rand -base64 48     -> JWT_ACCESS_SECRET / JWT_REFRESH_SECRET
#   openssl rand -base64 32     -> SECRETS_KEK_V1
#   defina senhas do Postgres e ajuste DATABASE_URL / MIGRATION_DATABASE_URL

docker compose up -d postgres redis    # sobe Postgres (pgvector) + Redis

# carregue o .env no shell antes de migrate/seed/test:
set -a && . ./.env && set +a

pnpm db:migrate                 # aplica migrations (role migrator)
pnpm db:seed                    # tenant demo + usuário owner@demo.local
```

> O perfil `full` do compose (`docker compose --profile full up`) também sobe
> `api` e `web` a partir dos Dockerfiles.

## Rodar

```bash
pnpm --filter @sdr/api dev      # API em http://localhost:3001
pnpm --filter @sdr/web dev      # Web em http://localhost:3000
```

Login do seed: `owner@demo.local` / senha definida em `SEED_OWNER_PASSWORD`
(padrão `demo-owner-123456`).

## Testes

```bash
pnpm -r test                    # unit (core/config/api) — sempre
# integração (RLS/dedup/metering) exige Postgres no ar + .env carregado:
set -a && . ./.env && set +a && pnpm -r test
```

Os testes de integração do `@sdr/db` se **auto-pulam** sem `DATABASE_URL`.

Validação completa em checkout limpo, com serviços descartáveis e segredos
sintéticos: [CI e reprodução local](docs/CI.md). `pnpm db:migrate:env` usa as URLs
injetadas diretamente; `pnpm db:migrate` preserva o isolamento pessoal do fork
(`.env` + `env.imob.sh`). A CI executa também os HTTP E2E, typecheck e build web.

## Decisões de arquitetura (ADRs)

- [0001 — Isolamento multi-tenant via RLS (FORCE)](docs/adr/0001-isolamento-rls.md)
- [0002 — Envelope encryption de credenciais](docs/adr/0002-envelope-encryption.md)
- [0003 — FIFO por conversa (lock Redis)](docs/adr/0003-fifo-por-conversa.md)
- [0004 — Ports & adapters](docs/adr/0004-ports-and-adapters.md)
- [0005 — Contexto de request (store mutável)](docs/adr/0005-contexto-de-request.md)
- [0006 — Autenticação (JWT access + refresh)](docs/adr/0006-auth-jwt.md)
- [0007 — Verificação do webhook (HMAC + rawBody)](docs/adr/0007-verificacao-webhook.md)
- [0008 — Plataforma × tenant nos segredos](docs/adr/0008-plataforma-vs-tenant-segredos.md)
- [0009 — Janela de 24h](docs/adr/0009-janela-24h.md)
- [0010 — Convenção de conversation_key](docs/adr/0010-conversation-key.md)
- [0011 — FIFO endurecido (heartbeat + fencing)](docs/adr/0011-fifo-heartbeat-fencing.md)
- [0012 — Embedded Signup e estratégia de token](docs/adr/0012-embedded-signup-token.md)
- [0013 — Tenant binding do signup via sessão](docs/adr/0013-tenant-binding-signup.md)
- [0014 — Guard de conflito de número](docs/adr/0014-guard-conflito-numero.md)
- [0015 — Lifecycle de conexão (três gatilhos)](docs/adr/0015-lifecycle-conexao.md)
- [0016 — Adaptadores de LLM (Anthropic + OpenAI-compatible)](docs/adr/0016-adaptadores-llm.md)
- [0017 — Catálogo de preços (plataforma) e custo](docs/adr/0017-catalogo-precos.md)
- [0018 — Roteamento por custo + fallback](docs/adr/0018-roteamento-custo-fallback.md)
- [0019 — Modelo e dimensão de embeddings (PT-BR)](docs/adr/0019-modelo-dimensao-embeddings.md)
- [0020 — Índice vetorial (HNSW + cosseno)](docs/adr/0020-indice-vetorial-hnsw-cosine.md)
- [0021 — Conhecimento em camadas + retriever componível](docs/adr/0021-conhecimento-em-camadas-retriever-componivel.md)
- [0022 — Composição do agente em camadas](docs/adr/0022-composicao-prompt-em-camadas.md)
- [0023 — Qualificação determinística (IA extrai, código decide)](docs/adr/0023-qualificacao-deterministica.md)
- [0024 — Idempotência de envio do agente](docs/adr/0024-idempotencia-de-resposta.md)
- [0025 — Ports de CRM, agendamento e notificação](docs/adr/0025-ports-crm-agendamento-notificacao.md)
- [0026 — Idempotência de sincronização com o CRM](docs/adr/0026-idempotencia-de-sync-crm.md)
- [0027 — Outbox de saída (at-least-once com dedup)](docs/adr/0027-outbox-at-least-once.md)
- [0028 — Cadência data-driven + guardrails no envio](docs/adr/0028-cadencia-data-driven.md)
- [0029 — Opt-out e compliance (LGPD / anti-ban)](docs/adr/0029-optout-lgpd.md)
- [0030 — RLS por nicho (conhecimento compartilhado)](docs/adr/0030-rls-por-nicho.md)
- [0031 — Curadoria humana + anonimização (zero PII)](docs/adr/0031-curadoria-anonimizacao.md)
- [0032 — Versionamento, ToS/LGPD e metering de curadoria](docs/adr/0032-versionamento-tos-metering-curadoria.md)
- [0033 — Kits de vertical declarativos + platform_authored](docs/adr/0033-kits-de-vertical.md)
- [0034 — Schema de qualificação em camadas (default → nicho → tenant)](docs/adr/0034-schema-qualificacao-por-nicho.md)
- [0035 — Deploy em VPS única com separação por role](docs/adr/0035-deploy-vps-roles.md)
- [0036 — Ponto único de falha, backup externo e monitor externo](docs/adr/0036-ponto-unico-backup-externo.md)
- [0037 — Port de transcrição (STT) openai-compatible](docs/adr/0037-transcricao-openai-compatible.md)
- [0038 — Enriquecimento de áudio na pipeline (áudio → texto)](docs/adr/0038-enriquecimento-audio-pipeline.md)
- [0039 — Topologia session-worker (canal não-oficial Baileys)](docs/adr/0039-baileys-topologia-session-worker.md)
- [0040 — Persistência cifrada de sessão Baileys](docs/adr/0040-baileys-persistencia-sessao-cifrada.md)
- [0041 — Canal não-oficial (Baileys): risco/ToS e default oficial](docs/adr/0041-canal-nao-oficial-risco-tos.md)
- [0042 — Design system V4 (tokens→componentes) e duas áreas por papel](docs/adr/0042-ui-design-system-v4-dois-papeis.md)
- [0043 — Playground sandbox (testar a SDR sem WhatsApp)](docs/adr/0043-playground-sandbox.md)

Operação: [Runbook](docs/RUNBOOK.md) · [Monitor de uptime externo](deploy/uptime-monitor.md).

Revisões de arquitetura (Codex): [M1 core](docs/M1-codex-review.md) ·
[M1 db+api](docs/M1-codex-review-db-api.md) · [M2](docs/M2-codex-review.md) ·
[M3](docs/M3-codex-review.md) · [M4](docs/M4-codex-review.md) ·
[M5](docs/M5-codex-review.md) · [M6](docs/M6-codex-review.md) ·
[M7](docs/M7-codex-review.md) · [M8](docs/M8-codex-review.md) ·
[M9](docs/M9-codex-review.md) · [M10](docs/M10-codex-review.md) ·
[M11](docs/M11-codex-review.md) · [M12](docs/M12-codex-review.md) ·
[M13](docs/M13-codex-review.md) · [M14](docs/M14-codex-review.md).

## LLM (M4)

Infraestrutura de LLM (adaptadores + roteamento por custo/fallback). O **agente**
que consome o LLM é o M6 — a pipeline do M2 segue no echo stub.

- **Chaves:** por tenant via `TenantSecretsStore` (kind `llm_api_key`); plataforma
  via `LLM_ANTHROPIC_API_KEY` (fallback). `LLM_DEFAULT_MODELS` define a cadeia.
- **`LlmService`** (api) monta um `LlmRouter` por tenant: ordena os modelos por
  custo (mais barato primeiro), faz retry/backoff em transiente e fallback
  (cross-provider) em permanente, e grava `recordUsage(type: llm_call, costMicros)`
  para o modelo que respondeu.
- Adaptadores: `@sdr/llm-anthropic` (SDK oficial) e `@sdr/llm-openai-compat`
  (`baseURL` configurável → self-hosted ou provedor por token). Ambos passam a
  contract suite e suportam tool-calling + streaming.

## Conhecimento / RAG (M5)

Infraestrutura de conhecimento (embeddings + busca vetorial). O **agente** que
consome o conhecimento é o M6 — a pipeline do M2 segue no echo stub.

- **Embeddings:** `@sdr/embeddings-openai-compat` (`baseURL` configurável →
  self-hosted vLLM/Ollama **ou** provedor por token), modelo default `bge-m3`
  (PT-BR), dimensão **1024**, distância **cosseno**, índice **HNSW**. Chave por
  tenant via `TenantSecretsStore` (`embedding_api_key` → `llm_api_key`) ou
  plataforma (`EMBEDDINGS_API_KEY`); self-hosted dispensa chave.
- **Ingestão (assíncrona, BullMQ):** `chunk → embed → persist`, idempotente por
  `content_hash` (re-ingerir o mesmo conteúdo não re-embeda; muda → substitui os
  chunks, sem duplicar). `reindex` re-embeda fontes existentes.
- **Recuperação:** `KnowledgeRetriever.search(query)` — embeda a query, faz KNN
  isolado por tenant (RLS) e mescla por score. **Componível**: hoje só a fonte do
  tenant; base/nicho entram sem mudar a assinatura (ADR 0021).
- **Config:** `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_DIM` (= coluna
  `vector(N)`), `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MAX_BATCH`,
  `EMBEDDINGS_TIMEOUT_MS` (ingestão/plataforma; suba p/ self-hosted em CPU) e
  `EMBEDDINGS_RETRIEVAL_TIMEOUT_MS` (caminho quente da conversa — mantenha curto;
  ambos default 15s).

Endpoints (admin, no contexto do tenant):
```bash
# ingerir uma fonte (assíncrono — enfileira e responde queued)
curl -X POST localhost:3001/admin/knowledge/sources \
  -H "authorization: Bearer <ADMIN>" -H 'content-type: application/json' \
  -d '{"externalRef":"faq-v1","kind":"faq","title":"FAQ","content":"..."}'

curl -X POST localhost:3001/admin/knowledge/sources/faq-v1/reindex -H "authorization: Bearer <ADMIN>"

# buscar (ops/verificação; o M6 usa o KnowledgeRetriever internamente)
curl -X POST localhost:3001/admin/knowledge/search \
  -H "authorization: Bearer <ADMIN>" -H 'content-type: application/json' \
  -d '{"query":"como cancelar?","topK":5}'
```

## Áudio / Transcrição (M12)

Quando o lead manda **áudio**, a pipeline transcreve e injeta o texto no loop do
agente (M6) **sem mudar o handler** — o agente trata como uma mensagem de texto
comum. Falha/desligado/limite → cai na política não-texto do M6 ("me manda por
texto"). **Visão fica fora de escopo** (follow-up de LLM multimodal, não uma port).

- **STT:** `@sdr/transcription-openai-compat` — POST multipart em
  `/audio/transcriptions`, `baseURL` configurável → **Whisper self-hosted**
  (faster-whisper/whisper.cpp) **ou** provedor por token. Trata OGG/Opus do
  WhatsApp, dica de idioma **PT** default, `verbose_json` p/ duração (metering),
  retry/backoff, HTTP injetável. Chave por tenant (`transcription_api_key` →
  `llm_api_key` → plataforma); self-hosted dispensa chave.
- **Preço fail-closed** (`@sdr/llm-router`, USD/minuto): modelo sem preço **lança**;
  self-hosted entra com `{ perMinute: 0 }` explícito. Duração ausente de modelo pago
  cobra pelo **teto** (nunca 0).
- **Idempotência:** transcrição cacheada na `media_objects` por `provider_media_id`
  — reentrega não re-transcreve nem re-cobra. Cache persistido **antes** do metering.
- **Freios de custo:** teto de **tamanho** pré-download (a Media API informa
  `file_size`) e pré-cobrança; teto de **duração** pós-transcrição (não injeta áudio
  longo). O teto de custo por conversa do M6 segue intacto no turno do LLM.
- **Config:** `TRANSCRIPTION_ENABLED` (`false` desliga), `TRANSCRIPTION_BASE_URL`,
  `TRANSCRIPTION_MODEL`, `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_LANGUAGE`,
  `TRANSCRIPTION_MAX_DURATION_SECONDS`, `TRANSCRIPTION_MAX_BYTES`.

## Interface da plataforma (M14)

Painel **Next.js** (`apps/web`) fiel ao design **V4** (Montserrat, tokens em
`app/globals.css`), em **duas áreas por papel** (ADR 0042): **Cliente** (tenant) e
**Plataforma** (staff). O design aprovado vive em `design_handoff_sdr_v4/`
(gitignored). Rodar: `pnpm dev` → http://localhost:3000 (login seed
`owner@demo.local` / `demo-owner-123456`).

- **Área do cliente** (`app/(client)/*`, JWT do tenant): **Início** (KPIs+funil+
  atividade), **Conversas** (transcrição estilo WhatsApp + áudio/transcrição +
  **assumir conversa** → pausa a IA), **Leads** (filtros+tabela+estados+detalhe com
  "por que score X"), **Playground** (sandbox), **Configuração** (hub + persona/
  guardrails editável + qualificação), **Conta & uso** (custos/compliance/equipe).
- **Onboarding** (`/onboarding`): wizard de 8 etapas, reentrável, **autosave por
  etapa** (`tenant_onboarding`), linguagem sem termos técnicos, ativa a SDR ao fim.
- **Playground** (ADR 0043): roda o **agente real** numa conversa **sandbox**
  (`conversations.sandbox`), captura resposta + RAG + qualificação + custo + score —
  **sem** enviar WhatsApp/CRM/cadência. Testa a SDR sem número conectado.
- **APIs de leitura** (`/admin/*`, tenant-scoped/RLS): `leads` (lista+detalhe),
  `conversations`, `dashboard` (funil+uso), `settings`/`account`. **Pipeline e agente
  permanecem intocados** (assumir conversa e sandbox são seams/guardrails).
- **Área da plataforma** (`app/(platform)/plataforma/*`, `x-platform-token`):
  Visão global, Tenants (impersonar), Nichos, **Curadoria** (fila por nicho:
  zero-PII, aprovar/rejeitar/promover — reusa M9), Templates HSM, Operação, Staff.

## Canal não-oficial — Baileys (M13)

> ⚠️ **O Baileys viola os Termos do WhatsApp**: o número do cliente **pode ser
> banido a qualquer momento**. **O default do produto é a Cloud API oficial**; o
> Baileys é **opção consciente por tenant** (mais barato, sem dependência da Meta),
> atrás da **mesma port `ChannelProvider`** (ADR 0041). Liga-se com `BAILEYS_ENABLED`.

- **Adaptador `@sdr/whatsapp-baileys`** implementa a mesma port (passa
  `runChannelProviderContract`), com **Baileys atrás de interface injetável**
  (`BaileysDriver`) — testes sem rede/QR. Inbound por **evento** (não webhook):
  serializa em envelope canônico e entra na **mesma pipeline** (dedup → FIFO →
  agente). `sendTemplate` **sem HSM** → vira texto normal.
- **Topologia session-worker** (ADR 0039): role `session-worker` mantém os sockets
  vivos; cada número é **sticky** a um worker (`hash(número) % total`). Envio
  proativo é roteado ao **worker dono** do socket (o scheduler só cuida do Cloud).
  Lifecycle com **auto-reconnect** (backoff) via loop de reconcile; `logout` →
  conexão sai do roteamento + alerta + exige novo QR.
- **Sessão cifrada** (ADR 0040): auth state por número em `baileys_sessions` (RLS,
  envelope encryption, AAD `tenant:phone`) → reconecta sem novo QR. Nunca em log.
- **Onboarding por QR**: `POST /admin/whatsapp/baileys/connect` registra o número;
  o session-worker publica o QR (Redis, TTL curto) e o painel (`/connect-baileys`)
  faz poll até `connected`. Guardrails do M8 valem com rigor maior.
- **Config:** `BAILEYS_ENABLED`, `SESSION_WORKER_INDEX`/`TOTAL`, `BAILEYS_RECONNECT_*`,
  `BAILEYS_QR_TTL_SECONDS`. Produção: `pnpm add @whiskeysockets/baileys` no
  session-worker (dependência opcional, import preguiçoso).

```bash
# Onboarding (admin, contexto do tenant): registra e gera QR
curl -X POST localhost:3001/admin/whatsapp/baileys/connect \
  -H "authorization: Bearer <ADMIN>" -H 'content-type: application/json' \
  -d '{"phoneNumber":"5511999999999"}'
# Poll do QR/estado até "connected"
curl "localhost:3001/admin/whatsapp/baileys/qr?phoneNumber=5511999999999" -H "authorization: Bearer <ADMIN>"
```

## Operação / Deploy em VPS (M11)

Deploy always-on numa **VPS Linux única** com Docker Compose. A mesma imagem roda em
**três roles** (`APP_ROLE`): `api` (HTTP, ×2 atrás do Caddy), `worker` (filas BullMQ)
e `scheduler` (cron/scans) — ADR 0035.

- **`docker-compose.prod.yml`** + `apps/api/Dockerfile.prod` (multi-stage, não-root):
  `caddy` (TLS automático, único público) → `api`×2; `worker`; `scheduler`; `postgres`
  /`redis` **só na rede interna** (sem `ports:`). `restart: always`, `mem_limit`, log
  rotation, `stop_grace_period` + **shutdown gracioso** (drena jobs em voo).
- **Deploy quase-sem-downtime** (`deploy/deploy.sh`): build → migrate → restart das
  réplicas de `api` **uma a uma** (Caddy LB com health-check) → smoke. Single-host não
  dá zero-downtime perfeito; a reentrega de webhook da Meta + dedup cobrem o gap.
- **Segurança da VPS** (`deploy/bootstrap-vps.sh`): ufw (só SSH+80+443), SSH só chave,
  unattended-upgrades, swap, rotação de log. **Backup cifrado para fora da VPS**
  (`deploy/backup.sh`, restore testado no runbook). **Monitor de uptime externo**
  (a VPS não se monitora caída) — ADR 0036.
- **Refresh de token proativo** (resolve a dívida do M3) + **alertas internos** no
  `scheduler` (disco, token, outbox falho, conexão caída).
- **CI** (`.github/workflows/ci.yml`): instalação congelada + build da API +
  typecheck + migrate + testes de integração + HTTP E2E + build web com fonte local.

> ⚠️ VPS única = **ponto único de falha** (consciente). Caminho de HA documentado no
> [Runbook](docs/RUNBOOK.md).

## Verticais reais (M10)

Popula e operacionaliza nichos com **kits declarativos** por vertical (a máquina é
o M9; o M10 é o conteúdo). Nicho = **vertical × motion** (`agendamento`,
`orcamento_cotacao`, `alto_ticket_consultivo`, `matricula`).

- **`VerticalKit`** (um arquivo por vertical): `version`, `niche` (vertical/motion),
  `guidance`, `knowledge[]` (objeções/perguntas/vocabulário/faq/document_request),
  `qualificationSchema`, `templates[]` (HSM), `compliance?`.
- **`KitApplierService.apply(kit)`** (ADR 0033): cria o nicho, grava a guidance,
  promove o conhecimento como **`platform_authored`** (versionado, sem duplicar),
  grava o **schema de qualificação do nicho** e o catálogo de templates — **pelos
  seams do M9**, com guard de PII. **Idempotente por `version`** (reaplicar a mesma
  versão é no-op; versão maior versiona e aposenta a anterior; rollback por `retire`).
- **Schema em camadas** (ADR 0034): a qualificação resolve **tenant > nicho >
  default** — um tenant atribuído ao nicho **herda** o schema da vertical sem
  configurar nada; a função determinística do M6 consome o schema resolvido.
- **3 verticais piloto**: solar (referência completa), odontologia (com
  `compliance.notes` do CFO), imobiliário. Conteúdo é **semente** — exige revisão de
  especialista/conformidade; a curadoria do M9 refina com dados reais.

Rotas: `/platform/kits/:id/apply` (staff de plataforma). Templates HSM são
materializados por tenant com `status='pending'` (aprovação na Meta é externa).

## Camada de nicho + curadoria (M9)

O diferencial: conhecimento **curado e compartilhado** entre tenants do mesmo nicho
(vertical × motion), com três inegociáveis — **zero PII**, **curadoria humana
obrigatória**, **isolamento por nicho**.

- **Consumo**: `niche_knowledge` (storage de plataforma) com **RLS por `app.niche_id`**
  (ADR 0030). O nicho do tenant é resolvido **no servidor** (`tenant_niche`); o
  `NicheKnowledgeSource` é somado ao retriever (mescla por score, dim 1024) e o
  `nicheLayer` injeta a orientação do nicho no prompt — **sem refatorar** agente/RAG.
- **Produção (loop de curadoria)**: mineração lê conversas que **converteram** (sob
  `withTenant`), extrai um **padrão generalizável** (não verbatim) e cria um
  `curation_candidate` **anonimizado** (regex de PII + recusa se sobrar). Um curador
  **aprova** (gate humano — sem auto-promoção); a promoção embeda e versiona em
  `niche_knowledge` (`active`/`retired`, rollback por `retire`) — ADR 0031/0032.
- **Isolamento**: tenant lê só o próprio nicho e **não escreve**; `curation_candidates`
  são **invisíveis a tenants** (acesso só via `app.curation`). Custo de curadoria é da
  **plataforma** (`platform_usage`), nunca do tenant.

Rotas de curadoria são **staff de plataforma** (`/platform/...`, `PlatformGuard` por
token `PLATFORM_ADMIN_TOKEN`, fora do JWT do tenant). Verticais reais (popular nichos
de saúde/solar/imobiliário) são o M10 — o M9 é a **máquina** de nicho.

## Cadência / follow-up proativo (M8)

Reengaja leads que esfriaram, **fora da janela de 24h**, via **templates aprovados
(HSM)** — com entrega confiável e compliance em primeiro lugar.

- **Outbox de entrega** (ADR 0027): `outbox_messages` (`pending → sending → sent →
  delivered/read/failed`). Worker reivindica (`SKIP LOCKED`, recupera órfãs por
  *lease*), envia com `client_message_id` (= `biz_opaque_callback_data` → dedup no
  provedor) e reconcilia pelos status do webhook. **At-least-once, entrega ≤1.**
- **Motor de cadência** (ADR 0028, **opt-in**): regras por tenant (passos, atrasos,
  horário comercial + fuso `America/Sao_Paulo`, teto de frequência, máx. de passos),
  data-driven e clampadas. O worker varre cadências vencidas e **re-checa todos os
  guardrails no envio**; só então enfileira o template no outbox (idempotente por
  passo).
- **Compliance / anti-ban** (ADR 0029), cada um testado:
  - **opt-out (LGPD)**: inbound de saída marca o contato e nunca mais cadeia;
  - **stop-on-engagement**: qualquer inbound cancela a cadência;
  - **para** ao qualificar/handoff; **adia** fora do horário comercial ou acima do
    teto de frequência.
- **Metering**: envio por template é marcado como **pago** (distinto do serviço
  gratuito na janela).

Configuração por tenant fica no jsonb de `agent_configs` (chave `cadence`);
templates aprovados em `message_templates`. A cadência vem **desabilitada** por
default — o tenant habilita conscientemente.

> O `reply()` reativo ainda envia direto (M2); unificá-lo no outbox é follow-up
> imediato (ADR 0027).

## Agente SDR (M6)

O agente substitui o `EchoMessageHandler` (M2) no seam `INBOUND_HANDLER` — a
pipeline não muda. Roda no contexto do tenant, no FIFO por conversa e no worker
(com retry). Por turno:

1. **Contexto em camadas** (`composeSystemPrompt`): base (SDR) → nicho (vazio hoje)
   → tenant (persona/negócio/guardrails, data-driven) → conversa (etapa, **resumo
   rolante**, **conhecimento recuperado com fonte**, schema de qualificação).
   Histórico montado de `messages` dentro de um orçamento de tokens.
2. **RAG proativo** + tool `search_knowledge` (KNN isolado por tenant).
3. **Loop de tool-calling** (`AgentService`) com **teto de iterações e de custo**;
   tools: `search_knowledge`, `update_lead_fields`, `request_human_handoff`,
   `register_scheduling_intent`.
4. **Qualificação determinística** (ADR 0023): a IA só **preenche** o schema
   (`update_lead_fields`); o **código decide** (`decideQualification`, função pura)
   → `qualified`/`disqualified`/`pending` + score + estado do lead em `lead_profiles`.
5. **Resposta idempotente** (ADR 0024): cada envio reivindica
   `(tenant, conversa, msg, passo)` em `agent_response_claims` **antes** de chamar a
   Cloud API → no máximo um envio por passo, mesmo sob retry do worker.
6. **Guardrails**: falha total do LLM → contenção + handoff (sem quebrar/duplicar);
   mensagem não-texto → resposta graciosa (transcrição de áudio é futuro).

Config do agente por tenant (persona, schema de qualificação, guardrails) em
`agent_configs` (jsonb) — default de plataforma com override do tenant. A camada de
nicho entra no resolver depois, sem mudar o handler (ADR 0022).

## CRM + agendamento + handoff (M7)

Fecha o ciclo reativo do lead. Ao fim do turno, o agente chama
`LeadOutcomeService.onTurnEnd(...)` com o desfecho estruturado:

- **Sync com o CRM** (lead `qualified`/`handoff`): job BullMQ idempotente —
  `upsertContact` (dedup por telefone) + `upsertOpportunity` (por contato) +
  atividade; o mapa `crm_external_sync` registra os IDs externos. Retry ou novo
  handoff do mesmo lead **não duplica** (ADR 0026).
- **Agendamento**: a intenção registrada pela tool vira `appointments` (fuso
  `America/Sao_Paulo`), idempotente por chave.
- **Notificação de handoff**: registrada **uma vez** (idempotente) p/ o time.

**Agnóstico (ADR 0025):** CRM/agendamento/notificação são *ports*. O **built-in**
(tabelas internas) é o default — o produto funciona sem CRM externo. O adaptador
externo `@sdr/crm-http` (HTTP genérico) cobre HubSpot/Pipedrive/webhook próprio;
chave por tenant via `crm_api_key`. Config por tenant (qual adapter, baseURL, fuso)
é data-driven e validada. O teste estrutural do core bane SDKs de CRM.

> A **cadência/follow-up proativo** (fora da janela 24h, via template) e o **outbox**
> de entrega garantida ficam para o M8.

## Canal WhatsApp (M2)

Adaptador Cloud API oficial (`@sdr/whatsapp-cloud`) + pipeline real de mensagem.

Configure os segredos da **plataforma** no `.env` (`WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN`). Registre a conexão de um tenant (admin):

```bash
# token do tenant + mapeamento phone_number_id -> tenant (guarda o token cifrado)
curl -X POST localhost:3001/admin/whatsapp/connections \
  -H "authorization: Bearer <ACCESS_TOKEN_ADMIN>" -H 'content-type: application/json' \
  -d '{"phoneNumberId":"<PNID>","accessToken":"<TOKEN_DO_TENANT>","displayPhone":"+55..."}'
```

Webhook (configurar na Meta apontando para a app):
- `GET /webhooks/whatsapp` — verificação (challenge).
- `POST /webhooks/whatsapp` — eventos. Pipeline: assinatura → resolve tenant por
  `phone_number_id` → dedup → FIFO por conversa → persiste → baixa mídia →
  handler (echo no M2) → outbound (respeita janela 24h) → metering. Eventos
  `account_update` (lifecycle) são tratados à parte (M3).

### Onboarding automático — Embedded Signup (M3)
Em vez do registro manual, o tenant conecta o número pelo Embedded Signup da Meta.
Config de plataforma: `WHATSAPP_APP_ID`, `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`.
- **Web**: `/connect` (FB JS SDK) → envia `{code, phoneNumberId, wabaId}`.
- **API** (`@Roles('admin')`, tenant da sessão):
  - `GET /admin/whatsapp/signup/config` — config pública p/ o front.
  - `POST /admin/whatsapp/signup/callback` — troca code→token, subscreve WABA,
    registra número, guarda token cifrado + cria a conexão. Conflito de número →
    409; mesmo tenant → reconexão.
  - `POST /admin/whatsapp/connections/:pnid/disconnect` | `/revoke` — lifecycle.
- **Lifecycle automático**: token inválido no envio → `disconnected`; evento
  `account_update` (ban/violação) → `revoked`/`disconnected`; job alerta tokens
  perto de expirar. O resolver do M2 só roteia conexões `active`.
- `POST /admin/whatsapp/connections` (registro manual) permanece como fallback.

## Fora de escopo (módulos seguintes)

Adaptador não-oficial (Baileys); **CRM, curadoria, niche packs, verticais
(M7–M10)**; integração real de calendário/CRM (o agente só persiste o desfecho
estruturado); transcrição de áudio/visão; busca híbrida (vetor + keyword); cadência/
follow-up proativo fora da janela de 24h. Envio de mídia/interativo (estende a port)
— futuro.
