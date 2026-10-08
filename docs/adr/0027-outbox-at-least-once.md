# ADR 0027 — Outbox de saída (at-least-once com dedup)

## Contexto
Até o M7 o envio era **at-most-once** (claim antes do send, sem estado): um crash
após o claim deixava o lead sem resposta. Para **cadência proativa** isso é
inaceitável — um follow-up não pode sumir. Mas o oposto (entregar 2×) é spam.

## Decisão
- **Tabela `outbox_messages`** com máquina de estados
  `pending → sending → sent → delivered/read/failed`. Enfileirar = inserir
  `pending` com `idempotency_key` **único por tenant** (reivindica o envio).
- **Worker** reivindica atomicamente (`FOR UPDATE SKIP LOCKED`): `pending` vencidas
  E `sending` **órfãs** (worker morreu no meio, `updated_at` além de um *lease*).
  Envia e marca `sent` + `external_message_id`; falha transiente → `pending` +
  backoff (até `max_attempts`); permanente → `failed`.
- **At-least-once (honesto)**: o `client_message_id` vai como
  `biz_opaque_callback_data` ao provedor — é **correlação/echo** (volta nos
  status), **não dedup garantido** pela Cloud API. Logo a entrega é **at-least-once**:
  um crash entre o POST e o `markOutboxSent` pode reenviar a órfã e **duplicar**.
  Mitigações: *lease* longo (5min) antes de reclamar órfã (minimiza a janela);
  reconciliação por `external_message_id`. Não prometemos "exactly-once".
- **Reconciliação**: os status `delivered`/`read`/`failed` do webhook (já
  processados pela pipeline do M2) avançam a linha por `external_message_id`
  (monotônico).

## Consequências
Entrega confiável para cadência (e base para unificar o `reply()` reativo — ver
follow-up). O envio é seguro sob crash/retry. **Follow-up imediato**: rotear também
o `reply()` reativo por este outbox para haver um único caminho de saída com
garantia (mantido fora do M8 para não desestabilizar os testes reativos do M2;
hoje convivem dois mecanismos — o reativo (`recordOutboundMessage` direto) e o
proativo (outbox)).
