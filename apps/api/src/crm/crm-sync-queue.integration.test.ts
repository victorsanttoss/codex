import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { requireTenantContext } from "@sdr/core";
import type { AppConfig } from "@sdr/config";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { CrmSyncQueue, syncJobId, type SyncJob } from "./crm-sync.queue";
import type { CrmSyncService, LeadSyncPayload } from "./crm-sync.service";

// Opt-in: use ONLY a disposable Redis without another crm-sync worker/producer.
// Never fall back to REDIS_URL, which may point to an application environment.
const redisUrl = process.env.CRM_QUEUE_TEST_REDIS_URL;

describe.skipIf(!redisUrl)(
  "CRM queue — BullMQ/Redis reais, destino simulado",
  () => {
    let queue: CrmSyncQueue;
    let inspector: Queue<SyncJob>;
    const ownIds = new Set<string>();
    const sync = vi.fn<(payload: LeadSyncPayload) => Promise<void>>();
    let errors: MockInstance;

    function job(overrides: Partial<SyncJob> = {}): SyncJob {
      return {
        tenantId: `crm-test-${randomUUID()}`,
        conversationId: `crm-conv-${randomUUID()}`,
        phone: "+5511999999999",
        fields: { quartos: 2 },
        stage: "qualified",
        status: "qualified",
        score: 80,
        ...overrides,
      };
    }

    async function enqueue(payload: SyncJob): Promise<string> {
      const id = syncJobId(payload);
      ownIds.add(id);
      await queue.enqueueSync(payload);
      return id;
    }

    async function waitForState(
      id: string,
      state: "active" | "completed" | "failed",
      timeout = 5000,
    ) {
      await vi.waitFor(
        async () => {
          expect(await (await inspector.getJob(id))?.getState()).toBe(state);
        },
        { timeout, interval: 20 },
      );
    }

    beforeAll(async () => {
      errors = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      const url = new URL(redisUrl!);
      inspector = new Queue<SyncJob>("crm-sync", {
        connection: {
          host: url.hostname,
          port: Number(url.port) || 6379,
          ...(url.username ? { username: url.username } : {}),
          ...(url.password ? { password: url.password } : {}),
          maxRetriesPerRequest: null,
        },
      });
      await inspector.waitUntilReady();
      // Avoid consuming any other test/application's pending jobs.
      const counts = await inspector.getJobCounts(
        "wait",
        "active",
        "delayed",
        "paused",
      );
      expect(Object.values(counts).every((count) => count === 0)).toBe(true);
      queue = new CrmSyncQueue(
        { redis: { url: redisUrl }, app: { role: "worker" } } as AppConfig,
        { sync } as unknown as CrmSyncService,
      );
      queue.onModuleInit();
    });

    afterAll(async () => {
      await queue?.onModuleDestroy();
      if (inspector) {
        for (const id of ownIds) await (await inspector.getJob(id))?.remove();
        await inspector.close();
      }
      errors?.mockRestore();
    });

    it("Queue.add aceita o ID, worker aplica o efeito no tenant e repetição em voo não duplica", async () => {
      const payload = job();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observed: Array<{ tenantId: string; payload: LeadSyncPayload }> =
        [];
      sync.mockReset().mockImplementation(async (data) => {
        observed.push({
          tenantId: requireTenantContext().tenantId,
          payload: data,
        });
        await gate;
      });
      const id = await enqueue(payload);
      try {
        await waitForState(id, "active");
        await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
        await enqueue({ ...payload });
        expect(sync).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
      await waitForState(id, "completed");
      const { tenantId, ...expected } = payload;
      expect(observed).toEqual([{ tenantId, payload: expected }]);
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it("payload alterado, outra conversa e outra empresa sincronizam separadamente", async () => {
      const base = job();
      const inputs = [
        base,
        { ...base, score: 95 },
        { ...base, fields: { quartos: 3 } },
        { ...base, status: "handoff", stage: "visit" },
        { ...base, conversationId: `crm-conv-${randomUUID()}` },
        { ...base, tenantId: `crm-test-${randomUUID()}` },
      ];
      const effects: Array<{ tenantId: string; payload: LeadSyncPayload }> = [];
      sync.mockReset().mockImplementation(async (payload) => {
        effects.push({ tenantId: requireTenantContext().tenantId, payload });
      });
      const ids: string[] = [];
      for (const input of inputs) ids.push(await enqueue(input));
      expect(new Set(ids).size).toBe(inputs.length);
      for (const id of ids) await waitForState(id, "completed");
      expect(effects).toHaveLength(inputs.length);
      for (const { tenantId, ...payload } of inputs)
        expect(effects).toContainEqual({ tenantId, payload });
    });

    it("dedup dura enquanto o job é retido; após remoção, o mesmo conteúdo pode executar novamente", async () => {
      const payload = job();
      sync.mockReset().mockResolvedValue(undefined);
      const id = await enqueue(payload);
      await waitForState(id, "completed");
      await enqueue(payload);
      expect(await (await inspector.getJob(id))?.getState()).toBe("completed");
      expect(sync).toHaveBeenCalledTimes(1);
      await (await inspector.getJob(id))!.remove();
      await enqueue(payload);
      await waitForState(id, "completed");
      expect(sync).toHaveBeenCalledTimes(2);
    });

    it("falha é re-tentada e preservada como failed com erro observável", async () => {
      sync.mockReset().mockRejectedValue(new Error("crm-test-unavailable"));
      errors.mockClear();
      const id = await enqueue(job());
      await waitForState(id, "failed", 40000);
      const failed = (await inspector.getJob(id))!;
      expect(failed.attemptsMade).toBe(5);
      expect(failed.failedReason).toBe("crm-test-unavailable");
      expect(sync).toHaveBeenCalledTimes(5);
      await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    }, 45000);
  },
);
