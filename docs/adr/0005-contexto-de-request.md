# ADR 0005 — Contexto de request (AsyncLocalStorage com store mutável)

## Contexto
O `tenant_id` precisa fluir do request HTTP (e de jobs) até a camada de dados,
sem passar por parâmetro em toda função. O tenant só é conhecido **após** a
autenticação (guard), mas o contexto precisa estar ativo antes (logs, request_id).

## Decisão
- `AsyncLocalStorage` com um **store mutável** por execução.
- O middleware HTTP envolve a requisição inteira num **único `storage.run()`**
  (`runWithRequestContext`), anônimo no início.
- O `JwtAuthGuard` preenche o tenant via **`assignTenant()`** (mutação do mesmo
  store) — visível para handler e services.
- Jobs/uso explícito usam `runWithTenant` / `runAsSystem` (escopo de callback).
- `requireTenantContext()` lança se não houver tenant ativo (deny-by-default na
  camada de dados).

## Por que não `enterWith` no guard
Verificado em e2e: `AsyncLocalStorage.enterWith()` chamado no guard **não
propagava** o tenant até o handler (que herdava o contexto anterior do
middleware), causando 500 em rotas tenant-scoped. O padrão `run()`-envolvendo-tudo
+ mutação (mesma ideia do `nestjs-cls`) é robusto.

## Consequências
Contexto confiável sem dependência extra. `assignTenant` muta o store atual —
exige que a requisição esteja sob `runWithRequestContext`.
