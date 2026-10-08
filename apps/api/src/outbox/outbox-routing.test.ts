import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboxService, type BaileysOutbound } from "./outbox.service";
import type { ChannelFactory } from "../whatsapp/channel-factory.service";

// @sdr/db mockado — controla conexão ativa, conexões do tenant e claim do outbox.
const getActiveConnectionForTenant = vi.fn();
const listConnectionsForTenant = vi.fn().mockResolvedValue([]);
const claimDueOutbox = vi.fn().mockResolvedValue([]);
const markOutboxSent = vi.fn().mockResolvedValue(undefined);
const markOutboxFailed = vi.fn().mockResolvedValue(undefined);
const markOutboxCanceled = vi.fn().mockResolvedValue(undefined);
const recordUsage = vi.fn().mockResolvedValue(undefined);
vi.mock("@sdr/db", () => ({
  getActiveConnectionForTenant: (...a: unknown[]) => getActiveConnectionForTenant(...a),
  listConnectionsForTenant: (...a: unknown[]) => listConnectionsForTenant(...a),
  claimDueOutbox: (...a: unknown[]) => claimDueOutbox(...a),
  enqueueOutbox: vi.fn(),
  markOutboxSent: (...a: unknown[]) => markOutboxSent(...a),
  markOutboxFailed: (...a: unknown[]) => markOutboxFailed(...a),
  markOutboxCanceled: (...a: unknown[]) => markOutboxCanceled(...a),
  recordUsage: (...a: unknown[]) => recordUsage(...a),
  recordOutboundMessage: vi.fn(),
  recordSentOutbox: vi.fn(),
  getConversationContact: vi.fn(),
  getConversationWindow: vi.fn(),
  getLeadProfile: vi.fn(),
  isContactOptedOut: vi.fn(),
  isHumanTakeover: vi.fn().mockResolvedValue(false),
  isWithinServiceWindow: vi.fn().mockReturnValue(true),
}));

const channels = {} as unknown as ChannelFactory;

/** ChannelFactory fake que registra por QUAL phone_number_id o envio saiu. */
function cloudChannels() {
  const sentBy: string[] = [];
  const factory = {
    async tenantSender(phoneNumberId: string) {
      return {
        async sendMessage() {
          sentBy.push(phoneNumberId);
          return { externalMessageId: `ext-${phoneNumberId}`, acceptedAt: new Date().toISOString() };
        },
        async sendTemplate() {
          sentBy.push(phoneNumberId);
          return { externalMessageId: `ext-${phoneNumberId}`, acceptedAt: new Date().toISOString() };
        },
      };
    },
  } as unknown as ChannelFactory;
  return { factory, sentBy };
}

function baileysConn(pnid = "5511999") {
  return { connectionId: "cb-1", phoneNumberId: pnid, secretRef: "whatsapp_token", provider: "baileys" };
}
function cloudConn(pnid = "pnid-A", connectionId = "cc-A") {
  return { connectionId, phoneNumberId: pnid, secretRef: "whatsapp_token", provider: "cloud_api" };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "o1",
    conversationId: null,
    connection: null,
    kind: "free_form",
    payload: { text: "oi proativo" },
    toPhone: "5511888",
    clientMessageId: "c1",
    billing: "service",
    attempts: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  listConnectionsForTenant.mockResolvedValue([]);
  claimDueOutbox.mockResolvedValue([]);
});

describe("OutboxService — partição por provedor no CLAIM (multi-conexão 0030)", () => {
  it("session-worker (com seam) envia Baileys pelo SOCKET do dono (linha sem vínculo → fallback)", async () => {
    const baileys: BaileysOutbound = {
      ownsLiveSocket: vi.fn().mockReturnValue(true),
      sendText: vi.fn().mockResolvedValue({ id: "BLZ-9" }),
    };
    getActiveConnectionForTenant.mockResolvedValue(baileysConn());
    listConnectionsForTenant.mockResolvedValue([baileysConn()]);
    claimDueOutbox.mockResolvedValue([row()]);
    const svc = new OutboxService(channels);
    svc.setBaileysOutbound(baileys);

    const sent = await svc.processDue();
    expect(sent).toBe(1);
    // claim PARTICIONADO: só linhas Baileys dos sockets deste worker + sem vínculo.
    expect(claimDueOutbox).toHaveBeenCalledWith(20, undefined, {
      provider: "baileys",
      phoneNumberIds: ["5511999"],
      includeUnrouted: true,
    });
    // propaga clientMessageId → idempotência (sem dupla entrega no reenvio órfão).
    expect(baileys.sendText).toHaveBeenCalledWith("5511999", "5511888", "oi proativo", "c1");
    expect(markOutboxSent).toHaveBeenCalledWith("o1", "BLZ-9");
  });

  it("scheduler (sem seam) NÃO reivindica linhas de tenant só-Baileys (partição no claim)", async () => {
    getActiveConnectionForTenant.mockResolvedValue(baileysConn());
    const svc = new OutboxService(channels); // sem setBaileysOutbound
    const sent = await svc.processDue();
    expect(sent).toBe(0);
    // O claim roda, mas EXCLUI linhas sem vínculo (fallback Baileys) e só aceita
    // linhas roteadas para conexões Cloud — nada a fazer aqui.
    expect(claimDueOutbox).toHaveBeenCalledWith(20, undefined, {
      provider: "cloud_api",
      includeUnrouted: false,
    });
  });

  it("session-worker NÃO processa tenant só-Cloud (partição inversa, sem claim)", async () => {
    const baileys: BaileysOutbound = { ownsLiveSocket: vi.fn(), sendText: vi.fn() };
    getActiveConnectionForTenant.mockResolvedValue(cloudConn());
    listConnectionsForTenant.mockResolvedValue([]); // nenhum Baileys no tenant
    const svc = new OutboxService(channels);
    svc.setBaileysOutbound(baileys);
    const sent = await svc.processDue();
    expect(sent).toBe(0);
    expect(claimDueOutbox).not.toHaveBeenCalled();
  });

  it("Baileys sem socket vivo (não-dono) → não reivindica nada", async () => {
    const baileys: BaileysOutbound = { ownsLiveSocket: vi.fn().mockReturnValue(false), sendText: vi.fn() };
    getActiveConnectionForTenant.mockResolvedValue(baileysConn());
    listConnectionsForTenant.mockResolvedValue([baileysConn()]);
    const svc = new OutboxService(channels);
    svc.setBaileysOutbound(baileys);
    const sent = await svc.processDue();
    expect(sent).toBe(0);
    expect(claimDueOutbox).not.toHaveBeenCalled();
  });

  it("2 CONEXÕES ATIVAS (Cloud): a linha sai pela conexão DA LINHA, não pelo default do tenant", async () => {
    const { factory, sentBy } = cloudChannels();
    // default do tenant (mais antiga) = pnid-A; a linha foi enfileirada na conversa do pnid-B.
    getActiveConnectionForTenant.mockResolvedValue(cloudConn("pnid-A", "cc-A"));
    claimDueOutbox.mockResolvedValue([
      row({ id: "o-b", connection: { ...cloudConn("pnid-B", "cc-B"), status: "active" } }),
    ]);
    const svc = new OutboxService(factory);

    const sent = await svc.processDue();
    expect(sent).toBe(1);
    expect(sentBy).toEqual(["pnid-B"]); // número CERTO, não o default
    expect(markOutboxSent).toHaveBeenCalledWith("o-b", "ext-pnid-B");
  });

  it("TENANT MISTO (default Cloud + número Baileys): o session-worker processa a partição Baileys (sem starvation)", async () => {
    const baileys: BaileysOutbound = {
      ownsLiveSocket: vi.fn().mockReturnValue(true),
      sendText: vi.fn().mockResolvedValue({ id: "BLZ-7" }),
    };
    getActiveConnectionForTenant.mockResolvedValue(cloudConn("pnid-A", "cc-A")); // default = Cloud
    listConnectionsForTenant.mockResolvedValue([baileysConn("5511999")]);
    claimDueOutbox.mockResolvedValue([
      row({ id: "o-blz", connection: { ...baileysConn("5511999"), status: "active" } }),
    ]);
    const svc = new OutboxService(channels);
    svc.setBaileysOutbound(baileys);

    const sent = await svc.processDue();
    expect(sent).toBe(1);
    // antes da 0030 o pré-check por TENANT (default Cloud) retornava 0 aqui.
    expect(claimDueOutbox).toHaveBeenCalledWith(20, undefined, {
      provider: "baileys",
      phoneNumberIds: ["5511999"],
      includeUnrouted: false, // fallback do tenant é Cloud — não é deste worker
    });
    expect(baileys.sendText).toHaveBeenCalledWith("5511999", "5511888", "oi proativo", "c1");
  });

  it("conexão da linha fora do ar → re-agenda (não envia pelo número errado)", async () => {
    const { factory, sentBy } = cloudChannels();
    getActiveConnectionForTenant.mockResolvedValue(cloudConn("pnid-A", "cc-A"));
    claimDueOutbox.mockResolvedValue([
      row({ id: "o-down", connection: { ...cloudConn("pnid-B", "cc-B"), status: "disconnected" } }),
    ]);
    const svc = new OutboxService(factory);

    const sent = await svc.processDue();
    expect(sent).toBe(0);
    expect(sentBy).toEqual([]); // NÃO caiu no fallback (número errado)
    expect(markOutboxFailed).toHaveBeenCalledWith(
      "o-down",
      expect.stringContaining("indisponível"),
      1,
      5,
      expect.any(Number),
    );
  });
});
