import { describe, expect, it } from "vitest";
import type { InboundWebhookRequest } from "@sdr/core";
import { runChannelProviderContract } from "../../core/src/ports/testing/channel-provider.contract";
import { BaileysChannelProvider } from "./baileys-adapter";
import { FakeBaileysConnection } from "./driver";
import { buildInboundEnvelope, buildStatusEnvelope, jidToPhone, phoneToJid } from "./envelope";

const clock = () => new Date(0);

function make(connection = new FakeBaileysConnection()) {
  return new BaileysChannelProvider({ accountId: "5511000000000", connection, clock });
}

function inboundWebhook(): InboundWebhookRequest {
  return {
    headers: {},
    query: {},
    rawBody: buildInboundEnvelope("5511000000000", [
      { id: "BLZ-IN-1", from: "5511999999999@s.whatsapp.net", pushName: "Fulano", text: "olá" },
    ]),
  };
}
function statusWebhook(): InboundWebhookRequest {
  return {
    headers: {},
    query: {},
    rawBody: buildStatusEnvelope("5511000000000", [
      { id: "BLZ-OUT-1", status: "delivered", to: "5511999999999@s.whatsapp.net" },
    ]),
  };
}

// 1) Contrato reutilizável — mesma suíte do Cloud, com envelopes do Baileys.
runChannelProviderContract("baileys", () => make(), {
  validWebhook: inboundWebhook,
  validStatusWebhook: statusWebhook,
});

describe("jid helpers", () => {
  it("jid <-> phone", () => {
    expect(jidToPhone("5511999999999@s.whatsapp.net")).toBe("5511999999999");
    expect(jidToPhone("5511999999999:12@s.whatsapp.net")).toBe("5511999999999");
    expect(phoneToJid("+55 11 99999-9999")).toBe("5511999999999@s.whatsapp.net");
  });
});

describe("BaileysChannelProvider", () => {
  it("envia texto pelo socket e devolve o id", async () => {
    const conn = new FakeBaileysConnection();
    const res = await make(conn).sendMessage({ to: "5511999999999", text: "oi" });
    expect(res.externalMessageId).toBe("BLZ-1");
    expect(conn.sent).toEqual([{ toJid: "5511999999999@s.whatsapp.net", text: "oi" }]);
  });

  it("clientMessageId vira o messageId do WhatsApp (envio idempotente)", async () => {
    const conn = new FakeBaileysConnection();
    const res = await make(conn).sendMessage({ to: "5511999999999", text: "oi", clientMessageId: "cmid-1" });
    expect(res.externalMessageId).toBe("cmid-1"); // dedup por id
    expect(conn.sent[0]).toMatchObject({ text: "oi", messageId: "cmid-1" });
  });

  it("sendTemplate (sem HSM) vira TEXTO normal", async () => {
    const conn = new FakeBaileysConnection();
    await make(conn).sendTemplate({ to: "5511999999999", templateName: "lembrete", languageCode: "pt_BR", variables: { "1": "amanhã" } });
    expect(conn.sent[0]!.text).toBe("lembrete: amanhã");
  });

  it("sem socket (worker não-dono) → erro permanente de envio", async () => {
    const p = new BaileysChannelProvider({ accountId: "5511000000000", clock });
    await expect(p.sendMessage({ to: "5511999999999", text: "x" })).rejects.toMatchObject({
      name: "BaileysSendError",
      transient: false,
    });
  });

  it("queda de socket no envio → erro transiente", async () => {
    const conn = new FakeBaileysConnection();
    await conn.close();
    await expect(make(conn).sendMessage({ to: "5511999999999", text: "x" })).rejects.toMatchObject({
      name: "BaileysSendError",
      transient: true,
    });
  });

  it("normaliza inbound do envelope (skip fromMe, monta conversationKey)", () => {
    const msgs = make().normalizeInboundWebhook({
      headers: {},
      query: {},
      rawBody: buildInboundEnvelope("5511000000000", [
        { id: "A", from: "5511999999999@s.whatsapp.net", text: "oi", pushName: "Fulano" },
        { id: "B", from: "5511000000000@s.whatsapp.net", fromMe: true, text: "eco" },
        { id: "C", from: "5511888888888@s.whatsapp.net", media: { type: "audio", id: "MID" } },
      ]),
    });
    expect(msgs).toHaveLength(2); // o fromMe é descartado
    expect(msgs[0]).toMatchObject({
      provider: "baileys",
      externalMessageId: "A",
      conversationKey: "baileys:5511000000000:5511999999999",
      from: "5511999999999",
      to: "5511000000000",
      channelAccountId: "5511000000000",
      senderName: "Fulano",
      content: { type: "text", text: "oi" },
    });
    expect(msgs[1]!.content).toEqual({ type: "media", mediaType: "audio", mediaId: "MID" });
  });

  it("normalizeInboundWebhook tolera corpo inválido", () => {
    const p = make();
    expect(p.normalizeInboundWebhook({ headers: {}, query: {}, rawBody: "" })).toEqual([]);
    expect(p.normalizeInboundWebhook({ headers: {}, query: {}, rawBody: "naoé{json" })).toEqual([]);
  });

  it("normaliza status (receipt) do envelope", () => {
    const evs = make().normalizeStatusEvents(statusWebhook());
    expect(evs[0]).toMatchObject({ provider: "baileys", externalMessageId: "BLZ-OUT-1", status: "delivered", recipientId: "5511999999999" });
  });
});
