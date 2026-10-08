# Handoff M2 → M3 (contexto para escrever o prompt do Módulo 3)

Plataforma **SDR de IA multi-tenant** no WhatsApp. **M1 (fundação) e M2 (canal
WhatsApp Cloud API + pipeline real) entregues e verificados ao vivo** (75 testes,
4 rodadas de revisão do Codex aplicadas). **M3 = Embedded Signup**: automatizar o
onboarding/registro de conexão que hoje é **manual**.

> Regra de ouro: **plugar, não reconstruir.** Use os primitivos/tabelas abaixo.

## Princípios (todo o projeto)
- Hexagonal (ports & adapters; núcleo agnóstico a fornecedor).
- Isolamento rígido por tenant via Postgres RLS com `FORCE` (LGPD). Cross-tenant
  só pelo caminho system, explícito e auditado.
- Plataforma × tenant nos segredos: app secret/verify token são da PLATAFORMA
  (config); token de envio é por tenant (`TenantSecretsStore`, cifrado).
- TypeScript strict; segredo nunca em log/texto puro/repo.

## Stack
Node 20+ · TS strict · NestJS (`apps/api`) · Next.js (`apps/web`) · PostgreSQL 16
+ pgvector · Drizzle · Redis + BullMQ · Vitest · pnpm workspaces · Docker.

## Estrutura
```
apps/api   NestJS — auth/RBAC, contexto, fila FIFO, webhook+pipeline WhatsApp
apps/web   Next.js — login + painel (scaffold)
packages/core           ports, envelope encryption, contexto, contract tests
packages/config         validação 12-factor (zod) — inclui seção `whatsapp`
packages/db             schema Drizzle, migrations RLS, withTenant, repos
packages/whatsapp-cloud adaptador Cloud API (assinatura, send, normalize)
docs/adr   ADRs 0001-0011
```

---

## O que JÁ EXISTE (M1 + M2) — não recriar

### Tabela `channel_connections` (M2) — o M3 vai POPULAR automaticamente
Colunas: `id, tenant_id, provider('cloud_api'), phone_number_id (UNIQUE global),
waba_id, display_phone, status('active'|...), secret_ref('whatsapp_token'),
created_at`. RLS FORCE com policy de 2 pernas: acesso por `tenant_id` OU lookup
por `phone_number_id` no caminho system (`set_config('app.resolve_phone', ...)`).

### Repos (de `@sdr/db`)
- `upsertChannelConnection({ phoneNumberId, wabaId?, displayPhone?, secretRef? })`
  — registra/atualiza a conexão do tenant ativo (é o que o M3 vai chamar após o
  signup). Hoje usado pelo endpoint admin manual.
- `resolveConnectionByPhoneNumberId(pnid)` — resolve tenant no caminho system
  (já filtra `status='active'`).
- `TenantSecretsStore(makeCipherFromEnv()).put/get/rotateActiveTenant` —
  credenciais cifradas (envelope AES-256-GCM, AAD derivado). Kind: `whatsapp_token`.
- Também (M2): `recordInboundMessage`, `recordOutboundMessage`,
  `markMessageStatusByExternalId` (monotônico), `ensureProcessedOnce`,
  `getConversationByKey`, `isWithinServiceWindow`, `recordUsage`, `aggregateUsage`,
  `insertMediaObject`. `withTenant`/`withUser`/`withSystem`, `runWithTenant`,
  `requireTenantContext`.

### Adaptador e ports (de `@sdr/core` / `@sdr/whatsapp-cloud`)
- `ChannelProvider` (port), `ProviderRegistry`, contract suite reutilizável
  (`runChannelProviderContract`, parametrizável com `validWebhook` assinado).
- `CloudApiChannelProvider` (key `cloud_api`): `sendMessage`, `sendTemplate`,
  `normalizeInboundWebhook` (itera batch), `normalizeStatusEvents`,
  `verifySignature`. HttpClient injetável (mockar a Meta nos testes).

### API (apps/api) — fluxo atual
- **Auth/RBAC**: JWT access+refresh, `@Roles('admin')`, `@Public()`, `@CurrentUser()`.
- **Registro MANUAL de conexão (o que o M3 substitui):**
  `POST /admin/whatsapp/connections` (`@Roles('admin')`) — guarda o
  `whatsapp_token` cifrado + `upsertChannelConnection`.
- **Webhook**: `GET /webhooks/whatsapp` (challenge com verify token da plataforma);
  `POST /webhooks/whatsapp` (valida assinatura na borda → **enfileira BullMQ** →
  200 rápido; worker roda a pipeline). `ChannelFactory.platformNormalizer()` /
  `tenantSender(phoneNumberId, secretRef)`.
- **Config** (`packages/config`, seção `whatsapp`): `appSecret`, `verifyToken`,
  `graphApiBase` (default https://graph.facebook.com), `graphApiVersion` (v21.0).
  Env: `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, etc.

---

## Escopo do M3 — Embedded Signup
Automatizar o que hoje é o `POST /admin/whatsapp/connections` manual: o cliente
(tenant) faz o onboarding pelo **Embedded Signup da Meta** (popup/JS SDK), e a
plataforma (Tech Provider) recebe o que precisa para registrar a conexão sozinha.

Fluxo típico a implementar:
1. **Web**: botão que abre o **Embedded Signup** (FB JS SDK) com o `app_id` e o
   `config_id` da plataforma; retorna um **code** (e o WABA/phone selecionados).
2. **API**: trocar o `code` por **token** (system user / long-lived) via Graph API;
   buscar `waba_id` e `phone_number_id`; **subscrever o app ao webhook da WABA**
   (`/{waba_id}/subscribed_apps`); **registrar o número** (`/{phone_number_id}/register`).
3. Persistir: `TenantSecretsStore.put('whatsapp_token', token)` +
   `upsertChannelConnection({ phoneNumberId, wabaId, displayPhone })` no contexto
   do tenant. A pipeline do M2 passa a funcionar para esse tenant automaticamente.
4. **Lifecycle**: status da conexão (active/disconnected/revoked), refresh/rotação
   de token, desconexão (revogar), reidratação.

## O que o M3 provavelmente vai CRIAR
- Novos campos de config da plataforma: `WHATSAPP_APP_ID` (client_id),
  `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, talvez `WHATSAPP_BUSINESS_TOKEN`/system user.
- Um `EmbeddedSignupService` (troca de code→token, fetch de WABA/phone, subscribe,
  register) usando o `HttpClient` injetável (mockar a Meta nos testes).
- Endpoints: iniciar signup / callback de troca de code (`@Roles('admin')`,
  contexto do tenant).
- Possíveis colunas novas em `channel_connections` (ex.: `token_expires_at`,
  `system_user_id`, `subscribed_at`) — se adicionar, **migration `.sql` 0003**.
- UI no `apps/web` (botão + SDK) — opcional/scaffold.

## Contratos que o M3 DEVE honrar
1. Toda coluna/tabela tenant-scoped nova: `tenant_id` + `ENABLE`+`FORCE` RLS +
   policy `NULLIF(current_setting('app.tenant_id',true),'')::uuid`, e adicionar ao
   teste de catálogo RLS (falha se faltar). Migrations `.sql` em
   `packages/db/migrations/000X_*.sql` (continuar numeração; nunca `.sh`).
2. Token de envio só via `TenantSecretsStore` (cifrado); app secret/config só via
   `packages/config`. Nunca em log.
3. Chamadas à Meta via `HttpClient` injetável; **sem rede real nos testes**.
4. Reusar `upsertChannelConnection` / `resolveConnectionByPhoneNumberId`; a
   pipeline do M2 não muda.

## Dívida conhecida que o M3 toca
- **Lifecycle de conexão**: `resolveConnectionByPhoneNumberId` já filtra
  `status='active'`; o M3 deve setar `disconnected`/`revoked` no desligamento e
  tratar rotação/refresh de token (a Meta expira tokens). (Apontado pelo Codex.)
- **Idempotência de envio outbound** (#5 da revisão M2) segue para o M6.

## Como rodar/verificar
Docker Desktop 4.41.2 (macOS 12). `.env` na raiz (gitignored; segredos via openssl).
```bash
docker compose up -d postgres redis
set -a && . ./.env && set +a
pnpm db:migrate && pnpm db:seed
pnpm -r test     # com .env carregado, roda também integração ao vivo
```
Estado: **75 testes** (config 4 · core 22 · whatsapp-cloud 15 · db 15 · api 19).
Revisões do Codex: `docs/M1-codex-review*.md`, `docs/M2-codex-review.md`.

## Fora de escopo (depois do M3)
Adaptador não-oficial (Baileys); LLM real (M4); conhecimento/pgvector (M5);
agente/qualificação/CRM/curadoria (M6+). Envio de mídia/interativo estende a port.
