# Checkpoint — estado atual (retomar em sessão nova)

_Atualizado: 2026-07-07. Para a próxima sessão começar sem carregar todo o contexto._

## Onde tudo está
- **100% local** em `~/projetos/sdr-ia` (macOS). Git local **sem remoto** (nunca
  enviado a servidor). Postgres+Redis rodam local via Docker
  (`sdr_postgres`/`sdr_redis`). **Nenhum deploy em produção** — os arquivos de
  deploy (M11) existem, mas nada está no ar.
- **Backup (2026-07-06)** em `iCloud Drive/Backups-SDR-IA/`: `sdr-ia-2026-07-06.bundle`
  (git completo, verificado — restaurar com `git clone <bundle>`) +
  `sdr-db-2026-07-06.sql.gz` (pg_dump, 36 tabelas). Refazer o backup:
  `git bundle create <arquivo> --all` + `docker exec sdr_postgres pg_dump -U postgres -d sdr | gzip`.

## O que está PRONTO (M1–M14, 445 testes verdes)
Motor completo de SDR: WhatsApp → entende (incl. **áudio/transcrição**, M12) →
agente IA (conversa + tool-calling + qualificação determinística + guardrails) →
CRM/agendamento/handoff (backend, M7) → cadência/follow-up + outbox (M8) →
camada de nicho + curadoria (M9) + kits de vertical (M10) → operação/deploy em VPS
(M11) → **canal não-oficial Baileys** (M13, session-worker sticky) →
**INTERFACE completa** (M14, Next.js fiel ao design V4). Hexagonal, multi-tenant
com RLS, segredos cifrados. Detalhe por módulo: memória `projeto-sdr-ia` +
`docs/adr/*` + `docs/M*-codex-review.md`.

**M14 (interface):** 6 épicos — fundação (tema/tokens, sidebars, roteamento por
papel, login split); onboarding wizard 8 etapas (autosave); operação
(Dashboard/Conversas com assumir→pausa IA/Leads + APIs de leitura tenant-scoped);
Playground sandbox (agente REAL, não envia); Configuração (persona/guardrails) +
Conta; Área da Plataforma (staff). Login seed `owner@demo.local` /
`demo-owner-123456`; plataforma via `PLATFORM_ADMIN_TOKEN`.

## Sessão de RODAR LOCAL (commitada em 2026-07-06)
Colocamos o caminho do cliente ponta a ponta no ar sem chave paga:
- **LLM/embeddings via Ollama** (openai-compat): `bge-m3` (dim 1024) + `qwen2.5:3b`.
  Branch openai-compat no `LlmService` (`LLM_OPENAI_BASE_URL`), preço {0,0}.
- **Baileys** (QR): conexão registra `connecting` e só vira `active` no pareamento
  real; QR renderiza como imagem; estado vazio + auto-refresh de sessão no web.
- Tenant real **Clínica Sorriso** (`owner@sorriso.local` / `sorriso-owner-123456`).
- **Subir tudo:** `docker compose up -d postgres redis` + `ollama serve` (modelos
  baixados) + **`./dev-local.sh`** (injeta Ollama+Baileys, que não moram no .env).

## Dívidas conhecidas em aberto
- ~~**M14 identidade de staff**~~ **RESOLVIDA (2026-07-06, ADR 0044):** token pessoal
  por staff + papel enforçado + auditoria (`audit_log`). Fecha também a dívida do
  motor "identidade forte do curador". Templates HSM (agrega cross-tenant) e Operação
  (snapshot real) já estavam prontos.
- ~~**Dívidas do motor**~~ **TODAS RESOLVIDAS (2026-07-06, 2 rodadas Codex sem
  críticos — ver `docs/dividas-2026-07-codex-review.md`):**
  - **E.164 (M7):** `toE164` no core; CRM deduplica pela chave canônica (wa_id sem
    país default); telefone inválido = 'failed' observável, sem telefone = 'skipped'.
  - **reply() unificado (M8):** núcleo de entrega compartilhado — resposta reativa
    entra no livro-razão do outbox nascendo 'sent' (`origin='reactive'`), at-most-once
    PRESERVADO; delivered/read reconciliam também as respostas do agente; metering
    unificado. Migration 0027.
  - **Busca híbrida (M5):** perna keyword FTS 'portuguese' (GIN, migration 0028) como
    resgate de recall nas duas fontes (tenant+nicho); score segue cosseno (ADR 0021).
  - **Gestão de staff pela UI:** criar/rotacionar token/remover (admin-only, token cru
    mostrado 1x, auditado).
- ~~**Rodar local: qualificação irregular no 3B**~~ **RESOLVIDA (2026-07-06):**
  passe de extração dedicado (`FieldExtractor`) — quando o turno termina com
  obrigatórios faltando, uma chamada sem tools extrai os campos como JSON (parse
  robusto, whitelist, coerção de tipo, nunca sobrescreve a tool) e re-decide no
  motor determinístico. `QualificationField.description` (default + kits 1.1.0)
  conecta a chave ao conteúdo. Probe ao vivo vs qwen2.5:3b:
  `apps/api/scripts/probe-extractor-3b.ts` — 33% → **100%** (15/15). Revisão
  Codex aplicada (injection hardening, coerção, guards).
- **Residual:** `support`/`impersonar` sem endpoints próprios; kit odonto 1.1.0
  precisa ser re-aplicado no ambiente local (`POST /platform/kits/odonto/apply`).
- **Rodar local:** qualificação irregular no 3B (às vezes não chama a tool de
  extração → subir p/ 7B melhora mas fica lento na máquina Intel CPU-only).

## Sessão de AUDITORIA/HARDENING (2026-07-06, noite)
Auditoria profunda em 3 frentes (bugs, performance, front) + implementação + 2
rodadas de revisão Codex. **403 testes verdes** (eram 349), typecheck 13 projetos,
build 22 rotas.
- **Confiabilidade do pipeline:** dedup de inbound movido p/ PÓS-sucesso sob o
  FIFO-lock + erros propagam p/ retry do BullMQ (fecha perda permanente de
  mensagem); timeouts em TODOS os adaptadores HTTP (LLM/whisper 60s, cloud 20s,
  embed/CRM 15s) mapeados p/ erros re-tentáveis; teto de 180s no heartbeat do
  lock (`LockMaxHoldError`); contenção de lock re-enfileira com delay (não queima
  attempts); claim de resposta com compensação (`releaseAgentResponse` — envio
  falhou → retry reenvia; duplicata rara > resposta perdida); eventos de conta
  ANTES do pipeline de mensagens (não ficam reféns de falha).
- **Baileys:** signal keys persistidas no `keys.set` (debounce 1.5s — fecha Bad
  MAC pós-restart); reconcile não trava mais em `connecting` (falha por número,
  backoff).
- **Cadência/outbox/CRM/auth:** cadência respeita takeover humano e não congela
  com `created=false`; sweep de outbox `sending` órfão terminal → `failed`+alerta;
  CRM sync com hash do payload no jobId (não é mais engolido pelo BullMQ);
  throttler no login/refresh (10/min).
- **Latência do turno:** extractor em PARALELO com agent.run (−0.5–3s/turno);
  pré-trabalho em Promise.all; caches TTL (segredos 60s write-through; config do
  agente/nicho 30s com invalidação nos controllers); recordUsage e summarize
  fire-and-forget (resumo a cada 5 turnos); histórico 1200 tokens quando há
  resumo; RAG pulado p/ msg <12 chars; outbox worker dirigido por
  `listTenantsWithDueOutbox` + lotes de 4 (migration **0029_system_scan_policy**);
  concurrency do webhook 8→16.
- **Front (16 itens V4):** plataforma em canvas claro + PlatformTopbar; StatusPill;
  skeletons/ErrorState com retry em tudo; Select/Textarea primitivos; /inicio com
  saudação nominal + funil na rampa; hub de configuração com status REAL de
  conexão; conversas com composer (desabilitado — falta endpoint de envio manual)
  e indicador de digitação; topbar viva (polling 20s); curadoria fila|revisão;
  toasts + ConfirmDialog; Th/Td/Kpi dense; microinterações.
- **Limitações registradas:** ~~outbox 1 conexão/tenant, refresh sem revogação,
  inbound sem quarentena, e2e HTTP~~ → TODAS fechadas na sessão de PENDÊNCIAS
  abaixo. FIFO = exclusão mútua, não ordem estrita (amendment no ADR 0003 —
  aceito por design).

## Sessão de PENDÊNCIAS (2026-07-07) — 445 testes verdes (429 + 16 e2e)
Fechamos as pendências do hardening, com 2 rodadas Codex (3 achados aplicados:
rotação atômica de refresh, backfill da 0030, idempotência do envio manual):
- **Outbox multi-conexão (migration 0030 + backfill):** `connection_id` por linha
  (gravado no enqueue pela conexão da CONVERSA via conversation_key, ADR 0010);
  claim particionado por provedor no SQL (scheduler=cloud, session-worker=baileys
  dos sockets dele); envio roteia pela linha — tenant com 2 números não manda
  pelo número errado e não há starvation cloud/baileys.
- **Envio manual do humano:** `POST /admin/conversations/:id/messages` (roles
  admin) com guardrails 404/409-sem-takeover/403-opt-out/422-janela-24h (Baileys
  sem janela); IDEMPOTENTE por `clientMessageId` do painel (`claimHumanOutbox`:
  linha entra `sending` ANTES do provedor; retry dedupa; concorrente = in_flight;
  re-claim de failed/estagnado >2min); composer das Conversas HABILITADO no front
  (append otimista, retry reusa a chave, erro vira toast).
- **Refresh com estado (migration 0031, ADR 0006 atualizado):** sessões
  `auth_sessions` (sha256 do jti); refresh valida sessão e ROTACIONA com consume
  atômico (perder o consume = reuso → revoga TODAS as sessões, OWASP); logout
  revoga; switch-tenant rotaciona; sweep oportunista no login.
- **Quarentena de inbound (migration 0032):** conexão `disconnected/connecting`
  não descarta mais a mensagem do lead — vai p/ `inbound_quarantine` (payload
  bruto do job, assinatura re-verifica no replay); sweep 60s re-enfileira em
  ordem quando a conexão volta a `active`; TTL 48h; dedup do pipeline protege.
- **CRM re-sync:** removido o curto-circuito `synced` — lead que ganhou campos
  novos re-sincroniza (update idempotente pela chave canônica, ADR 0026); a
  proteção contra loop mora no jobId com hash do payload.
- **e2e HTTP (novo):** `apps/api/src/e2e/http.e2e.test.ts` (16 testes, supertest
  contra o app Nest REAL com rawBody+ValidationPipe do main.ts): auth, escopo de
  tenant (A nunca vê B), webhook HMAC (inválida não enfileira), guard da
  plataforma fail-closed, throttler 429. Config própria (`vitest.e2e.config.ts`,
  SWC p/ decorator metadata): `npx vitest run --config vitest.e2e.config.ts`.
  A suíte padrão NÃO inclui o e2e (include `src/!(e2e)/**`).
- Residual consciente (Codex, aceito): envio pós-provedor sem confirmação pode
  duplicar no re-claim (at-least-once na fronteira externa); conversas com
  conversation_key fora da convenção caem no fallback por tenant.

## Como rodar / testar localmente
```bash
docker compose up -d postgres redis           # infra local
set -a; . ./.env; set +a                       # carrega .env (gitignored)
pnpm db:migrate && pnpm db:seed                # schema + dados demo
pnpm typecheck && pnpm test                     # 429 testes verdes (+16 e2e à parte)
./dev-local.sh                                  # api :3001 + web :3000 (Ollama+Baileys)
```

## Fluxo de trabalho (manter)
Victor manda o prompt do módulo → Claude executa por camadas (commit por camada) →
Codex revisa (`codex exec --sandbox read-only "..." </dev/null`) → aplica achados →
ADR/README/memória/handoff. GOTCHAs: `</dev/null` no Codex; sem backticks em commit
msg; URLs de serviço (não localhost) em prod.
