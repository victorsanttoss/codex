import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireTenantContext } from "@sdr/core";
import type { AppConfig } from "@sdr/config";
import {
  getConnectionForConversation,
  listPendingAgentTurns,
  listTenantIdsWithPendingAgentTurns,
  type AgentTurnRow,
  type RoutedConnection,
} from "@sdr/db";
import { AgentTurnRecoveryService } from "./agent-turn-recovery.service";
import type { InboundPipelineService } from "./inbound-pipeline.service";

vi.mock("@sdr/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdr/db")>()),
  getConnectionForConversation: vi.fn(),
  listPendingAgentTurns: vi.fn(),
  listTenantIdsWithPendingAgentTurns: vi.fn(),
}));

function turn(
  id: string,
  provider = "cloud_api",
  account = "account-1",
): AgentTurnRow {
  return {
    id,
    conversationId: `conversation-${id}`,
    externalMessageId: `inbound-${id}`,
    conversationKey: `${provider}:${account}:5511999999999`,
    status: "ready",
    replyStatus: "pending",
    completedEffects: [],
    leaseToken: null,
    leaseExpiresAt: null,
    attempts: 1,
    lastError: null,
    plan: {
      replyText: "persisted",
      decision: null,
      outcome: null,
      source: { from: "5511999999999", type: "text" },
    },
  };
}
const connection: RoutedConnection = {
  provider: "cloud_api",
  phoneNumberId: "account-1",
  connectionId: "connection-uuid",
  secretRef: "whatsapp_token",
  status: "active",
  wabaId: null,
};

describe("cloud agent turn recovery scheduler", () => {
  const recoverTurn = vi.fn();
  let service: AgentTurnRecoveryService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTenantIdsWithPendingAgentTurns)
      .mockReset()
      .mockResolvedValue(["tenant-1"]);
    vi.mocked(listPendingAgentTurns)
      .mockReset()
      .mockResolvedValue([turn("ready")]);
    vi.mocked(getConnectionForConversation)
      .mockReset()
      .mockResolvedValue(connection);
    recoverTurn.mockReset().mockResolvedValue(undefined);
    service = new AgentTurnRecoveryService(
      { app: { role: "scheduler" } } as AppConfig,
      { recoverTurn } as unknown as InboundPipelineService,
    );
  });

  it("runs each plan in its own tenant and routes through its active Cloud connection", async () => {
    vi.mocked(listTenantIdsWithPendingAgentTurns).mockResolvedValue([
      "tenant-1",
      "tenant-2",
    ]);
    const tenants: string[] = [];
    recoverTurn.mockImplementation(async () => {
      tenants.push(requireTenantContext().tenantId);
    });
    expect(await service.sweep()).toEqual({
      attempted: 2,
      failed: 0,
      skipped: 0,
    });
    expect(tenants).toEqual(["tenant-1", "tenant-2"]);
    expect(listPendingAgentTurns).toHaveBeenCalledWith(50, {
      provider: "cloud_api",
    });
    expect(recoverTurn).toHaveBeenCalledWith(
      turn("ready"),
      {
        tenantId: "tenant-1",
        connectionId: "connection-uuid",
        secretRef: "whatsapp_token",
      },
      "account-1",
    );
  });

  it("skips Baileys, missing/inactive connections and mismatched accounts", async () => {
    vi.mocked(listPendingAgentTurns).mockResolvedValue([
      turn("baileys", "baileys"),
      turn("missing"),
      turn("disconnected"),
      turn("wrong", "cloud_api", "other-account"),
    ]);
    vi.mocked(getConnectionForConversation)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...connection, status: "disconnected" })
      .mockResolvedValueOnce(connection);
    expect(await service.sweep()).toEqual({
      attempted: 0,
      failed: 0,
      skipped: 3,
    });
    expect(recoverTurn).not.toHaveBeenCalled();
  });

  it("isolates a failed turn and continues recovering the next", async () => {
    vi.mocked(listPendingAgentTurns).mockResolvedValue([
      turn("first"),
      turn("second"),
    ]);
    recoverTurn
      .mockRejectedValueOnce(new Error("recovery unavailable"))
      .mockResolvedValueOnce(undefined);
    expect(await service.sweep()).toEqual({
      attempted: 2,
      failed: 1,
      skipped: 0,
    });
    expect(recoverTurn).toHaveBeenCalledTimes(2);
  });

  it("overlapping ticks do not start a second sweep", async () => {
    let release!: () => void;
    const gate = new Promise<string[]>((resolve) => {
      release = () => resolve([]);
    });
    vi.mocked(listTenantIdsWithPendingAgentTurns).mockReturnValue(gate);
    const pending = service.sweep();
    try {
      expect(await service.sweep()).toEqual({
        attempted: 0,
        failed: 0,
        skipped: 0,
      });
      expect(listTenantIdsWithPendingAgentTurns).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await pending;
    }
  });

  it("starts recovery only on scheduler roles", async () => {
    const api = new AgentTurnRecoveryService(
      { app: { role: "api" } } as AppConfig,
      { recoverTurn } as unknown as InboundPipelineService,
    );
    const apiSweep = vi.spyOn(api, "sweep");
    api.onModuleInit();
    expect(apiSweep).not.toHaveBeenCalled();
    api.onModuleDestroy();
    const schedulerSweep = vi
      .spyOn(service, "sweep")
      .mockResolvedValue({ attempted: 0, failed: 0, skipped: 0 });
    service.onModuleInit();
    expect(schedulerSweep).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });
});
