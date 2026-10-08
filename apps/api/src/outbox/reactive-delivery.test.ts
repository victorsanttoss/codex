import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordSentOutbox, recordUsage } from "@sdr/db";
import { OutboxService } from "./outbox.service";
import type { ChannelFactory } from "../whatsapp/channel-factory.service";

vi.mock("@sdr/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdr/db")>()),
  recordSentOutbox: vi.fn(),
  recordUsage: vi.fn(),
}));

describe("reactive delivery ledger certainty", () => {
  const payload = {
    conversationId: "conversation-1",
    toPhone: "5511999999999",
    text: "synthetic",
    externalMessageId: "out-1",
    provider: "cloud_api",
  };
  const service = new OutboxService({} as ChannelFactory);

  beforeEach(() => {
    vi.mocked(recordSentOutbox).mockReset();
    vi.mocked(recordUsage).mockReset().mockResolvedValue(undefined);
  });

  it("strict durable reply propagates ledger persistence failure after accepted delivery", async () => {
    vi.mocked(recordSentOutbox).mockRejectedValue(
      new Error("ledger persistence failed"),
    );
    await expect(
      service.recordReactiveDelivery(payload, { strict: true }),
    ).rejects.toThrow("ledger persistence failed");
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("other callers retain best-effort ledger behavior", async () => {
    vi.mocked(recordSentOutbox).mockRejectedValue(
      new Error("ledger persistence failed"),
    );
    await expect(
      service.recordReactiveDelivery(payload),
    ).resolves.toBeUndefined();
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it("metering remains explicitly best-effort even for a strict reply", async () => {
    vi.mocked(recordUsage).mockRejectedValue(new Error("meter unavailable"));
    await expect(
      service.recordReactiveDelivery(payload, { strict: true }),
    ).resolves.toBeUndefined();
  });
});
