# M8 — Revisão do Codex (cadência + outbox) + triagem

Revisor: OpenAI Codex (`gpt-5.5`, read-only) sobre o outbox (schema/repos/serviço/
worker), a cadência (config/serviço/templates/opt-out/worker), o adaptador
(`biz_opaque_callback_data`), o wiring no handler e a reconciliação na pipeline.
**2 achados CRÍTICOS** — coerente com o princípio anti-ban do módulo.

Confirmou: opt-out não chama LLM; stop-on-engagement antes do turno; qualified/
handoff/disqualified re-checados no scan; templates contra catálogo aprovado;
cadência opt-in por default; template proativo marcado como pago.

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 1 | **CRÍTICO** | Outbox enviava sem revalidar guardrails: se o lead opta-out/responde ENTRE o enfileiramento e o envio, a mensagem proativa saía | (a) `cancelPendingOutbox` cancela pendências da conversa no opt-out e no stop-on-engagement; (b) `OutboxService` **revalida no envio** (opt-out, lead resolvido, e janela 24h p/ free_form) → cancela (terminal, sem retry) se falhar |
| 2 | **CRÍTICO** | `biz_opaque_callback_data` não é dedup real do provedor — prometer entrega ≤1 era incorreto | Honestidade: documentado como **at-least-once** (pode duplicar em crash pós-POST); `biz_opaque_callback_data` é correlação + reconciliação; **lease maior** (5min) minimiza a janela de reenvio de órfã. ADR 0027 corrigido |
| 3 | ALTO | `recordUsage` no MESMO try do envio: metering falho reabria msg já enviada p/ retry | `markOutboxSent` + metering FORA do try do envio (metering best-effort) — nunca rebaixa `sent` |
| 4 | ALTO | Outbox aceitava `free_form` sem checar janela 24h | envio de `free_form` revalida `isWithinServiceWindow`; fora da janela → cancela permanente |
| 5 | ALTO | Reconciliação tratava `failed` > `read` → `failed` atrasado rebaixava entregue/lido | `failed` só avança de pending/sending/sent; nunca sobrescreve delivered/read |
| 6 | ALTO | Teto de frequência contava só sent/delivered/read → várias cadências enfileiravam antes do envio | `countOutboxSentSince` conta também `pending`/`sending` (proativo) na janela |
| 8 | MÉDIO | `timezone` da config não-confiável sem validação (tz inválido derruba o tick) | `safeTimezone` valida via `Intl`; inválido → `America/Sao_Paulo` |
| 9 | MÉDIO | FK composta `ON DELETE SET NULL` sobre `(tenant_id, conversation_id)` tentaria anular `tenant_id` (NOT NULL) → delete falha | migration 0012: troca p/ `ON DELETE CASCADE` em opportunities/appointments/outbox |

## Documentado (consciente)
- **#7 (MÉDIO)** `claimDueCadence` é `SELECT FOR UPDATE SKIP LOCKED` (lock só na tx);
  dois ticks podem processar a mesma cadência. **É seguro**: o disparo é idempotente
  por passo (`cadence:{conversa}:{passo}` no outbox) e a revalidação no envio (#1)
  torna o reprocessamento inócuo. Claim "duro" (status processing) é melhoria futura.
- **#10 (BAIXO)** O schema Drizzle modela `conversationId` como FK simples enquanto a
  migration usa FK composta (só na migration). Drift cosmético — a migration é a
  fonte de verdade; documentado.
- **#2 (escopo)** Unificar o `reply()` reativo no outbox segue como follow-up
  imediato (ADR 0027).
