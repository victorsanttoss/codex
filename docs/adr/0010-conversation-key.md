# ADR 0010 — Convenção de `conversation_key`

## Contexto
A serialização FIFO e a deduplicação dependem de uma chave estável que identifique
uma conversa de forma determinística, por tenant.

## Decisão
- Convenção: `cloud_api:{phone_number_id}:{contact_wa_id}`.
  - `cloud_api` = provedor; `phone_number_id` = conta do tenant que recebeu;
    `contact_wa_id` = número do contato.
- É única por tenant (`unique(tenant_id, conversation_key)`), determinística (o
  mesmo par sempre gera a mesma chave) e serve de chave de partição para o
  `SerializedRunner` (FIFO por conversa).

## Consequências
Mensagens da mesma conversa serializam; de contatos/números diferentes correm em
paralelo. Outros canais (ex.: via não-oficial) usam o mesmo formato com outro
prefixo de provedor, mantendo o seam agnóstico.
