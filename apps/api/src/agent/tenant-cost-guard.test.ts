import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { TenantCostGuard } from "./tenant-cost-guard";

/** Fake mínimo de Redis (incrby/expire/set NX) em memória, p/ teste sem Redis. */
function fakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    async incrby(k: string, n: number) {
      const v = Number(store.get(k) ?? 0) + n;
      store.set(k, String(v));
      return v;
    },
    async expire() {
      return 1;
    },
    async set(k: string, v: string, _ex: string, _ttl: number, nx: string) {
      if (nx === "NX" && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    },
  };
  return { redis: redis as unknown as Redis, store };
}

/** Redis que sempre falha (simula indisponibilidade) — testa o fail-open. */
function brokenRedis(): Redis {
  const boom = async () => {
    throw new Error("Redis indisponível");
  };
  return { incrby: boom, expire: boom, set: boom } as unknown as Redis;
}

describe("TenantCostGuard", () => {
  it("reserve: libera abaixo do teto, rejeita ao ultrapassar (COM a reserva somada)", async () => {
    const { redis } = fakeRedis();
    const guard = new TenantCostGuard(redis);
    // reserva 600k; total 600k ≤ 1M → liberado
    expect((await guard.reserve("t1", 1_000_000, 600_000)).allowed).toBe(true);
    // reserva +600k; total 1.2M > 1M → rejeitado
    expect((await guard.reserve("t1", 1_000_000, 600_000)).allowed).toBe(false);
  });

  it("reserve é ATÔMICO: concorrentes não passam todos do teto (sem bypass por corrida)", async () => {
    const { redis } = fakeRedis();
    const guard = new TenantCostGuard(redis);
    // teto 100k, reserva 50k por turno: no máximo 2 concorrentes passam.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => guard.reserve("t1", 100_000, 50_000)),
    );
    expect(results.filter((r) => r.allowed).length).toBe(2);
  });

  it("reconcile: ajusta a reserva para o custo real (devolve a diferença)", async () => {
    const { redis } = fakeRedis();
    const guard = new TenantCostGuard(redis);
    // reserva 50k; real foi 10k → reconcilia -40k. Sobra 10k no contador.
    await guard.reserve("t1", 1_000_000, 50_000);
    await guard.reconcile("t1", 50_000, 10_000);
    // após devolver, ainda cabe muita reserva
    expect((await guard.reserve("t1", 1_000_000, 900_000)).allowed).toBe(true); // 10k+900k ≤ 1M
  });

  it("FAIL-OPEN: Redis fora no reserve → libera (disponibilidade > enforcement)", async () => {
    const guard = new TenantCostGuard(brokenRedis());
    const r = await guard.reserve("t1", 1_000_000, 50_000);
    expect(r.allowed).toBe(true);
    expect(r.reserved).toBe(0); // nada reservado → nada a reconciliar
  });

  it("addCost (custo avulso do resumo) entra no contador e conta pro teto", async () => {
    const { redis } = fakeRedis();
    const guard = new TenantCostGuard(redis);
    await guard.addCost("t1", 950_000);
    // já perto do teto: uma reserva de 100k estoura
    expect((await guard.reserve("t1", 1_000_000, 100_000)).allowed).toBe(false);
  });

  it("addCost ignora valores não-positivos", async () => {
    const { redis } = fakeRedis();
    const guard = new TenantCostGuard(redis);
    await guard.addCost("t1", 0);
    await guard.addCost("t1", -5);
    expect((await guard.reserve("t1", 10, 1)).allowed).toBe(true); // contador ainda ~0
  });

  it("claimContentionNotice: só o 1º claim do dia vence (não spamar)", async () => {
    const { redis } = fakeRedis();
    const guard = new TenantCostGuard(redis);
    expect(await guard.claimContentionNotice("t1")).toBe(true);
    expect(await guard.claimContentionNotice("t1")).toBe(false);
    expect(await guard.claimContentionNotice("t2")).toBe(true); // outro tenant
  });

  it("contadores são isolados por tenant", async () => {
    const { redis } = fakeRedis();
    const guard = new TenantCostGuard(redis);
    await guard.addCost("t1", 2_000_000);
    expect((await guard.reserve("t1", 1_000_000, 1)).allowed).toBe(false);
    expect((await guard.reserve("t2", 1_000_000, 1)).allowed).toBe(true);
  });
});
