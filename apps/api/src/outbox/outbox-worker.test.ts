import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@sdr/config";
import { OutboxWorker } from "./outbox.worker";
import type { OutboxService } from "./outbox.service";

// @sdr/db mockado — o tick não toca banco real aqui.
const listTenantsWithDueOutbox = vi.fn();
const sweepStuckOutbox = vi.fn().mockResolvedValue(0);
vi.mock("@sdr/db", () => ({
  listTenantsWithDueOutbox: (...a: unknown[]) => listTenantsWithDueOutbox(...a),
  sweepStuckOutbox: (...a: unknown[]) => sweepStuckOutbox(...a),
}));

const cfg = { app: { role: "scheduler" }, redis: { url: "redis://localhost:6379" } } as unknown as AppConfig;

afterEach(() => vi.clearAllMocks());

describe("OutboxWorker.tick — varredura dirigida (sem N+1) + sweep", () => {
  it("processa SÓ os tenants com outbox vencido (query system decide)", async () => {
    listTenantsWithDueOutbox.mockResolvedValue(["T1", "T2"]);
    const processDue = vi.fn().mockResolvedValue(1);
    const worker = new OutboxWorker(cfg, { processDue } as unknown as OutboxService);
    await worker.tick();
    expect(processDue).toHaveBeenCalledTimes(2); // não itera tenants sem trabalho
    expect(sweepStuckOutbox).toHaveBeenCalledTimes(2); // sweep roda por tenant processado
  });

  it("falha de um tenant não derruba os demais (allSettled)", async () => {
    listTenantsWithDueOutbox.mockResolvedValue(["T1", "T2", "T3"]);
    const processDue = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom T1"))
      .mockResolvedValue(1);
    const worker = new OutboxWorker(cfg, { processDue } as unknown as OutboxService);
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(processDue).toHaveBeenCalledTimes(3);
  });

  it("respeita o limite de paralelismo (lotes de até 4 tenants)", async () => {
    listTenantsWithDueOutbox.mockResolvedValue(["T1", "T2", "T3", "T4", "T5", "T6"]);
    let inFlight = 0;
    let maxInFlight = 0;
    const processDue = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 0;
    });
    const worker = new OutboxWorker(cfg, { processDue } as unknown as OutboxService);
    await worker.tick();
    expect(processDue).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // de fato paralelo
  });

  it("sem tenants com trabalho → nenhum processDue", async () => {
    listTenantsWithDueOutbox.mockResolvedValue([]);
    const processDue = vi.fn();
    const worker = new OutboxWorker(cfg, { processDue } as unknown as OutboxService);
    await worker.tick();
    expect(processDue).not.toHaveBeenCalled();
  });
});
