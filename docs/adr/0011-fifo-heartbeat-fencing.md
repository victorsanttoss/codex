# ADR 0011 — FIFO endurecido: heartbeat + fencing (resolve dívida nº1)

## Contexto
O `RedisMutex` do M1 usava TTL fixo sem renovação: a exclusividade só valia
enquanto `fn` durava menos que `ttlMs`. Como a pipeline real carrega
processamento lento (LLM no M4, agente no M6), o lock poderia expirar no meio e
deixar dois jobs concorrentes na mesma conversa (quebrando o FIFO).

## Decisão
- **Heartbeat:** enquanto `fn` roda, um timer renova o TTL do lock (Lua
  `pexpire` checando o token). Job longo NÃO perde exclusividade.
- **Fencing token:** a cada aquisição, um contador monotônico (`INCR fence:<key>`)
  é entregue ao trabalho via `LockHandle.fence`. Um detentor "zumbi" (lock
  expirou e foi retomado por outro) é detectável: `handle.isValid()` retorna
  false, barrando writes obsoletos.
- O `SerializedRunner.run` repassa o `LockHandle` ao trabalho.
- Testado com FakeRedis modelando TTL/INCR/renew: job > TTL inicial mantém o
  lock; zumbi é detectado; fence é monotônico.

## Consequências
FIFO por conversa robusto mesmo com processamento lento. O M2/M6 devem usar
`handle.isValid()` antes de writes críticos quando o processamento for muito
longo; e dimensionar o TTL inicial ao pior caso conhecido.
