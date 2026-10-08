# M3 — Revisão do Codex (Embedded Signup) + triagem

Revisor: OpenAI Codex (read-only) sobre `embedded-signup.service`, `signup.controller`,
`account-events.service`, `token-expiry.service`, o trecho novo do pipeline, os repos
de conexão + migration 0003, `normalizeAccountEvents` e a UI `connect`.
Sem achados CRÍTICOS.

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 1 | ALTO | Token `code:190` numérico não detectado (só string) → não desconectava | `mapHttpError` normaliza `code` numérico p/ string |
| 2 | ALTO | Signup não provava número ∈ WABA (admin podia conectar número de outra WABA) | `assertNumberInWaba` (GET /{waba}/phone_numbers) antes de subscribe/register/persist |
| 3 | MÉDIO | `account_update` por WABA atualizava só 1 número (`limit 1`) | `findConnectionsByWaba` retorna todos; status aplicado em lote |
| 4 | MÉDIO | Corrida cross-tenant: efeitos externos antes do conflito final | catch na persistência → re-checa dono → `SignupConflictError` (409) |
| 5 | MÉDIO | Front aceitava `postMessage` sem validar origem | valida `e.origin` (facebook.com) + limpa seleção antes do `FB.login` |
| 7 | BAIXO | `mapEventToStatus` por regex frágil | allowlist de eventos conhecidos + log de desconhecidos (fail-safe) |

## Documentado (dívida consciente)

- **#6 (BAIXO)** `client_secret`/`code` na query do GET de oauth (formato da Meta):
  não logamos a URL; garantir redaction em proxies/APM. (ADR 0012.)
- **Refresh real de token**: `TokenExpiryService` alerta a cada hora sem estado —
  reloga expirados; adicionar estado de alerta/refresh antes do M4 (apontado).
- waba→tenant itera tenants; vira branch de policy (`app.resolve_waba`) se crescer.

## Confirmado pelo Codex (sem ação)

Tenant binding correto (sessão via `requireTenantContext`, DTO sem `tenantId`,
guards globais, RLS `FORCE`); `findConnectionOwner` cobre qualquer status; revoke
remove o token; `TokenExpiryService` não vaza timer; o scan por tenants respeita RLS.
