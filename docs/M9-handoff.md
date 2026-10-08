# Handoff M9 → M10 (contexto para escrever o prompt do Módulo 10)

Plataforma **SDR de IA multi-tenant** no WhatsApp. **M1–M9 entregues e verificados
ao vivo** (226 testes, 11 rodadas de revisão Codex): fundação, canal Cloud API +
pipeline, Embedded Signup, LLM, conhecimento/RAG, agente SDR, CRM + agendamento +
handoff, cadência/outbox proativo, e a **camada de nicho + loop de curadoria**.

**A MÁQUINA está pronta**; falta o **CONTEÚDO**. O M9 entregou a *máquina genérica*
de nicho (storage isolado por nicho, retriever componível, curadoria humana,
anonimização). Hoje os nichos estão **vazios**.

**M10 (provável): VERTICAIS REAIS — popular e operacionalizar nichos de verdade**
(ex.: solar, saúde/odonto, imobiliário, educação) com conhecimento, schema de
qualificação, vocabulário, objeções e templates específicos. É onde o produto vira
"SDR de solar" / "SDR de clínica" de verdade. O escopo final é do prompt do M10;
isto é orientação. *(Alternativas válidas: unificar o `reply()` no outbox; painel/
observabilidade web; identidade forte de curador.)*

> Regra de ouro: **plugar, não reconstruir.** Tudo do M10 entra pelos seams já
> abertos (criar nicho, curar conhecimento, schema de qualificação por tenant/nicho,
> templates). O M10 é majoritariamente **conteúdo curado + config**, não nova
> arquitetura — mais um **kit de bootstrap por vertical**.

## Princípios (todo o projeto)
- Hexagonal; núcleo agnóstico. Isolamento por tenant (RLS FORCE) **e por nicho**
  (RLS por `app.niche_id`). Segredos nunca em log. **Zero PII no nicho**, curadoria
  humana como gate. Compliance/anti-ban de primeira classe. TS strict; testes sem
  rede real.

## Estrutura
```
apps/api   NestJS — pipeline, LLM, RAG, agente, CRM, outbox, cadência, NICHO+curadoria
apps/web   Next.js — login, painel, /connect (scaffold; painel de curadoria é seam)
packages/core    ports (Channel, LLM, Embedding, CRM/Scheduling/Notification) + registry
packages/db      schema/migrations RLS (tenant + nicho + curadoria), repos
packages/whatsapp-cloud · llm-* · embeddings-openai-compat · crm-http   adaptadores
docs/adr   ADRs 0001-0032
```

## Os SEAMS prontos para uma VERTICAL (M10 preenche)
1. **Criar o nicho**: `niches` (vertical × motion) + `niche.guidance` (injetada no
   prompt via `nicheLayer`). `createNiche({name, vertical, motion, guidance})` +
   `assignTenantNiche(nicheId)` (server-side). Endpoints `/platform/...` (curador).
2. **Conhecimento de nicho** (`niche_knowledge`, RLS por nicho): popular via
   curadoria — `createCandidate` → `approve` → `promote` (versionado). Tipos de
   candidato já definidos: `objection_handling`, `qualifying_question`, `vocabulary`,
   `faq`, `document_request`. O `NicheKnowledgeSource` já entra no retriever.
3. **Schema de qualificação por tenant/nicho** (`agent_configs.qualification`,
   data-driven, validado/clampado — ADR 0023): cada vertical tem campos próprios
   (ex.: solar → conta de luz/telhado/consumo; clínica → convênio/procedimento).
   Hoje resolve por tenant; a camada de nicho entra entre default e tenant (ADR 0022)
   — o M10 pode promover um schema padrão **por nicho**.
4. **Templates HSM por vertical** (`message_templates`): cadência/follow-up usa o
   catálogo aprovado (M8). O M10 cadastra os templates de cada vertical.
5. **Config por tenant** (`agent_configs` jsonb): chaves `crm`, `cadence`, e (M6)
   persona/guardrails — o kit da vertical preenche defaults sensatos.

## O que o M9 ENTREGOU (consumir)
- `NicheService`/`NicheKnowledgeSource` (consumo), `CurationService` (createCandidate/
  approve/reject/promote/retire), `CurationMiningService` (minera conversas
  convertidas, anonimiza, cria candidato — gate humano), `DefaultInsightExtractor`
  (LLM de plataforma), `PlatformGuard` + `/platform/*`.
- Metering de plataforma (`platform_usage`) p/ custo de curadoria.

## Escopo provável do M10 (orientação)
1. **Kit de bootstrap por vertical**: um pacote de seed/curadoria que, para uma
   vertical, cria o nicho + guidance + conhecimento inicial (objeções/perguntas/
   vocabulário curados à mão) + schema de qualificação + templates. Idealmente
   **declarativo** (um arquivo por vertical) aplicado via o caminho de curadoria
   (não bypassando o gate — ou marcando como conteúdo de plataforma curado).
2. **2–3 verticais piloto** reais (ex.: solar, odonto, imobiliário) com conteúdo de
   verdade (parcerias/conhecimento de domínio).
3. **Resolução do schema de qualificação POR NICHO** (camada que falta: hoje o
   schema é por tenant; promover um schema default por nicho entre default e tenant).
4. **Ferramentas/perguntas específicas da vertical** (registry de tools por nicho —
   o seam existe).

## Contratos a honrar
- Núcleo agnóstico (teste estrutural verde). **Zero PII no nicho** (anonimização +
  curador humano). Isolamento por tenant E por nicho (RLS FORCE + policy NULLIF;
  catálogo valida a expressão; FK composta `ON DELETE CASCADE`). Migrations `.sql`
  a partir de **0016** (nunca `.sh`).
- Conteúdo de nicho entra pelo **caminho de curadoria** (gate humano) ou como
  **conteúdo de plataforma explicitamente curado** — nunca auto-promovido de dados
  de tenant. URLs do tenant pelo guard anti-SSRF.
- Clientes externos injetáveis; testes sem rede real; vitest do api em `singleFork`.

## Dívida conhecida (escolher o que atacar junto)
- **Identidade forte do curador** (M9): hoje `curatorId` vem do body + token de
  plataforma; falta auth por-staff + auditoria imutável.
- **Unificar `reply()` reativo no outbox** (M8): dois caminhos de saída.
- **Painel web de curadoria/observabilidade** (`apps/web` é scaffold) — natural p/
  operar o M9/M10.
- **M8**: claim "duro" de cadência; E.164. **M7**: sync bidirecional CRM; Google
  Calendar/Slack. **M5**: busca híbrida (vetor+keyword) — sinérgica com nicho.
  **M4**: streaming/`llm.providers[]`. **M3**: refresh de token. e2e HTTP via SWC.

## Fora de escopo (do M10, provavelmente)
- Mudanças na máquina de nicho (já pronta); transcrição de áudio/visão; novos canais.

## Como rodar/verificar
Docker Desktop 4.41.2 (macOS 12). `.env` na raiz (gitignored; segredos via openssl;
`PLATFORM_ADMIN_TOKEN` para as rotas de curadoria).
```bash
docker compose up -d postgres redis
set -a && . ./.env && set +a
pnpm db:migrate && pnpm db:seed
pnpm -r --filter './packages/**' build   # project references → dist
pnpm -r test     # com .env carregado, roda também integração ao vivo
```
Estado: **226 testes** (config 4 · core 29 · whatsapp-cloud 16 · db 44 ·
llm-anthropic 8 · llm-openai-compat 7 · llm-router 7 · embeddings-openai-compat 11 ·
crm-http 5 · api 95). Gotchas: GUC do PG volta a `''` (não NULL) → `NULLIF` na
policy (tenant E nicho); `AsyncLocalStorage`/`enterWith` não propaga no guard Nest →
`storage.run` + mutação; bigint volta string de postgres.js → cast `::int`; literal
de `vector` é `[v1,...]`; FK composta com `ON DELETE CASCADE`; guard anti-SSRF; RLS
de nicho usa `app.niche_id`/`app.curation` (não está em TENANT_SCOPED_TABLES); vitest
do api em `singleFork`; **Codex CLI**: rodar com `</dev/null` senão trava no stdin.
