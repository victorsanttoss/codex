# Segurança — SDR IA

_Atualizado: 2026-07-07. Auditoria de segurança (pentest de 3 frentes + hardening + 2 rodadas Codex adversariais)._

## Postura geral
Pentest adversarial (auth/multi-tenancy, superfície de entrada/injeção/LLM, segredos/cripto/infra)
**não encontrou vazamento cross-tenant explorável nem bypass de autenticação**. O núcleo é sólido:
RLS `FORCE` em todas as tabelas de tenant (role do app é `NOBYPASSRLS`), `tenant_id` sempre do JWT
assinado, envelope encryption AES-256-GCM (nonce único por operação, AAD por tenant), HMAC do webhook
timing-safe sobre raw body, refresh com rotação + detecção de reuso (OWASP).

## Defesas por camada

### Isolamento multi-tenant
- RLS + FORCE em todas as `TENANT_SCOPED_TABLES` (provado por `rls-catalog.test.ts`); `SET LOCAL` em
  transação → o pool não vaza `app.tenant_id` entre requests. Policies "system" (scan/audit/nicho)
  são gated por GUCs que o caminho de tenant nunca seta.

### Autenticação e sessão
- Argon2id + verify dummy timing-equalizado (não enumera e-mail). Access token stateless (TTL curto,
  HS256 fixado). Refresh com sessão server-side (`auth_sessions`, sha256 do jti), rotação por consume
  atômico, reuso derruba todas as sessões. Cookies httpOnly; `Secure` **obrigatório em produção**
  (o boot falha se `NODE_ENV=production` e cookie inseguro).
- Rate-limit (`@nestjs/throttler`, global): login/refresh 10/min; endpoints de plataforma
  (`/platform/*`, curadoria, kits) 30/min — contra brute-force do `x-platform-token`.

### Superfície de entrada
- Webhook: HMAC-SHA256 do raw body, timing-safe, fail-closed com appSecret/assinatura vazios; dedup
  por `externalMessageId` neutraliza replay. `ValidationPipe` global (whitelist). `helmet` na API.
- **Rate-limit por conversa** (20/min por número, Redis) + **fairness na fila** (máx 8 jobs em voo por
  número) — contra flood/noisy-neighbor.

### SSRF (conector de CRM por tenant)
- Duas barreiras: (1) validação de string (`safeHttpBaseURL` — só https:443, rejeita host numérico
  disfarçado e IP literal privado); (2) no fetch, `dns.lookup` valida **todos** os IPs resolvidos e
  **fixa (pin)** o IP validado — derrota DNS rebinding. Classificador cobre v4 (0/8,10/8,100.64/10,
  127/8,169.254/16,172.16/12,192.168/16,198.18/15,test-nets,multicast,reservado) e v6 (loopback, ULA,
  link-local, e IPv4 embutido em mapped/compat/translated/**NAT64**/**6to4**/**Teredo**, inclusive na
  forma hex). `https.request` não segue redirect → 30x para IP interno não é acionável.

### Custo de LLM / abuso
- **Teto agregado por tenant/dia** (default US$25) com **reserva atômica** no Redis antes do LLM
  (INCRBY do teto-por-turno; reconcilia para o custo real; devolve a reserva em erro/rejeição). O
  resumo rolante também é contabilizado. **Fail-open**: se o Redis cair, o guard libera o atendimento
  — decisão de produto (disponibilidade > enforcement; o billing real continua no `usage_events` do
  Postgres). NÃO é um hard-cap de segurança durante outage do Redis.

### Segredos e infra
- Config **endurece em produção** (`superRefine`): falha o boot se cookie inseguro, CORS localhost/`*`,
  `appSecret`/`adminToken` ausentes, ou segredo placeholder. `PLATFORM_ADMIN_TOKEN` exige 32+ chars.
- Postgres/Redis sem porta pública (rede interna do compose); Redis com `requirepass` em prod.
  Dockerfile não-root, sem secret em build arg. Backups pg_dump cifrados com GPG antes de sair da VPS
  (`tenant_secrets` já cifrados em repouso — dupla camada).
- Cache de segredos decifrados: LRU (máx 5000) + TTL 60s; nunca cruza tenant nem entra em log
  (redaction do pino cobre token/cookie/ciphertext/apiKey). Telefone mascarado em log (LGPD).
- CSP com **nonce por request** + `strict-dynamic` (sem `unsafe-inline` em script em produção) via
  `apps/web/middleware.ts`; `X-Frame-Options: DENY`, HSTS (Caddy), nosniff, referrer no-referrer.

## Dívidas / follow-ups conhecidos
- **Next.js 14.2.35**: restam CVEs `high` de DoS que só o Next 15 fecha (major com breaking changes).
  Mitigações atuais: painel atrás do Caddy, **sem middleware de auth**, **sem `next/image` remoto**
  (a SSRF do otimizador não se aplica), sem sink de XSS (`dangerouslySetInnerHTML` inexistente).
  Planejar upgrade para Next 15 com teste manual.
- **multer**: sem endpoint de upload (`FileInterceptor` não usado) → a DoS do multer não é acionável;
  fixado via override `^2.2.0`.
- Access token não é revogável dentro da janela curta (só o refresh é) — aceitável; encurtar TTL ou
  denylist de jti se surgir necessidade de revogação imediata de papel.
- Teto de custo é fail-open no outage do Redis (documentado acima).

## Como manter
Fluxo executor(Claude)+revisor(Codex). Rodar antes de deploy: `pnpm typecheck && pnpm test`,
`npx vitest run --config vitest.e2e.config.ts` (em apps/api), `pnpm --filter @sdr/web build`,
e `pnpm audit --prod`. Segredos: gerar com `openssl rand`, nunca commitar (`.env` no gitignore).
