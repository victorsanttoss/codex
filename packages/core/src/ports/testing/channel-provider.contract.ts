import { describe, expect, it } from "vitest";
import type { ChannelProvider, InboundWebhookRequest } from "../channel-provider";

/**
 * Suíte de contrato REUTILIZÁVEL para `ChannelProvider`. Qualquer adaptador
 * (Meta Cloud, não-oficial, ...) deve passar nela.
 *
 * Adaptadores reais VALIDAM assinatura no webhook, então um payload genérico
 * seria rejeitado. Por isso a suíte é parametrizada: o adaptador fornece um
 * `validWebhook()` (payload ASSINADO válido) e quantas mensagens/eventos ele
 * deve render. Sem opts, usa o formato do fake (sem assinatura).
 *
 * Uso:
 *   runChannelProviderContract("meta", () => new MetaAdapter(cfg), {
 *     validWebhook: () => signedInboundFixture(),
 *     expectedInboundCount: 1,
 *     validStatusWebhook: () => signedStatusFixture(),
 *   })
 */
export interface ChannelContractOptions {
  validWebhook?: () => InboundWebhookRequest;
  expectedInboundCount?: number;
  validStatusWebhook?: () => InboundWebhookRequest;
  expectedStatusCount?: number;
}

const DEFAULT_INBOUND: InboundWebhookRequest = {
  headers: {},
  query: {},
  rawBody: JSON.stringify({ messages: [{ id: "abc", from: "+551", to: "+552", text: "olá" }] }),
};
const DEFAULT_STATUS: InboundWebhookRequest = {
  headers: {},
  query: {},
  rawBody: JSON.stringify({ statuses: [{ id: "abc", status: "delivered", to: "+551" }] }),
};

export function runChannelProviderContract(
  name: string,
  makeProvider: () => ChannelProvider,
  opts: ChannelContractOptions = {},
): void {
  const inbound = opts.validWebhook ?? (() => DEFAULT_INBOUND);
  const minInbound = opts.expectedInboundCount ?? 1;
  const statusReq = opts.validStatusWebhook ?? (() => DEFAULT_STATUS);
  const minStatus = opts.expectedStatusCount ?? 1;

  describe(`ChannelProvider contract :: ${name}`, () => {
    it("envia texto e devolve um externalMessageId não-vazio", async () => {
      const res = await makeProvider().sendMessage({ to: "+550000", text: "oi" });
      expect(res.externalMessageId).toBeTruthy();
      expect(typeof res.acceptedAt).toBe("string");
    });

    it("envia template e devolve um externalMessageId não-vazio", async () => {
      const res = await makeProvider().sendTemplate({
        to: "+550000",
        templateName: "welcome",
        languageCode: "pt_BR",
      });
      expect(res.externalMessageId).toBeTruthy();
    });

    it("normaliza um webhook VÁLIDO preenchendo os campos agnósticos", () => {
      const messages = makeProvider().normalizeInboundWebhook(inbound());
      expect(messages.length).toBeGreaterThanOrEqual(minInbound);
      for (const m of messages) {
        expect(m.externalMessageId).toBeTruthy();
        expect(m.conversationKey).toBeTruthy();
        expect(m.provider).toBeTruthy();
        expect(m.from).toBeTruthy();
        expect(m.content.type).toBeDefined();
      }
    });

    it("normalizeInboundWebhook é puro/tolerante a corpo inválido", () => {
      const p = makeProvider();
      expect(p.normalizeInboundWebhook({ headers: {}, query: {}, rawBody: "" })).toEqual([]);
      expect(p.normalizeInboundWebhook({ headers: {}, query: {}, rawBody: "nao-e-json{" })).toEqual([]);
    });

    it("normaliza eventos de status de um webhook válido", () => {
      const events = makeProvider().normalizeStatusEvents(statusReq());
      expect(events.length).toBeGreaterThanOrEqual(minStatus);
      for (const e of events) {
        expect(e.externalMessageId).toBeTruthy();
        expect(["sent", "delivered", "read", "failed"]).toContain(e.status);
      }
    });

    it("normalizeStatusEvents é tolerante a corpo inválido", () => {
      const p = makeProvider();
      expect(p.normalizeStatusEvents({ headers: {}, query: {}, rawBody: "" })).toEqual([]);
    });

    it("expõe ciclo de vida connect/disconnect/status coerente", async () => {
      const p = makeProvider();
      await p.connect();
      expect((await p.status()).state).toBe("connected");
      await p.disconnect();
      expect((await p.status()).state).toBe("disconnected");
    });
  });
}
