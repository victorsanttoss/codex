# ADR 0013 — Tenant binding do signup via sessão

## Contexto
No onboarding, a qual tenant a conexão pertence? Aceitar um `tenant_id` vindo do
cliente seria uma porta de sequestro de número entre tenants.

## Decisão
- O tenant é SEMPRE o tenant ativo da **sessão** (`requireTenantContext()`,
  populado pelo JWT no guard). Nunca um id vindo do payload.
- O DTO do callback (`code`, `phoneNumberId`, `wabaId`) **não tem** campo de
  tenant; o `ValidationPipe` (whitelist) descarta qualquer extra.
- Endpoints de signup/lifecycle exigem `@Roles('admin')`.

## Consequências
Impossível atribuir uma conexão a outro tenant via payload. Coberto por teste
explícito (a conexão cai sempre no tenant da sessão).
