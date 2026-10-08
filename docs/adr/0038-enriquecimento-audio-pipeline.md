# ADR 0038 — Enriquecimento de áudio na pipeline (áudio → texto)

## Contexto
A transcrição precisa entrar no fluxo sem reescrever o loop do agente (M6) nem a
pipeline de entrada (M2). E precisa ser robusta: STT falha, áudio pode ser enorme,
webhook da Meta é reentregue (não pode re-transcrever/re-cobrar).

## Decisão
- **Passo de enriquecimento, não um novo loop.** Na pipeline, áudio inbound é
  baixado (M2 — `downloadAndStore` agora **devolve os bytes**, sem re-download),
  transcrito e injetado como uma **mensagem de texto comum** no `INBOUND_HANDLER`.
  O agente não sabe que veio de voz: `type: "text"` + `text: <transcrição>`. O loop,
  a qualificação, os guardrails e a idempotência de resposta do M6 ficam **intactos**.
- **Idempotência por `provider_media_id`.** A transcrição é persistida na
  `media_objects` (vinculada à message) e consultada antes de transcrever. Reentrega
  → cache hit → **não re-transcreve nem re-cobra**. O teto de duração é reavaliado
  também no cache hit (consistente entre retries).
- **Dois freios de custo.** (1) **Tamanho** pré-cobrança: bytes acima do limite não
  são transcritos (freio principal numa VPS). (2) **Duração** pós-transcrição: áudio
  longo demais é persistido (metering honesto) mas **não injetado** — o lead recai na
  política não-texto. O **teto de custo por conversa do M6 segue aplicado, intacto**,
  ao turno do LLM (que recebe só texto) — STT não o infla nem o burla.
- **Falha → graceful.** Qualquer erro de STT (ou `enabled=false`) devolve `null` e o
  áudio cai na política não-texto do M6. **Não cacheia em falha** (permite retry).
  Categoria de erro segura no log — nunca bytes nem segredo.

## Consequências
Ligar/desligar STT é uma flag (`TRANSCRIPTION_ENABLED`). O custo é metrado e
limitado por tamanho; um teto rígido por-conversa cobrindo STT+LLM juntos fica como
refinamento futuro (hoje o tamanho do áudio é o teto prático e o cap do M6 protege o
LLM). A mesma mídia em mensagens diferentes (encaminhamento) reaproveita o cache do
tenant via índice `(tenant_id, provider_media_id)`.

**Ordem cobrança×cache (revisão Codex M12):** o cache é persistido **antes** do
metering — um crash entre transcrever e cachear causa, no pior caso, **uma
subcobrança** (preferível a cobrar duas vezes). **Concorrência:** o `SerializedRunner`
serializa por conversa, então retries da mesma conversa não duplicam; a mesma mídia
em **conversas distintas em paralelo** pode, na primeira vez, transcrever duas vezes
(cache miss simultâneo) — trade-off aceito (evento raro, custo de 1 transcrição
extra) em vez de lock distribuído por mídia. **Duração ausente** de modelo pago cobra
pelo **teto** (`maxDurationSeconds`), nunca 0 — fail-closed de billing.
