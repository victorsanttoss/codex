import { describe, expect, it } from "vitest";
import { LockMaxHoldError, LockTimeoutError, RedisMutex, type RedisLike } from "./redis-mutex";

/**
 * FakeRedis modela NX/PX (com expiração por relógio real), INCR (fencing) e o
 * eval de RENEW/CHECK/RELEASE — determinístico o suficiente para provar
 * heartbeat e fencing sem um Redis real.
 */
class FakeRedis implements RedisLike {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private counters = new Map<string, number>();

  private alive(key: string): boolean {
    const e = this.store.get(key);
    if (!e) return false;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async set(key: string, value: string, _px: "PX", ttlMs: number, _nx: "NX") {
    if (this.alive(key)) return null;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return "OK" as const;
  }

  async incr(key: string): Promise<number> {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }

  async eval(script: string, _n: number, key: string, arg1: string, arg2?: string) {
    if (!this.alive(key)) return 0;
    const e = this.store.get(key)!;
    if (e.value !== arg1) return 0;
    if (script.includes("pexpire")) {
      e.expiresAt = Date.now() + Number(arg2);
      return 1;
    }
    if (script.includes("del")) {
      this.store.delete(key);
      return 1;
    }
    return 1; // CHECK
  }

  forceExpire(key: string): void {
    this.store.delete(key);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("RedisMutex", () => {
  it("serializa dois jobs com a MESMA chave (sem sobreposição)", async () => {
    const mutex = new RedisMutex(new FakeRedis());
    const events: string[] = [];
    const job = (id: string) =>
      mutex.run(
        "conv-A",
        async () => {
          events.push(`start-${id}`);
          await sleep(20);
          events.push(`end-${id}`);
        },
        { ttlMs: 1000, waitMs: 2000, retryMs: 5 },
      );
    await Promise.all([job("1"), job("2")]);
    expect(events).toHaveLength(4);
    expect(events[1]).toBe(`end-${events[0]!.split("-")[1]}`); // termina antes do 2º começar
  });

  it("jobs com chaves DIFERENTES rodam concorrentes", async () => {
    const mutex = new RedisMutex(new FakeRedis());
    const active = { count: 0, max: 0 };
    const job = (key: string) =>
      mutex.run(key, async () => {
        active.count++;
        active.max = Math.max(active.max, active.count);
        await sleep(20);
        active.count--;
      });
    await Promise.all([job("a"), job("b"), job("c")]);
    expect(active.max).toBeGreaterThan(1);
  });

  it("HEARTBEAT: job mais longo que o ttl inicial mantém exclusividade", async () => {
    const mutex = new RedisMutex(new FakeRedis());
    // ttl 60ms, mas o job dura ~200ms; o heartbeat (a cada ~20ms) renova o lock.
    const holder = mutex.run("conv-H", async () => sleep(200), {
      ttlMs: 60,
      waitMs: 50,
      retryMs: 10,
    });
    await sleep(10); // garante que o holder adquiriu primeiro
    // competidor espera 120ms; como o lock é renovado, NUNCA fica livre -> timeout
    const competitor = mutex.run("conv-H", async () => "nunca", {
      ttlMs: 60,
      waitMs: 120,
      retryMs: 10,
    });
    const [h, c] = await Promise.allSettled([holder, competitor]);
    expect(h.status).toBe("fulfilled");
    expect(c.status).toBe("rejected");
    if (c.status === "rejected") expect(c.reason).toBeInstanceOf(LockTimeoutError);
  });

  it("FENCING: fence é monotônico e um detentor 'zumbi' é detectado (isValid=false)", async () => {
    const redis = new FakeRedis();
    const mutex = new RedisMutex(redis);
    let fenceA = 0;
    let isValidAfter = true;

    const fenceB = await mutex.run(
      "conv-Z",
      async (handleA) => {
        fenceA = handleA.fence;
        expect(await handleA.isValid()).toBe(true);
        // simula o lock de A expirando e sendo retomado por B
        redis.forceExpire("lock:conv-Z");
        const fb = await mutex.run("conv-Z", async (handleB) => handleB.fence, {
          ttlMs: 10_000,
        });
        isValidAfter = await handleA.isValid(); // A virou zumbi
        return fb;
      },
      { ttlMs: 10_000 }, // ttl alto: heartbeat não interfere no teste
    );

    expect(fenceB).toBeGreaterThan(fenceA);
    expect(isValidAfter).toBe(false);
  });

  it("estoura LockTimeoutError se o lock não é liberado dentro de waitMs", async () => {
    const redis = new FakeRedis();
    await redis.set("lock:conv-Z2", "outro-dono", "PX", 60_000, "NX");
    const mutex = new RedisMutex(redis);
    await expect(
      mutex.run("conv-Z2", async () => "x", { ttlMs: 1000, waitMs: 60, retryMs: 10 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it("TETO (maxHoldMs): fn mais longa que o teto → rejeita e LIBERA o lock", async () => {
    const redis = new FakeRedis();
    const mutex = new RedisMutex(redis);
    const t0 = Date.now();
    // fn dura 500ms, teto de 80ms → rejeita ~80ms (não espera a fn terminar).
    await expect(
      mutex.run("conv-CAP", () => sleep(500), { ttlMs: 40, maxHoldMs: 80, waitMs: 50, retryMs: 10 }),
    ).rejects.toBeInstanceOf(LockMaxHoldError);
    expect(Date.now() - t0).toBeLessThan(400);
    // o lock foi liberado no finally: outro job entra sem esperar o TTL expirar.
    const got = await mutex.run("conv-CAP", async () => "entrei", {
      ttlMs: 1000,
      waitMs: 100,
      retryMs: 10,
    });
    expect(got).toBe("entrei");
  });

  it("TETO: dentro do teto o heartbeat continua funcionando normalmente", async () => {
    const mutex = new RedisMutex(new FakeRedis());
    // ttl 60ms, fn 150ms, teto folgado (1s): completa graças ao heartbeat.
    const out = await mutex.run("conv-CAP2", async () => { await sleep(150); return "ok"; }, {
      ttlMs: 60,
      waitMs: 50,
      retryMs: 10,
      maxHoldMs: 1_000,
    });
    expect(out).toBe("ok");
  });

  it("TETO: após exceder, o handle fica inválido (fencing barra envio tardio)", async () => {
    const redis = new FakeRedis();
    const mutex = new RedisMutex(redis);
    let validAfterCap: boolean | undefined;
    const run = mutex.run(
      "conv-CAP3",
      async (handle) => {
        await sleep(150); // ultrapassa o teto de 60ms
        validAfterCap = await handle.isValid();
        return "tarde";
      },
      { ttlMs: 1000, waitMs: 50, retryMs: 10, maxHoldMs: 60 },
    );
    await expect(run).rejects.toBeInstanceOf(LockMaxHoldError);
    await sleep(150); // deixa a fn zumbi terminar e checar a validade
    expect(validAfterCap).toBe(false);
  });
});
