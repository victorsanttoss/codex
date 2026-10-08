# Handoff M1 → M2 (contexto para escrever o prompt do Módulo 2)

Plataforma **SDR de IA multi-tenant** (WhatsApp). O **Módulo 1 (fundação) está
entregue e verificado ao vivo** (Postgres 16 + pgvector + Redis). Este documento
descreve o que já existe para o M2 ser preciso e não reinventar.

## Princípios (valem para todo o projeto)
- **Hexagonal (ports & adapters):** núcleo agnóstico a fornecedor. Canal e LLM são
  *ports*; adaptadores concretos ficam fora do núcleo.
- **Isolamento rígido por tenant** via Postgres RLS com `FORCE` (LGPD). Vazamento
  cross-tenant = falha crítica. Tenant-scoped por padrão; caminho "system" explícito.
- **TypeScript strict**, segredo nunca em texto puro/log/repo.

## Stack
Node 20+ · TS strict · NestJS (`apps/api`) · Next.js (`apps/web`) · PostgreSQL 16
+ pgvector · Drizzle ORM · Redis + BullMQ · Vitest · pnpm workspaces · Docker.

## Estrutura
```
packages/core   ports, envelope encryption, contexto, contract tests
packages/config validação 12-factor (zod)
packages/db     schema Drizzle, migrations RLS, client withTenant, seed
apps/api        NestJS: auth/RBAC, contexto, fila FIFO, metering, health, pino
apps/web        Next.js: login + painel (scaffold)
docs/adr        ADRs (0001 RLS, 0002 cripto, 0003 FIFO, 0004 ports, 0005 contexto, 0006 auth)
```

---

## O que o M2 vai PLUGAR (já existe, não recriar)

### 1. Port de canal — `ChannelProvider` (packages/core/src/ports/channel-provider.ts)
O M2 implementa um adaptador concreto desta interface:
```ts
interface ChannelProvider {
  readonly kind: "whatsapp";
  sendMessage(msg: OutboundTextMessage): Promise<SendResult>;
  sendTemplate(msg: OutboundTemplateMessage): Promise<SendResult>;
  // recebe headers/query/rawBody p/ VERIFICAR assinatura e identificar a conta:
  normalizeInboundWebhook(request: InboundWebhookRequest): NormalizedInboundMessage[];
  connect(): Promise<void>; disconnect(): Promise<void>; status(): Promise<ProviderLifecycleStatus>;
}
```
- `NormalizedInboundMessage`: `{ provider, externalMessageId, conversationKey, from, to, receivedAt, content }` (content = text | media | unsupported).
- **Contrato obrigatório:** o adaptador DEVE passar a suíte reutilizável
  `runChannelProviderContract(name, () => new MeuAdapter(cfg))`
  (packages/core/src/ports/testing/channel-provider.contract.ts).

### 2. Registry por tenant — `ProviderRegistry` (packages/core/src/ports/registry.ts)
`registerChannel(key, factory)` e `channelFor(TenantProviderSelection)` selecionam o
adaptador conforme a config do tenant. O M2 registra o adaptador real (ex.: chave
`"meta_cloud"`). Validação da config por-adapter é responsabilidade do adaptador.

### 3. Primitivos prontos (importar de `@sdr/db` / `@sdr/api`)
- **Acesso a dados sob RLS:** `withTenant(fn)` (abre transação + `SET LOCAL app.tenant_id`).
  Único caminho para tabelas tenant-scoped. Também `withUser`, `withSystem`.
- **Idempotência de webhook:** `ensureProcessedOnce(provider, externalMessageId, conversationKey)`
  → `true` se novo (processar), `false` se reentrega. **Dedup é POR TENANT.**
- **FIFO por conversa:** `SerializedRunner.run(conversationKey, fn)` — no máx. 1
  execução por `conversation_key` por vez (lock Redis). ⚠️ Ver dívida #1 abaixo.
- **Metering:** `recordUsage({ type, model?, channel?, tokensIn?, tokensOut?, costMicros?, metadata? })`
  e `aggregateUsage(from, to)` — sempre no tenant ativo.
- **Credenciais cifradas:** `TenantSecretsStore.put/get/rotateActiveTenant` com
  envelope encryption (AES-256-GCM, KEK versionada, AAD derivado). Kind disponível:
  `whatsapp_token`, `crm_api_key` (estender o enum `tenant_secret_kind` se precisar).
- **Contexto:** em jobs/workers, envolver com `runWithTenant({tenantId,...}, fn)`;
  `requireTenantContext()` lança se não houver tenant.
- **Auth/RBAC:** guards globais (JwtAuthGuard → RolesGuard); `@Roles('admin')`,
  `@Public()`, `@CurrentUser()`.

### 4. Tabelas existentes (M1) — NÃO recriar
`tenants`, `users`, `memberships`, `tenant_secrets`, `usage_events`,
`processed_messages` (dedup, unique `(tenant_id, provider, external_message_id)`),
`audit_log`. pgvector já habilitado (sem tabelas de embedding — isso é M5).

---

## CONTRATOS que o M2 DEVE honrar
1. **Toda tabela tenant-scoped nova:** `tenant_id` + `ENABLE` + `FORCE ROW LEVEL
   SECURITY` + policy `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`
   (USING + WITH CHECK). Adicionar o nome da tabela ao teste de catálogo
   (packages/db/src/rls-catalog.test.ts) — ele FALHA se faltar RLS/FORCE/policy.
2. **Acesso a dados sempre via `withTenant`** (nunca query tenant-scoped fora de contexto).
3. **Migrations**: arquivo `.sql` em `packages/db/migrations/000X_*.sql` (runner aplica
   em ordem; idempotente). Não usar `.sh` no initdb (bind-mount noexec no macOS).
4. **Webhook**: validar assinatura dentro de `normalizeInboundWebhook` (recebe
   headers+rawBody); inválido → vazio.
5. **Pipeline de entrada** sugerida: webhook → `normalizeInboundWebhook` →
   `ensureProcessedOnce` (dedup) → `SerializedRunner.run(conversationKey, ...)` →
   (processamento; o agente em si é M6).
6. **Segredos** só via `TenantSecretsStore`; nunca em log (redaction do pino já cobre).
7. **Adaptador** deve passar `runChannelProviderContract`.

## DÍVIDA CONHECIDA (o M2 precisa decidir)
1. **FIFO/lock (ALTO):** `RedisMutex` NÃO renova o lock — a exclusividade vale
   enquanto `fn < ttlMs`. O M2 (com processamento real, possivelmente lento por
   chamada a LLM/CRM) DEVE dimensionar o `ttlMs` ao pior caso **e/ou** adicionar
   heartbeat + fencing token. Ver ADR 0003 e `apps/api/src/queue/redis-mutex.ts`.
2. **e2e automatizado da API:** ainda não há (boot do Nest no Vitest precisa de SWC
   p/ decorator metadata). M2 pode adicionar `@swc/core` + `unplugin-swc`.
3. **Auth:** refresh é stateless (sem revogação) e sem CSRF (web usa Bearer) — só
   relevante se o M2 tocar auth.

## Como rodar/verificar (infra local)
Docker Desktop 4.41.2 (última que roda no macOS 12; engine OK). `.env` na raiz
(gitignored; segredos via `openssl`). 
```bash
docker compose up -d postgres redis
set -a && . ./.env && set +a
pnpm db:migrate && pnpm db:seed
pnpm -r test          # com .env carregado, roda também os testes de integração
```
Estado atual: **46 testes** (core 20 · config 4 · db 10 ao vivo · api 12). Duas
rodadas de revisão do Codex aplicadas (`docs/M1-codex-review*.md`).

## Escopo do M2 (do plano original)
Adaptador **concreto de WhatsApp** (primeiro a usar as ports + contract suites) e a
pipeline real de mensagem (entrada/saída) sobre os primitivos do M1. Embedded
Signup é M3; LLM real é M4; conhecimento/pgvector é M5; agente/qualificação é M6+.
