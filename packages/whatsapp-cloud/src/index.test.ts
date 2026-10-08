import { describe, expect, it } from "vitest";
import type { InboundWebhookRequest } from "@sdr/core";
// Utilitário de teste compartilhado (vive em core/testing, fora do build):
import { runChannelProviderContract } from "../../core/src/ports/testing/channel-provider.contract";
import { CloudApiChannelProvider } from "./cloud-api-adapter";
import { ChannelSendError } from "./errors";
import { signMetaBody } from "./signature";
import type { HttpClient } from "./http";

const APP_SECRET = "test-app-secret";
const PN = "PNID123";
const noSleep = async () => {};

function signed(payload: unknown): InboundWebhookRequest {
  const rawBody = JSON.stringify(payload);
  return {
    headers: { "x-hub-signature-256": signMetaBody(rawBody, APP_SECRET) },
    query: {},
    rawBody,
  };
}

function inboundPayload(message: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+5511", phone_number_id: PN },
              contacts: [{ profile: { name: "Fulano" }, wa_id: "5511999" }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload() {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: PN },
              statuses: [
                { id: "wamid.OUT1", status: "delivered", timestamp: "1700000001", recipient_id: "5511999" },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Mock HTTP com fila de respostas; conta chamadas. */
function mockHttp(responses: Array<{ status: number; body: unknown }>): HttpClient & { calls: number } {
  let i = 0;
  const m = {
    calls: 0,
    async post() {
      m.calls++;
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return { status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    },
  };
  return m;
}

const OK_SEND = { status: 200, body: { messages: [{ id: "wamid.SENT" }] } };

function makeProvider(http: HttpClient = mockHttp([OK_SEND])) {
  return new CloudApiChannelProvider({
    appSecret: APP_SECRET,
    phoneNumberId: PN,
    accessToken: "tenant-token",
    http,
    sleep: noSleep,
    jitter: () => 0,
  });
}

// 1) Contrato reutilizável, com webhook ASSINADO válido.
runChannelProviderContract("cloud_api", () => makeProvider(), {
  validWebhook: () =>
    signed(inboundPayload({ from: "5511999", id: "wamid.IN1", timestamp: "1700000000", type: "text", text: { body: "olá" } })),
  validStatusWebhook: () => signed(statusPayload()),
});

// 2) Testes específicos do adaptador.
describe("CloudApiChannelProvider", () => {
  it("rejeita webhook com assinatura inválida (retorna vazio)", () => {
    const p = makeProvider();
    const rawBody = JSON.stringify(inboundPayload({ from: "5511", id: "x", type: "text", text: { body: "oi" } }));
    const bad: InboundWebhookRequest = {
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      query: {},
      rawBody,
    };
    expect(p.normalizeInboundWebhook(bad)).toEqual([]);
  });

  it("preenche channelAccountId, conversationKey e senderName", () => {
    const p = makeProvider();
    const [msg] = p.normalizeInboundWebhook(
      signed(inboundPayload({ from: "5511999", id: "wamid.IN1", timestamp: "1700000000", type: "text", text: { body: "olá" } })),
    );
    expect(msg!.channelAccountId).toBe(PN);
    expect(msg!.conversationKey).toBe(`cloud_api:${PN}:5511999`);
    expect(msg!.senderName).toBe("Fulano");
    expect(msg!.content).toEqual({ type: "text", text: "olá" });
  });

  it("normaliza mídia (image) com mediaId", () => {
    const p = makeProvider();
    const [msg] = p.normalizeInboundWebhook(
      signed(inboundPayload({ from: "5511999", id: "wamid.M", type: "image", image: { id: "MID1", mime_type: "image/jpeg", caption: "foto" } })),
    );
    expect(msg!.content).toMatchObject({ type: "media", mediaType: "image", mediaId: "MID1", caption: "foto" });
  });

  it("normaliza webhook em BATCH (múltiplos entries/changes)", () => {
    const body = JSON.stringify({
      entry: [
        { changes: [{ value: { metadata: { phone_number_id: PN }, messages: [{ from: "111", id: "a", type: "text", text: { body: "1" } }] } }] },
        { changes: [{ value: { metadata: { phone_number_id: PN }, messages: [{ from: "222", id: "b", type: "text", text: { body: "2" } }] } }] },
      ],
    });
    const req: InboundWebhookRequest = {
      headers: { "x-hub-signature-256": signMetaBody(body, APP_SECRET) },
      query: {},
      rawBody: body,
    };
    const msgs = makeProvider().normalizeInboundWebhook(req);
    expect(msgs.map((m) => m.externalMessageId).sort()).toEqual(["a", "b"]);
  });

  it("normaliza eventos de status", () => {
    const events = makeProvider().normalizeStatusEvents(signed(statusPayload()));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ externalMessageId: "wamid.OUT1", status: "delivered" });
  });

  it("sendMessage devolve o id da Meta", async () => {
    const res = await makeProvider().sendMessage({ to: "5511999", text: "oi" });
    expect(res.externalMessageId).toBe("wamid.SENT");
  });

  it("faz RETRY em erro transiente (503) e sucede", async () => {
    const http = mockHttp([{ status: 503, body: {} }, OK_SEND]);
    const res = await makeProvider(http).sendMessage({ to: "5511", text: "oi" });
    expect(res.externalMessageId).toBe("wamid.SENT");
    expect(http.calls).toBe(2);
  });

  it("mapeia erro OAuth 190 (code numérico) com providerCode string '190'", async () => {
    const http = mockHttp([{ status: 400, body: { error: { code: 190, message: "token inválido" } } }]);
    await expect(makeProvider(http).sendMessage({ to: "5511", text: "oi" })).rejects.toMatchObject({
      name: "ChannelSendError",
      transient: false,
      providerCode: "190",
    });
  });

  it("erro permanente (400) vira ChannelSendError não-transiente, sem retry", async () => {
    const http = mockHttp([{ status: 400, body: { error: { code: 131, message: "bad" } } }]);
    await expect(makeProvider(http).sendMessage({ to: "5511", text: "oi" })).rejects.toMatchObject({
      name: "ChannelSendError",
      transient: false,
    });
    expect(http.calls).toBe(1);
    expect(ChannelSendError).toBeDefined();
  });
});
