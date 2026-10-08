import { randomUUID } from "node:crypto";

/**
 * Subconjunto do cliente Redis que o mutex usa — permite injetar um fake em
 * teste e provar serialização/heartbeat/fencing sem um Redis real.
 */
export interface RedisLike {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
}

export interface MutexRunOptions {
  /** TTL inicial do lock. Renovado por heartbeat enquanto `fn` roda. */
  ttlMs: number;
  /** Tempo máximo aguardando o lock antes de desistir. */
  waitMs: number;
  /** Intervalo entre tentativas de aquisição. */
  retryMs: number;
  /**
   * Teto de DURAÇÃO total segurando o lock. O heartbeat NÃO renova além disto
   * e `run` rejeita com `LockMaxHoldError` se `fn` ultrapassar o teto — um job
   * travado não segura a conversa para sempre nem manda resposta atrasada
   * depois (o lock é liberado e o fencing barra o envio zumbi).
   */
  maxHoldMs: number;
}

const DEFAULTS: MutexRunOptions = {
  ttlMs: 30_000,
  waitMs: 25_000,
  retryMs: 50,
  maxHoldMs: 180_000,
};

const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const CHECK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return 1 else return 0 end";

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Timeout aguardando lock de conversa: ${key}`);
    this.name = "LockTimeoutError";
  }
}

/** `fn` ultrapassou o teto de duração do lock (maxHoldMs) — job deve falhar. */
export class LockMaxHoldError extends Error {
  constructor(key: string, maxHoldMs: number) {
    super(`Trabalho excedeu o teto de ${maxHoldMs}ms segurando o lock: ${key}`);
    this.name = "LockMaxHoldError";
  }
}

/** Handle do lock entregue ao trabalho — carrega o fencing token e a validade. */
export interface LockHandle {
  /** Token monotônico crescente; um detentor com fence menor está obsoleto. */
  readonly fence: number;
  /** O lock ainda é nosso? (false = expirou e/ou foi tomado por outro). */
  isValid(): Promise<boolean>;
}

/**
 * Mutex distribuído por chave com HEARTBEAT (renova o TTL enquanto `fn` roda,
 * resolvendo a dívida nº1: jobs longos não perdem exclusividade) e FENCING
 * TOKEN (monotônico; um detentor "zumbi" — cujo lock expirou e foi retomado —
 * é detectável via isValid()/fence, barrando writes obsoletos). O heartbeat
 * tem TETO (`maxHoldMs`): renovar para sempre transformaria um job travado em
 * dono eterno da conversa.
 */
export class RedisMutex {
  constructor(
    private readonly redis: RedisLike,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async run<T>(
    key: string,
    fn: (handle: LockHandle) => Promise<T>,
    opts?: Partial<MutexRunOptions>,
  ): Promise<T> {
    const o = { ...DEFAULTS, ...opts };
    const lockKey = `lock:${key}`;
    const deadline = Date.now() + o.waitMs;

    for (;;) {
      const token = randomUUID();
      const acquired = await this.redis.set(lockKey, token, "PX", o.ttlMs, "NX");
      if (acquired === "OK") {
        const startedAt = Date.now();
        const fence = await this.redis.incr(`fence:${key}`);
        let lost = false;
        const handle: LockHandle = {
          fence,
          isValid: async () =>
            !lost && (await this.redis.eval(CHECK_LUA, 1, lockKey, token)) === 1,
        };
        const interval = Math.max(10, Math.floor(o.ttlMs / 3));
        const timer = setInterval(() => {
          // TETO: além de maxHoldMs, para de renovar (o lock expira sozinho e a
          // corrida abaixo já terá rejeitado o run).
          if (Date.now() - startedAt >= o.maxHoldMs) {
            clearInterval(timer);
            return;
          }
          void this.renew(lockKey, token, o.ttlMs).then((ok) => {
            if (!ok) {
              lost = true;
              clearInterval(timer);
            }
          });
        }, interval);
        // não segurar o event loop por causa do heartbeat
        if (typeof timer.unref === "function") timer.unref();

        // corrida contra o teto: se `fn` passar de maxHoldMs, rejeita (o finally
        // libera o lock; um envio tardio de `fn` é barrado pelo fencing/isValid).
        let capTimer: ReturnType<typeof setTimeout> | undefined;
        const cap = new Promise<never>((_, reject) => {
          capTimer = setTimeout(() => {
            lost = true;
            reject(new LockMaxHoldError(key, o.maxHoldMs));
          }, o.maxHoldMs);
          if (typeof capTimer.unref === "function") capTimer.unref();
        });

        try {
          const work = fn(handle);
          // rejeição TARDIA de `fn` (depois do teto) não pode virar unhandledRejection.
          work.catch(() => {});
          return await Promise.race([work, cap]);
        } finally {
          if (capTimer) clearTimeout(capTimer);
          clearInterval(timer);
          await this.release(lockKey, token);
        }
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(key);
      await this.sleep(o.retryMs);
    }
  }

  private async renew(lockKey: string, token: string, ttlMs: number): Promise<boolean> {
    const r = await this.redis.eval(RENEW_LUA, 1, lockKey, token, String(ttlMs));
    return r === 1;
  }

  private async release(lockKey: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, lockKey, token);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
