import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedInboundMessage } from "@sdr/core";
import { ChannelSendError } from "@sdr/whatsapp-cloud";
import type { ChannelFactory } from "./channel-factory.service";
import type { InboundCoreService } from "./inbound-core.service";
import { InboundPipelineService } from "./inbound-pipeline.service";
import { ReplyDeliveryError } from "./message-handler";
import type { OutboxService } from "../outbox/outbox.service";
import type { LockHandle } from "../queue/redis-mutex";
import {
  getConversationWindow,
  recordOutboundMessage,
  isHumanTakeover,
  isContactOptedOut,
} from "@sdr/db";

vi.mock("@sdr/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdr/db")>()),
  getConversationWindow: vi.fn(),
  recordOutboundMessage: vi.fn(),
  setConnectionStatus: vi.fn(),
  isHumanTakeover: vi.fn(),
  isContactOptedOut: vi.fn(),
}));

describe("Cloud reactive reply — delivery certainty", () => {
  const msg: NormalizedInboundMessage = {
    provider: "cloud_api",
    channelAccountId: "account-1",
    externalMessageId: "inbound-1",
    conversationKey: "cloud_api:account-1:5511999999999",
    from: "5511999999999",
    to: "account-1",
    receivedAt: "2020-01-01T00:00:00.000Z",
    content: { type: "text", text: "original" },
  };
  const send = vi.fn();
  const senderFactory = vi.fn();
  const ledger = vi.fn();
  const fence = vi.fn();
  let pipeline: InboundPipelineService;
  const text =
    "Primeira mensagem com conteúdo suficiente para ser uma bolha.\n\nSegunda mensagem com conteúdo suficiente para ser outra bolha.";

  function reply(value = text): Promise<void> {
    return pipeline["makeReply"](
      "account-1",
      "whatsapp_token",
      msg,
      "conversation-1",
      {
        isValid: fence,
      } as unknown as LockHandle,
    )(value);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isHumanTakeover).mockReset().mockResolvedValue(false);
    vi.mocked(isContactOptedOut).mockReset().mockResolvedValue(false);
    fence.mockReset().mockResolvedValue(true);
    send.mockReset().mockResolvedValue({
      externalMessageId: "out-1",
      acceptedAt: new Date().toISOString(),
    });
    senderFactory.mockReset().mockResolvedValue({ sendMessage: send });
    ledger.mockReset().mockResolvedValue(undefined);
    vi.mocked(getConversationWindow)
      .mockReset()
      .mockResolvedValue(new Date(Date.now() + 60_000));
    vi.mocked(recordOutboundMessage)
      .mockReset()
      .mockResolvedValue({ messageId: "out-record" });
    pipeline = new InboundPipelineService(
      { tenantSender: senderFactory } as unknown as ChannelFactory,
      {} as InboundCoreService,
      { recordReactiveDelivery: ledger } as unknown as OutboxService,
    );
    pipeline.bubblePause = async () => {};
  });

  it("lost fencing before any send is not_sent", async () => {
    fence.mockResolvedValue(false);
    await expect(reply()).rejects.toMatchObject({ delivery: "not_sent" });
    expect(send).not.toHaveBeenCalled();
  });

  it("stored account mismatch refuses before any send", async () => {
    await expect(
      pipeline["makeReply"](
        "other-account",
        "whatsapp_token",
        msg,
        "conversation-1",
        {
          isValid: fence,
        } as unknown as LockHandle,
      )("test"),
    ).rejects.toMatchObject({ delivery: "not_sent" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([null, new Date(0)])(
    "missing/expired current service window refuses before sending",
    async (window) => {
      vi.mocked(getConversationWindow).mockResolvedValue(window);
      await expect(reply()).rejects.toBeInstanceOf(ReplyDeliveryError);
      await expect(reply()).rejects.toMatchObject({ delivery: "not_sent" });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("uses current persisted window even when original inbound timestamp is old", async () => {
    await reply("Uma resposta com a janela atual aberta.");
    expect(send).toHaveBeenCalledTimes(1);
    expect(getConversationWindow).toHaveBeenCalledWith("conversation-1");
  });

  it("requests a single adapter attempt; unknown network failure is uncertain", async () => {
    send.mockRejectedValue(new Error("unknown network timeout"));
    await expect(reply()).rejects.toMatchObject({ delivery: "uncertain" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(senderFactory).toHaveBeenCalledWith("account-1", "whatsapp_token", {
      retry: { maxAttempts: 1, baseDelayMs: 0 },
    });
  });

  it.each([400, 401, 429])(
    "definite HTTP %i rejection of first bubble is not_sent",
    async (status) => {
      send.mockRejectedValue(
        new ChannelSendError("rejected", status === 429, status),
      );
      await expect(reply()).rejects.toMatchObject({ delivery: "not_sent" });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("HTTP 5xx may have accepted delivery and remains uncertain", async () => {
    send.mockRejectedValue(new ChannelSendError("server error", true, 503));
    await expect(reply()).rejects.toMatchObject({ delivery: "uncertain" });
  });

  it("HTTP 408 server timeout remains uncertain despite being a 4xx response", async () => {
    send.mockRejectedValue(new ChannelSendError("request timeout", true, 408));
    await expect(reply()).rejects.toMatchObject({ delivery: "uncertain" });
  });

  it("HTTP 4xx after one accepted bubble is uncertain, preventing replay of the first", async () => {
    send
      .mockResolvedValueOnce({ externalMessageId: "first" })
      .mockRejectedValueOnce(
        new ChannelSendError("rejected second", false, 400),
      );
    await expect(reply()).rejects.toMatchObject({ delivery: "uncertain" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(recordOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it("fencing loss after first accepted bubble remains uncertain", async () => {
    fence.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(reply()).rejects.toMatchObject({ delivery: "uncertain" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("revalidates service window before every bubble; closure after acceptance is uncertain", async () => {
    vi.mocked(getConversationWindow)
      .mockResolvedValueOnce(new Date(Date.now() + 60_000))
      .mockResolvedValueOnce(new Date(0));
    await expect(reply()).rejects.toMatchObject({ delivery: "uncertain" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("post-acceptance message persistence failure remains uncertain", async () => {
    vi.mocked(recordOutboundMessage).mockRejectedValue(
      new Error("database unavailable"),
    );
    await expect(reply()).rejects.toMatchObject({ delivery: "uncertain" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("post-acceptance delivery-ledger failure remains uncertain", async () => {
    ledger.mockRejectedValue(new Error("database unavailable"));
    await expect(reply()).rejects.toMatchObject({ delivery: "uncertain" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["human", "optout"])(
    "new %s block between bubbles stops delivery as uncertain",
    async (kind) => {
      const guard =
        kind === "human"
          ? vi.mocked(isHumanTakeover)
          : vi.mocked(isContactOptedOut);
      guard.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await expect(reply()).rejects.toMatchObject({ delivery: "uncertain" });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("explicit persisted opt-out acknowledgment may bypass the policy guards", async () => {
    vi.mocked(isHumanTakeover).mockResolvedValue(true);
    vi.mocked(isContactOptedOut).mockResolvedValue(true);
    await pipeline["makeReply"](
      "account-1",
      "whatsapp_token",
      msg,
      "conversation-1",
      { isValid: fence } as unknown as LockHandle,
    )("Tudo certo, não enviaremos novas mensagens.", {
      allowOptOutReply: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "cloud_api" }),
      { strict: true },
    );
  });
});
