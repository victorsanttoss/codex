# ADR 0014 — Guard de conflito de número

## Contexto
`phone_number_id` é `UNIQUE` global: um número pertence a exatamente um tenant.
O signup precisa decidir o que fazer quando o número já existe.

## Decisão
- `findConnectionOwner(phoneNumberId)` (caminho system, **qualquer status**) acha o
  dono atual antes de registrar.
- Se o dono é **outro** tenant → `SignupConflictError` → HTTP **409** (um número
  não migra de tenant).
- Se o dono é o **mesmo** tenant → **reconexão/rotação** (upsert reativa + novo
  token), `reconnected=true`. Vale inclusive para conexões `disconnected/revoked`
  do próprio tenant.

## Consequências
Conflitos cross-tenant são recusados explicitamente; reconexão do próprio tenant é
transparente. Coberto por testes (conflito e reconexão).
