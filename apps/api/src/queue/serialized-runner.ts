import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../redis/redis.module";
import {
  RedisMutex,
  type LockHandle,
  type MutexRunOptions,
  type RedisLike,
} from "./redis-mutex";

/**
 * Executa trabalho serializado por `conversation_key` (FIFO por conversa):
 * no máximo 1 execução por chave por vez (chaves distintas em paralelo).
 *
 * LIMITAÇÃO (ver ADR 0003): o lock tem TTL fixo e NÃO é renovado. Se `fn`
 * passar de `ttlMs`, o lock expira e outro job pode entrar — a exclusividade
 * vale enquanto `fn` < `ttlMs`. O M2 (pipeline real) deve dimensionar o TTL ao
 * pior caso e/ou adicionar heartbeat + fencing token. Contexto de tenant é
 * responsabilidade do chamador.
 */
@Injectable()
export class SerializedRunner {
  private readonly mutex: RedisMutex;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.mutex = new RedisMutex(redis as unknown as RedisLike);
  }

  run<T>(
    conversationKey: string,
    fn: (handle: LockHandle) => Promise<T>,
    opts?: Partial<MutexRunOptions>,
  ): Promise<T> {
    return this.mutex.run(conversationKey, fn, opts);
  }
}
