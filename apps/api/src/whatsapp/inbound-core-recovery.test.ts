import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireTenantContext, type NormalizedInboundMessage } from "@sdr/core";
import {
  getAgentTurn,
  type AgentTurnRow,
  type ResolvedConnection,
} from "@sdr/db";
import { InboundCoreService, type ReplyFactory } from "./inbound-core.service";
import type { InboundMessageContext } from "./message-handler";
import type { SerializedRunner } from "../queue/serialized-runner";
import type { LockHandle } from "../queue/redis-mutex";
import type { MediaService } from "./media.service";
import type { AudioEnrichmentService } from "../transcription/audio-enrichment.service";

vi.mock("@sdr/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdr/db")>()),
  getAgentTurn: vi.fn(),
}));

describe("stored agent turn transport recovery", () => {
  const conn: ResolvedConnection = {
    tenantId: "tenant-1",
    connectionId: "connection-uuid",
    secretRef: "whatsapp_token",
  };
  const turn: AgentTurnRow = {
    id: "turn-1",
    conversationId: "conversation-1",
    externalMessageId: "old-inbound",
    conversationKey: "baileys:account-1:lid-number",
    status: "ready",
    replyStatus: "pending",
    completedEffects: [],
    leaseToken: null,
    leaseExpiresAt: null,
    attempts: 1,
    lastError: null,
    plan: {
      replyText: "stored response",
      decision: null,
      outcome: null,
      source: {
        from: "lid-number",
        type: "text",
        provider: "baileys",
        channelAccountId: "account-1",
        senderAddress: "lid-number@lid",
        receivedAt: "2026-01-01T12:00:00.000Z",
      },
    },
  };
  const handle = {
    isValid: vi.fn().mockResolvedValue(true),
  } as unknown as LockHandle;
  const handler = {
    handle: vi.fn<(ctx: InboundMessageContext) => Promise<void>>(),
    resume: vi.fn<(ctx: InboundMessageContext) => Promise<void>>(),
  };
  const reply = vi.fn();
  const factory = vi.fn<ReplyFactory>();
  const runner = {
    run: vi.fn(
      async (_key: string, fn: (handle: LockHandle) => Promise<void>) =>
        fn(handle),
    ),
  };
  let core: InboundCoreService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAgentTurn).mockReset().mockResolvedValue(turn);
    handler.resume.mockReset().mockResolvedValue(undefined);
    factory.mockReset().mockReturnValue(reply);
    reply.mockReset().mockResolvedValue(undefined);
    core = new InboundCoreService(
      {} as MediaService,
      {} as AudioEnrichmentService,
      runner as unknown as SerializedRunner,
      handler,
    );
  });

  it("re-reads the plan inside tenant/FIFO, preserves LID/address metadata and exposes fencing", async () => {
    let observed: InboundMessageContext | undefined;
    handler.resume.mockImplementation(async (ctx) => {
      expect(requireTenantContext().tenantId).toBe(conn.tenantId);
      observed = ctx;
      await ctx.reply("stored response");
    });
    await core.resumeStoredTurn(turn, conn, factory);
    expect(runner.run).toHaveBeenCalledWith(
      turn.conversationKey,
      expect.any(Function),
      undefined,
    );
    expect(observed).toMatchObject({
      from: "lid-number",
      senderAddress: "lid-number@lid",
      provider: "baileys",
      channelAccountId: "account-1",
    });
    expect(observed?.message.text).toBeUndefined();
    expect(await observed?.isValid?.()).toBe(true);
    const envelope = factory.mock.calls[0]![0];
    expect(envelope.receivedAt).toBe(turn.plan!.source!.receivedAt);
    expect(envelope.senderAddress).toBe("lid-number@lid");
    expect(reply).toHaveBeenCalledWith("stored response");
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...turn, status: "complete" as const },
    { ...turn, plan: null },
  ])(
    "missing, cross-tenant or finished plan cannot become a fresh generation",
    async (current) => {
      vi.mocked(getAgentTurn).mockResolvedValue(current);
      await core.resumeStoredTurn(turn, conn, factory);
      expect(handler.resume).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("rejects persisted destination/provider mismatch before invoking handler", async () => {
    vi.mocked(getAgentTurn).mockResolvedValue({
      ...turn,
      plan: {
        ...turn.plan!,
        source: { ...turn.plan!.source!, channelAccountId: "other-account" },
      },
    });
    await expect(
      core.resumeStoredTurn(turn, conn, factory),
    ).rejects.toMatchObject({ delivery: "not_sent" });
    expect(handler.resume).not.toHaveBeenCalled();
  });

  it("replyForTurn reconstructs the earlier stored metadata instead of using the new inbound", async () => {
    const earlier = {
      ...turn,
      externalMessageId: "earlier-inbound",
      plan: {
        ...turn.plan!,
        source: {
          ...turn.plan!.source!,
          receivedAt: "2025-12-01T12:00:00.000Z",
        },
      },
    };
    vi.mocked(getAgentTurn)
      .mockResolvedValueOnce(turn)
      .mockResolvedValueOnce(earlier);
    handler.resume.mockImplementation(async (ctx) => {
      await ctx.replyForTurn!(earlier.externalMessageId, "earlier response");
    });
    await core.resumeStoredTurn(turn, conn, factory);
    const envelope: NormalizedInboundMessage = factory.mock.calls.at(-1)![0];
    expect(envelope.externalMessageId).toBe(earlier.externalMessageId);
    expect(envelope.receivedAt).toBe(earlier.plan.source!.receivedAt);
    expect(reply).toHaveBeenCalledWith("earlier response");
  });
});
