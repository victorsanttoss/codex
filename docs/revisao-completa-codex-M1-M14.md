# Revisão completa Codex (M1–M14) — read-only

Auditoria do sistema inteiro contra os invariantes (RLS multi-tenant, segredos,
núcleo agnóstico, idempotência/entrega, concorrência, LGPD, RBAC, SQL/preço).
**Nenhum achado CRÍTICO.** Resumo dos achados e tratamento:

## Pontos positivos confirmados pelo Codex
`packages/core` agnóstico a SDKs · envelope encryption **AES-256-GCM com AAD** ·
**RLS FORCE** coberto nas migrations tenant-scoped (e no catálogo de teste) ·
`PlatformGuard` **fail-closed** sem token · SQL dinâmico via Drizzle/`sql`
parametrizado (sem injeção) · isolamento cross-tenant provado em teste.

## ALTO — corrigido / tratado
1. **Cadência avançava o passo sem checar `created` do outbox** (concorrência: o
   claim é `SKIP LOCKED` mas solta a tx antes de processar). **CORRIGIDO:** só o
   worker que realmente **criou** a entrada no outbox avança o passo (`if (!created)
   continue`) — dispatch idempotente por passo.
2. **Reply reativo é at-most-once** (`claimAgentResponse` antes do envio) e o
   **dedup do inbound** (`ensureProcessedOnce`) ocorre antes do handler. São
   **trade-offs já documentados** (ADR 0024; dívida M6/M8 na memória): o caminho
   robusto é unificar o reply reativo no **outbox** (`pending→sending→sent`). É um
   refactor próprio (não feito agora para não desestabilizar o agente às vésperas
   dos testes); permanece registrado como dívida.
3. **Cloud `biz_opaque_callback_data` não deduplica entrega** → at-least-once com
   possível duplicação. **Já documentado honestamente** (ADR 0027 + comentário no
   código). Baileys (com `messageId`) tem dedup real.

## MÉDIO — registrado como follow-up
4. **Identidade de staff:** plataforma usa **token estático** e `curatorId` vem do
   body → auditoria forjável. Follow-up: login de staff próprio + `curatorId`
   derivado no servidor + audit log com ator real. (Tabela `platform_staff` já
   criada no refino do M14; a autenticação por-staff é a próxima etapa.)
5. **Tokens no `localStorage`** (JWT do tenant + token de plataforma) apesar de a API
   já emitir cookies `httpOnly` — risco de roubo via XSS. É simplificação de scaffold
   documentada (`apps/web/lib/api.ts`). Hardening: migrar para cookie `httpOnly` +
   sessão de staff server-side.
6. **`.env` na raiz** do repo: **gitignored** e fora do `git ls-files` (não
   versionado), mas idealmente em secret manager/caminho externo em produção.

## BAIXO
7. Logs com `mediaId`/`phoneNumberId` (identificadores correlacionáveis, não
   segredos). Opcional: truncar/hash.

> Conclusão: a base está sólida e sem críticos. O fix de concorrência da cadência
> foi aplicado; os demais são dívidas conhecidas/documentadas (entrega exactly-once,
> identidade de staff, hardening de cookies) que merecem módulos próprios e não
> bloqueiam o início dos testes.
