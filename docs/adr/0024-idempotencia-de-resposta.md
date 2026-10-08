# ADR 0024 — Idempotência de envio do agente

## Contexto
O agente roda no **worker BullMQ com retry**. Se um turno falhar APÓS enviar a
resposta (ex.: erro ao persistir, crash), o job é re-tentado e o lead poderia
receber a **mesma mensagem 2×** — péssimo. O dedup de inbound (`processed_messages`,
M2) reduz, mas o envio do agente precisa de garantia própria por passo.

## Decisão
- **Reivindicar antes de enviar**: cada envio do agente reivindica uma chave de
  idempotência `(tenantId, conversationId, inbound externalMessageId, stepIndex)`
  via `claimAgentResponse` — `INSERT ... ON CONFLICT DO NOTHING` numa tabela
  tenant-scoped (`agent_response_claims`, unique `(tenant_id, claim_key)`). Se a
  chave **já existe**, o envio é **pulado**.
- A reivindicação acontece **antes** de chamar a Cloud API → garante **no máximo
  um envio por passo**, mesmo sob retry. (Trade-off consciente: at-most-once; se o
  envio falhar logo após o claim, aquele passo não reenvia — preferível a duplicar.)
- `stepIndex` cobre múltiplos envios no mesmo turno (ex.: handoff). A tabela é
  tenant-scoped com RLS FORCE — a chave de um tenant nunca colide com a de outro.

## Consequências
Resolve a dívida #5 do M2 (idempotência outbound) para o caminho do agente. O envio
é seguro sob retry. Casos de "enviou mas não persistiu o claim" não ocorrem porque o
claim é commitado antes do envio. Reenvio proativo fora da janela (cadência) é M7+ e
usará a mesma tabela com chaves próprias.
