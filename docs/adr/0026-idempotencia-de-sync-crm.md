# ADR 0026 — Idempotência de sincronização com o CRM

## Contexto
A sync é disparada quando o lead vira `qualified`/`handoff`. O job tem **retry** e
o **mesmo lead pode bater handoff mais de uma vez**. Não pode criar contato/
oportunidade duplicados no CRM, nem agendamento/notificação repetidos.

## Decisão
Idempotência em **camadas**:
- **Dedup nativo do provider**: `upsertContact` deduplica por **telefone** (chave
  natural do WhatsApp) e `upsertOpportunity` por **contato** (um deal por contato no
  built-in; o CRM externo usa o próprio dedup). Re-sync → mesmos IDs.
- **Mapa `crm_external_sync`** (tenant-scoped, unique por conversa): registra
  `contact_external_id`/`opportunity_external_id` + `status` (`pending`/`synced`/
  `failed`). É a verdade de "este lead já foi sincronizado" e guarda o último erro.
- **Agendamento e notificação**: chave de idempotência própria
  (`{conversa}:sched:{hash}` e `{conversa}:handoff`) com `UNIQUE` no banco →
  disparam **uma vez** mesmo com re-entrega.
- A sync roda via **fila BullMQ** no contexto do tenant; em falha, grava
  `status='failed'` + `last_error` e relança para o worker re-tentar (backoff).

## Consequências
Retry do worker ou novo handoff do mesmo lead **não duplica** nada. O estado de
sync é auditável (`crm_external_sync`). O agendamento/notificação são "exactly-once
por evento" via constraint. Sincronização bidirecional profunda com o CRM (webhooks
de volta) fica para depois — aqui o fluxo é só de saída (lead → CRM).
