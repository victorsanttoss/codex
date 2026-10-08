import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { InboundRateLimitService } from "./inbound-rate-limit.service";

/** Fake de Redis (incr/expire) em memória; opção de forçar erro (fail-open). */
function fakeRedis(opts?: { throwOnIncr?: boolean }) {
  const store = new Map<string, number>();
  const redis = {
    async incr(k: string) {
      if (opts?.throwOnIncr) throw new Error("redis down");
      const v = (store.get(k) ?? 0) + 1;
      store.set(k, v);
      return v;
    },
    async expire() {
      return 1;
    },
  };
  return redis as unknown as Redis;
}

describe("InboundRateLimitService", () => {
  it("permite até 20/janela e bloqueia o excedente", async () => {
    const svc = new InboundRateLimitService(fakeRedis());
    for (let i = 1; i <= 20; i++) {
      expect(await svc.allow("conv-A"), `msg ${i}`).toBe(true);
    }
    expect(await svc.allow("conv-A")).toBe(false); // 21ª
    expect(await svc.allow("conv-A")).toBe(false); // 22ª
  });

  it("conta por conversa (chaves independentes)", async () => {
    const svc = new InboundRateLimitService(fakeRedis());
    for (let i = 0; i < 20; i++) await svc.allow("conv-A");
    expect(await svc.allow("conv-A")).toBe(false);
    expect(await svc.allow("conv-B")).toBe(true); // outra conversa, limite próprio
  });

  it("fail-OPEN: erro de Redis não bloqueia tráfego legítimo", async () => {
    const svc = new InboundRateLimitService(fakeRedis({ throwOnIncr: true }));
    expect(await svc.allow("conv-A")).toBe(true);
  });
});
