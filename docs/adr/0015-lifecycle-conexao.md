# ADR 0015 — Lifecycle de conexão (três gatilhos)

## Contexto
Uma conexão pode deixar de funcionar por várias razões; o resolver do M2 só deve
rotear conexões válidas (já filtra `status='active'`).

## Decisão
Transições `active ↔ disconnected ↔ revoked` por três gatilhos:
1. **Admin**: `POST /admin/whatsapp/connections/:pnid/disconnect` → `disconnected`;
   `.../revoke` → `revoked` + **inativa o token** (`TenantSecretsStore.delete`).
2. **Falha de token**: erro de auth no envio (401 / OAuth 190) → marca
   `disconnected` + alerta (na pipeline do M2, sem alterá-la estruturalmente).
3. **Eventos da Meta** (`account_update`): handler ADITIVO, fora da pipeline de
   mensagem. `entry.id` = waba_id → resolve a conexão (`findConnectionTenantByWaba`,
   itera tenants) → transiciona (BAN/VIOLATION/DELETE/DISABLE → `revoked`;
   RESTRICT → `disconnected`).
- `last_lifecycle_event_at` registra a última transição.
- `TokenExpiryService` (interval) varre tokens perto de expirar e alerta.

## Consequências
Em qualquer dos gatilhos, o resolver do M2 para de rotear automaticamente. A
resolução por waba itera tenants (eventos de conta são raros); poderia virar um
branch de policy (`app.resolve_waba`) se a frequência crescer.
