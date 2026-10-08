# ADR 0003 — FIFO por conversa (lock distribuído no Redis)

## Contexto
Mensagens da mesma conversa precisam ser processadas em ordem, sem concorrência
(estado da conversa, evitar respostas intercaladas). Conversas diferentes devem
correr em paralelo. BullMQ só serializa por grupo no plano Pro.

## Decisão
- **Mutex distribuído por `conversation_key`** no Redis: `SET lock:<key> <token>
  NX PX <ttl>`; liberação via script Lua que só apaga se o token bater.
- `RedisMutex.run(key, fn)` adquire o lock (com backoff até `waitMs`), executa e
  libera. No máximo 1 execução por chave por vez; chaves distintas em paralelo.
- TTL no lock protege contra travamento se o processo morrer.
- A pipeline real de mensagem é do M2; o M1 entrega o **primitivo** + testes que
  provam a serialização (unit com Redis fake) e o timeout.

## Consequências
FIFO por conversa sem depender de recurso pago. Custo: lock tem TTL (uma execução
que passe do TTL pode perder exclusividade — dimensionar `ttlMs` ao pior caso do
M2). Idempotência de webhook (dedup pós-sucesso sob o lock, desde o hardening de
2026-07-06) complementa contra reentrega.

## Amendment (2026-07-06) — exclusão mútua ≠ ordem estrita
O mutex garante **exclusão mútua**, não **ordem de chegada**: mensagens do mesmo
lead em rajada (jobs distintos) disputam o lock por polling e podem ser atendidas
fora de ordem; o re-enfileiramento com delay em contenção também pode reordenar.
Aceitamos a limitação porque: (a) dentro de UM webhook as mensagens são
processadas em sequência; (b) o histórico persiste todos os inbounds na ordem de
`received_at`, então o agente vê a conversa completa e correta ao responder —
a inversão afeta no máximo QUAL mensagem dispara o turno, não o contexto; (c) o
dedup + retry garantem que nenhuma mensagem se perde. A correção completa (fila
ordenada por `conversation_key` no Redis, com handoff de posse) adiciona
complexidade real para um efeito raro e cosmético. Reavaliar se surgirem relatos
de respostas "fora de contexto" em rajadas.
