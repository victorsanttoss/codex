import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@sdr/config";
import { getContext, type NormalizedInboundMessage } from "@sdr/core";
import type { AgentTurnRow } from "@sdr/db";
import { FakeBaileysDriver } from "@sdr/whatsapp-baileys";
import { backoffMs, BaileysSessionManager } from "./baileys-session.manager";
import { baileysRegistryProvider } from "./baileys.registry";
import { ownsNumber } from "./ownership";
import { ReplyDeliveryError } from "../whatsapp/message-handler";
import type { ReplyFactory } from "../whatsapp/inbound-core.service";

// @sdr/db mockado — sem banco. Cada função vira um spy controlável.
const listActiveConnectionsByProvider = vi.fn();
const setConnectionStatus = vi.fn();
const recordOutboundMessage = vi.fn();
const recordUsage = vi.fn();
const markMessageStatusByExternalId = vi.fn();
const reconcileOutboxStatus = vi.fn();
const listPendingAgentTurns = vi.fn().mockResolvedValue([]);
const getConnectionForConversation = vi.fn().mockResolvedValue(null);
const isHumanTakeover = vi.fn().mockResolvedValue(false);
const isContactOptedOut = vi.fn().mockResolvedValue(false);
vi.mock("@sdr/db", () => ({
  listActiveConnectionsByProvider: (...a: unknown[]) =>
    listActiveConnectionsByProvider(...a),
  setConnectionStatus: (...a: unknown[]) => setConnectionStatus(...a),
  recordOutboundMessage: (...a: unknown[]) => recordOutboundMessage(...a),
  recordUsage: (...a: unknown[]) => recordUsage(...a),
  markMessageStatusByExternalId: (...a: unknown[]) =>
    markMessageStatusByExternalId(...a),
  reconcileOutboxStatus: (...a: unknown[]) => reconcileOutboxStatus(...a),
  listPendingAgentTurns: (...a: unknown[]) => listPendingAgentTurns(...a),
  getConnectionForConversation: (...a: unknown[]) =>
    getConnectionForConversation(...a),
  isHumanTakeover: (...a: unknown[]) => isHumanTakeover(...a),
  isContactOptedOut: (...a: unknown[]) => isContactOptedOut(...a),
}));

const PN = "5511999999999";

function cfg(over: Partial<AppConfig["baileys"]> = {}): AppConfig {
  return {
    app: { role: "session-worker" },
    baileys: {
      enabled: true,
      workerIndex: 0,
      workerTotal: 1,
      reconnectBaseMs: 1000,
      reconnectMaxMs: 60000,
      qrTtlSeconds: 90,
      ...over,
    },
  } as unknown as AppConfig;
}

function build(
  over: Partial<AppConfig["baileys"]> = {},
  driverOverride?: FakeBaileysDriver,
) {
  const driver = driverOverride ?? new FakeBaileysDriver();
  const registry = baileysRegistryProvider.useFactory();
  const store = {
    get: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const qr = { publish: vi.fn().mockResolvedValue(undefined), read: vi.fn() };
  const notifier = { notify: vi.fn().mockResolvedValue(undefined) };
  const core = { handle: vi.fn().mockResolvedValue(undefined) };
  const outbox = {
    recordReactiveDelivery: vi.fn().mockResolvedValue(undefined),
  };
  const mgr = new BaileysSessionManager(
    cfg(over),
    driver,
    registry,
    store as never,
    qr as never,
    notifier as never,
    core as never,
    outbox as never,
  );
  let t = 1_000_000;
  mgr.nowFn = () => t;
  return {
    mgr,
    driver,
    store,
    qr,
    notifier,
    core,
    outbox,
    setTime: (n: number) => (t = n),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  isHumanTakeover.mockReset().mockResolvedValue(false);
  isContactOptedOut.mockReset().mockResolvedValue(false);
});

describe("ownership sticky", () => {
  it("pool de 1 detém tudo; partição determinística com total>1", () => {
    expect(ownsNumber(PN, 0, 1)).toBe(true);
    const owners = new Set(
      [0, 1, 2]
        .map((i) => (ownsNumber(PN, i, 3) ? i : -1))
        .filter((x) => x >= 0),
    );
    expect(owners.size).toBe(1); // exatamente um worker é dono
  });
  it("backoff exponencial com teto", () => {
    expect(backoffMs(1, 1000, 60000)).toBe(2000);
    expect(backoffMs(3, 1000, 60000)).toBe(8000);
    expect(backoffMs(20, 1000, 60000)).toBe(60000); // teto
  });
});

describe("BaileysSessionManager", () => {
  it("reconcile conecta números possuídos e restaura a sessão cifrada", async () => {
    const { mgr, driver, store } = build();
    listActiveConnectionsByProvider.mockResolvedValue([
      { tenantId: "T1", phoneNumberId: PN, displayPhone: "+55" },
    ]);
    store.get.mockResolvedValue(JSON.stringify({ creds: { me: "x" } }));
    await mgr.reconcile();
    expect(store.get).toHaveBeenCalledWith(PN);
    expect(driver.opened).toHaveLength(1);
  });

  it("QR → publica estado; creds → persiste sessão cifrada", async () => {
    const { mgr, driver, store, qr } = build();
    await mgr.connect("T1", PN);
    driver.emit({ type: "qr", qr: "QR-DATA" });
    driver.emit({ type: "creds", authState: { creds: 1 } });
    await flush();
    expect(qr.publish).toHaveBeenCalledWith(
      "T1",
      PN,
      expect.objectContaining({ status: "qr", qr: "QR-DATA" }),
    );
    expect(store.save).toHaveBeenCalledWith(PN, JSON.stringify({ creds: 1 }));
  });

  it("connection open → status connected publicado", async () => {
    const { mgr, driver, qr } = build();
    await mgr.connect("T1", PN);
    driver.emit({ type: "connection", state: "open" });
    await flush();
    expect(qr.publish).toHaveBeenLastCalledWith(
      "T1",
      PN,
      expect.objectContaining({ status: "connected" }),
    );
    expect(mgr.ownsLiveSocket(PN)).toBe(true);
  });

  it("resposta com parágrafos sai PICADA em bolhas idempotentes (ids derivados do inbound)", async () => {
    const { mgr, driver, core } = build();
    mgr.bubblePause = async () => {}; // sem esperar a pausa "digitando" no teste
    core.handle.mockImplementation(
      async (
        _msg: unknown,
        _conn: unknown,
        rf: (m: unknown, c: string, h: unknown) => (t: string) => Promise<void>,
      ) => {
        const reply = rf(
          {
            from: PN,
            externalMessageId: "ABC123",
            senderAddress: undefined,
          } as never,
          "conv-1",
          { isValid: async () => true },
        );
        await reply(
          "Fazemos implantes sim! A tomografia é na própria unidade.\n\nQuer que eu veja um horário de avaliação com o especialista?",
        );
      },
    );
    await mgr.connect("T1", PN);
    driver.emit({ type: "connection", state: "open" });
    driver.emit({
      type: "message",
      raw: {
        id: "ABC123",
        from: "5511888888888@s.whatsapp.net",
        text: "vcs fazem implante?",
      },
    });
    await flush();
    const sock = driver.opened.at(-1)!.conn;
    const lastTwo = sock.sent.slice(-2);
    expect(lastTwo).toHaveLength(2); // 2 parágrafos → 2 mensagens
    expect(lastTwo[0]!.text).toContain("própria unidade");
    expect(lastTwo[1]!.text).toContain("avaliação");
    expect(recordOutboundMessage).toHaveBeenCalledTimes(2); // transcript espelha as bolhas
  });

  it("inbound por evento → núcleo + resposta pelo SOCKET local", async () => {
    const { mgr, driver, core } = build();
    // o fake core invoca o replyFactory (simula o agente respondendo)
    core.handle.mockImplementation(
      async (
        _msg: unknown,
        _conn: unknown,
        rf: (m: unknown, c: string, h: unknown) => (t: string) => Promise<void>,
      ) => {
        const reply = rf(
          { from: PN, externalMessageId: "IN1" } as never,
          "conv-1",
          { isValid: async () => true },
        );
        await reply("resposta do agente");
      },
    );
    await mgr.connect("T1", PN);
    driver.emit({ type: "connection", state: "open" });
    driver.emit({
      type: "message",
      raw: { id: "IN1", from: "5511888888888@s.whatsapp.net", text: "olá" },
    });
    await flush();
    expect(core.handle).toHaveBeenCalledTimes(1);
    const sock = driver.opened.at(-1)!.conn;
    expect(sock.sent.at(-1)).toMatchObject({ text: "resposta do agente" });
    expect(recordOutboundMessage).toHaveBeenCalled();
  });

  it("logout → sai do roteamento (status≠active) + limpa sessão + alerta + exige re-pareamento", async () => {
    const { mgr, driver, store, notifier } = build();
    await mgr.connect("T1", PN);
    driver.emit({ type: "connection", state: "open" });
    driver.emit({ type: "connection", state: "logged_out", reason: "401" });
    await flush();
    expect(setConnectionStatus).toHaveBeenCalledWith(PN, "disconnected");
    expect(store.clear).toHaveBeenCalledWith(PN);
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "connection_down",
        severity: "critical",
      }),
    );
    expect(mgr.ownsLiveSocket(PN)).toBe(false); // socket removido → não roteia
  });

  it("queda → reconexão respeita o backoff (reconcile só reabre após nextRetryAt)", async () => {
    const { mgr, driver, setTime } = build();
    listActiveConnectionsByProvider.mockResolvedValue([
      { tenantId: "T1", phoneNumberId: PN, displayPhone: "+55" },
    ]);
    await mgr.connect("T1", PN);
    driver.emit({ type: "connection", state: "closed", reason: "rede" });
    await flush();
    expect(driver.opened).toHaveLength(1); // ainda não reconectou
    await mgr.reconcile();
    expect(driver.opened).toHaveLength(1); // antes do nextRetryAt: não reconecta
    setTime(1_000_000 + 5000); // passa o backoff (2s)
    await mgr.reconcile();
    expect(driver.opened).toHaveLength(2); // reabriu
  });

  it("falha no connect NÃO aborta o reconcile dos demais números e agenda retry (não fica 'connecting')", async () => {
    // Driver que FALHA no 1º open (PN, 1º da lista) e conecta os demais.
    const PN2 = "5511777777777";
    const inner = new FakeBaileysDriver();
    let failNext = true;
    const failing = {
      open: async (opts: Parameters<FakeBaileysDriver["open"]>[0]) => {
        if (failNext) {
          failNext = false;
          throw new Error("open falhou (rede)");
        }
        return inner.open(opts);
      },
    } as unknown as FakeBaileysDriver;
    const { mgr, setTime } = build({}, failing);
    listActiveConnectionsByProvider.mockResolvedValue([
      { tenantId: "T1", phoneNumberId: PN, displayPhone: "+55" },
      { tenantId: "T1", phoneNumberId: PN2, displayPhone: "+55" },
    ]);
    await mgr.reconcile(); // NÃO lança; PN falha, PN2 conecta
    expect(inner.opened).toHaveLength(1); // o 2º número conectou mesmo com a falha do 1º
    // A sessão falhada NÃO ficou presa em 'connecting': reconcile re-tenta após o backoff.
    await mgr.reconcile();
    expect(inner.opened).toHaveLength(1); // antes do nextRetryAt: não re-tenta ainda
    setTime(1_000_000 + 60_000); // passa o backoff
    await mgr.reconcile();
    expect(inner.opened).toHaveLength(2); // re-tentou o número que falhou
  });

  it("rejeição TERMINAL (405) repetida → invalida a sessão: status real, blob limpo, alerta, fora do roteamento", async () => {
    const { mgr, driver, store, notifier } = build();
    await mgr.connect("T1", PN);
    driver.emit({ type: "connection", state: "open" });
    // 3 rejeições consecutivas de auth — reconectar com o mesmo blob não resolve.
    driver.emit({ type: "connection", state: "closed", reason: "405" });
    driver.emit({ type: "connection", state: "closed", reason: "405" });
    driver.emit({ type: "connection", state: "closed", reason: "405" });
    await flush();
    expect(setConnectionStatus).toHaveBeenCalledWith(PN, "disconnected"); // selo para de mentir
    expect(store.clear).toHaveBeenCalledWith(PN); // blob morto não re-loopa
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "connection_down" }),
    );
    expect(mgr.ownsLiveSocket(PN)).toBe(false);
  });

  it("queda de REDE repetida NÃO invalida (retenta para sempre — sessão do cliente sobrevive)", async () => {
    const { mgr, driver, store } = build();
    await mgr.connect("T1", PN);
    driver.emit({ type: "connection", state: "open" });
    for (let i = 0; i < 5; i++)
      driver.emit({ type: "connection", state: "closed", reason: "428" });
    await flush();
    expect(setConnectionStatus).not.toHaveBeenCalledWith(PN, "disconnected");
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("queda de rede QUEBRA a sequência terminal (só rejeições consecutivas invalidam)", async () => {
    const { mgr, driver, store } = build();
    await mgr.connect("T1", PN);
    driver.emit({ type: "connection", state: "closed", reason: "405" });
    driver.emit({ type: "connection", state: "closed", reason: "405" });
    driver.emit({ type: "connection", state: "closed", reason: "428" }); // rede no meio → reseta
    driver.emit({ type: "connection", state: "closed", reason: "405" });
    driver.emit({ type: "connection", state: "closed", reason: "405" });
    await flush();
    expect(store.clear).not.toHaveBeenCalled(); // nunca 3 consecutivas
  });

  it("evento de socket ANTIGO (pós-reconexão) é descartado — não fecha nem invalida o novo", async () => {
    const { mgr, driver, store } = build();
    await mgr.connect("T1", PN);
    const old = driver.opened.at(-1)!;
    await mgr.connect("T1", PN); // reconecta → nova geração
    driver.emit({ type: "connection", state: "open" }); // socket novo abre
    old.emit({ type: "connection", state: "logged_out", reason: "401" }); // atrasado do antigo
    await flush();
    expect(store.clear).not.toHaveBeenCalled(); // não invalidou a sessão nova
    expect(mgr.ownsLiveSocket(PN)).toBe(true); // socket novo segue roteando
  });

  it("cod 515 (restart pós-pareamento) → reconexão IMEDIATA, sem esperar backoff", async () => {
    const { mgr, driver } = build();
    listActiveConnectionsByProvider.mockResolvedValue([
      { tenantId: "T1", phoneNumberId: PN, displayPhone: "+55" },
    ]);
    await mgr.connect("T1", PN);
    driver.emit({ type: "connection", state: "closed", reason: "515" });
    await flush();
    await mgr.reconcile(); // SEM avançar o relógio — 515 não agenda backoff
    expect(driver.opened).toHaveLength(2);
  });

  it("persistência do blob re-tenta em soluço do banco (signal keys não se perdem)", async () => {
    const { mgr, driver, store } = build();
    mgr.persistRetryDelaysMs = [1, 1];
    store.save
      .mockRejectedValueOnce(new Error("Postgres caiu"))
      .mockResolvedValue(undefined);
    await mgr.connect("T1", PN);
    driver.emit({ type: "creds", authState: { creds: 2 } });
    await new Promise((r) => setTimeout(r, 30)); // espera o retry (1ms) resolver
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.save).toHaveBeenLastCalledWith(
      PN,
      JSON.stringify({ creds: 2 }),
    );
  });

  it("status (receipt) → reconcilia mensagem + outbox", async () => {
    const { mgr, driver } = build();
    await mgr.connect("T1", PN);
    driver.emit({
      type: "status",
      raw: { id: "OUT1", status: "delivered", to: "5511888@s.whatsapp.net" },
    });
    await flush();
    expect(markMessageStatusByExternalId).toHaveBeenCalledWith(
      "OUT1",
      "delivered",
    );
    expect(reconcileOutboxStatus).toHaveBeenCalledWith("OUT1", "delivered");
  });

  it("sendText (outbox proativo) só do worker com socket aberto", async () => {
    const { mgr, driver } = build();
    await expect(mgr.sendText(PN, "5511888", "oi")).rejects.toThrow(); // sem socket
    await mgr.connect("T1", PN);
    driver.emit({ type: "connection", state: "open" });
    await flush();
    const res = await mgr.sendText(PN, "5511888", "oi proativo");
    expect(res.id).toBeTruthy();
    expect(driver.opened.at(-1)!.conn.sent.at(-1)).toMatchObject({
      text: "oi proativo",
    });
  });
});

const CONTACT = "5511888888888";
const MULTI_BUBBLE_REPLY =
  "Primeira bolha com informação suficiente.\n\nSegunda bolha com mais informação suficiente.";

function storedTurn(id = "turn-1", conversationId = "conv-1"): AgentTurnRow {
  return {
    id,
    conversationId,
    externalMessageId: `inbound-${id}`,
    conversationKey: `baileys:${PN}:${CONTACT}`,
    status: "ready",
    replyStatus: "pending",
    completedEffects: [],
    leaseToken: null,
    leaseExpiresAt: null,
    attempts: 1,
    lastError: "send_failed",
    plan: {
      replyText: "Resposta já planejada antes do restart",
      outcome: null,
      decision: null,
      source: {
        from: CONTACT,
        type: "text",
        provider: "baileys",
        channelAccountId: PN,
        senderAddress: `${CONTACT}@lid`,
        receivedAt: "2026-10-07T12:00:00.000Z",
      },
    },
  };
}

function activeRoute(phoneNumberId = PN) {
  return {
    connectionId: "connection-id",
    phoneNumberId,
    secretRef: "whatsapp_token",
    provider: "baileys",
    status: "active",
    wabaId: null,
  };
}

async function openSession() {
  const setup = build();
  listActiveConnectionsByProvider.mockResolvedValue([
    { tenantId: "T1", phoneNumberId: PN },
  ]);
  await setup.mgr.connect("T1", PN);
  setup.driver.emit({ type: "connection", state: "open" });
  await flush();
  return setup;
}

async function captureReply(
  handle = { isValid: vi.fn().mockResolvedValue(true) },
) {
  const setup = await openSession();
  let reply: ReturnType<ReplyFactory> | undefined;
  setup.core.handle.mockImplementation(
    async (
      message: NormalizedInboundMessage,
      _conn: unknown,
      factory: ReplyFactory,
    ) => {
      reply = factory(message, "conv-1", handle as never);
    },
  );
  setup.driver.emit({
    type: "message",
    raw: { id: "reply-inbound", from: `${CONTACT}@lid`, text: "inbound" },
  });
  await flush();
  if (!reply) throw new Error("Reply factory not captured");
  setup.mgr.bubblePause = async () => {};
  return { ...setup, reply, handle, socket: setup.driver.opened.at(-1)!.conn };
}

describe("Baileys — recuperação dos planos persistidos", () => {
  it("retoma sem novo inbound, no tenant e conta originais, preservando JID/LID e texto planejado", async () => {
    const { mgr, core, driver } = await openSession();
    const turn = storedTurn();
    const scanTenants: Array<string | undefined> = [];
    listPendingAgentTurns.mockImplementation(async () => {
      scanTenants.push(getContext()?.tenantId);
      return [turn];
    });
    getConnectionForConversation.mockResolvedValue(activeRoute());
    const resume = vi
      .fn()
      .mockImplementation(
        async (
          pending: AgentTurnRow,
          _conn: unknown,
          factory: ReplyFactory,
        ) => {
          expect(getContext()?.tenantId).toBe("T1");
          const source = pending.plan!.source!;
          const message: NormalizedInboundMessage = {
            provider: source.provider!,
            channelAccountId: source.channelAccountId,
            from: source.from,
            to: source.channelAccountId!,
            senderAddress: source.senderAddress,
            receivedAt: source.receivedAt!,
            externalMessageId: pending.externalMessageId,
            conversationKey: pending.conversationKey,
            content: { type: "text", text: "" },
          };
          await factory(message, pending.conversationId, {
            isValid: async () => true,
          } as never)(pending.plan!.replyText);
        },
      );
    Object.assign(core, { resumeStoredTurn: resume });
    await mgr.reconcile();
    expect(scanTenants).toEqual(["T1"]);
    expect(listPendingAgentTurns).toHaveBeenCalledWith(50, {
      provider: "baileys",
      channelAccountId: PN,
    });
    expect(resume).toHaveBeenCalledWith(
      turn,
      {
        tenantId: "T1",
        connectionId: "connection-id",
        secretRef: "whatsapp_token",
      },
      expect.any(Function),
    );
    expect(core.handle).not.toHaveBeenCalled();
    expect(driver.opened.at(-1)!.conn.sent).toEqual([
      expect.objectContaining({
        toJid: `${CONTACT}@lid`,
        text: turn.plan!.replyText,
      }),
    ]);
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        content: { text: turn.plan!.replyText },
      }),
    );
  });

  it("não retoma outra conta/provedor, metadados divergentes ou uma conexão inativa", async () => {
    const { mgr, core } = await openSession();
    const cloud = storedTurn("cloud", "cloud");
    cloud.conversationKey = `cloud_api:${PN}:${CONTACT}`;
    const foreignAccount = storedTurn("foreign", "foreign");
    foreignAccount.conversationKey = `baileys:outra-conta:${CONTACT}`;
    const wrongSource = storedTurn("wrong-source", "wrong-source");
    wrongSource.plan!.source!.channelAccountId = "outra-conta";
    const wrongProvider = storedTurn("wrong-provider", "wrong-provider");
    wrongProvider.plan!.source!.provider = "cloud_api";
    const disconnected = storedTurn("disconnected", "disconnected");
    const changedRoute = storedTurn("changed-route", "changed-route");
    const deleted = storedTurn("deleted", "deleted");
    listPendingAgentTurns.mockResolvedValue([
      cloud,
      foreignAccount,
      wrongSource,
      wrongProvider,
      disconnected,
      changedRoute,
      deleted,
    ]);
    getConnectionForConversation.mockImplementation(async (id: string) =>
      id === "disconnected"
        ? { ...activeRoute(), status: "disconnected" }
        : id === "changed-route"
          ? activeRoute("outra-conta")
          : null,
    );
    const resume = vi.fn();
    Object.assign(core, { resumeStoredTurn: resume });
    await mgr.reconcile();
    expect(resume).not.toHaveBeenCalled();
    expect(getConnectionForConversation.mock.calls.map(([id]) => id)).toEqual([
      "disconnected",
      "changed-route",
      "deleted",
    ]);
  });

  it("isola falha de uma recuperação e continua os outros planos", async () => {
    const { mgr, core } = await openSession();
    listPendingAgentTurns.mockResolvedValue([
      storedTurn("first", "conv-1"),
      storedTurn("second", "conv-2"),
    ]);
    getConnectionForConversation.mockResolvedValue(activeRoute());
    const resume = vi
      .fn()
      .mockRejectedValueOnce(new Error("recovery_failed"))
      .mockResolvedValue(undefined);
    Object.assign(core, { resumeStoredTurn: resume });
    await expect(mgr.reconcile()).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("impede reconcile concorrente e libera a guarda após sucesso e falha", async () => {
    const { mgr } = build();
    let release!: (value: unknown[]) => void;
    listActiveConnectionsByProvider.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = mgr.reconcile();
    await mgr.reconcile();
    expect(listActiveConnectionsByProvider).toHaveBeenCalledTimes(1);
    release([]);
    await first;
    listActiveConnectionsByProvider.mockRejectedValueOnce(
      new Error("database_failed"),
    );
    await expect(mgr.reconcile()).rejects.toThrow("database_failed");
    listActiveConnectionsByProvider.mockResolvedValue([]);
    await mgr.reconcile();
    expect(listActiveConnectionsByProvider).toHaveBeenCalledTimes(3);
  });
});

describe("Baileys — estado de entrega da resposta", () => {
  it("lock inválido antes da tentativa é not_sent e não chama o socket", async () => {
    const { reply, socket } = await captureReply({
      isValid: vi.fn().mockResolvedValue(false),
    });
    await expect(reply("resposta")).rejects.toMatchObject({
      delivery: "not_sent",
    });
    expect(socket.sent).toEqual([]);
  });

  it("socket fechado antes da tentativa é not_sent", async () => {
    const { reply, socket, driver } = await captureReply();
    driver.emit({ type: "connection", state: "closed", reason: "428" });
    await flush();
    await expect(reply("resposta")).rejects.toBeInstanceOf(ReplyDeliveryError);
    await expect(reply("resposta")).rejects.toMatchObject({
      delivery: "not_sent",
    });
    expect(socket.sent).toEqual([]);
  });

  it("sessão removida do roteamento antes da tentativa é not_sent", async () => {
    const { reply, socket, mgr } = await captureReply();
    listActiveConnectionsByProvider.mockResolvedValue([]);
    await mgr.reconcile();
    await expect(reply("resposta")).rejects.toMatchObject({
      delivery: "not_sent",
    });
    expect(socket.sent).toEqual([]);
  });

  it("erro de socket sem confirmação é uncertain", async () => {
    const { reply, socket } = await captureReply();
    vi.spyOn(socket, "sendText").mockRejectedValueOnce(
      new Error("network_timeout"),
    );
    await expect(reply("resposta")).rejects.toMatchObject({
      delivery: "uncertain",
    });
    expect(recordOutboundMessage).not.toHaveBeenCalled();
  });

  it("falha na segunda bolha após aceitar a primeira é uncertain", async () => {
    const { reply, socket } = await captureReply();
    const original = socket.sendText.bind(socket);
    vi.spyOn(socket, "sendText")
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error("network_timeout"));
    await expect(reply(MULTI_BUBBLE_REPLY)).rejects.toMatchObject({
      delivery: "uncertain",
    });
    expect(socket.sent).toHaveLength(1);
    expect(recordOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it("lock perdido entre bolhas não envia a segunda e é uncertain", async () => {
    const { reply, socket } = await captureReply({
      isValid: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    });
    await expect(reply(MULTI_BUBBLE_REPLY)).rejects.toMatchObject({
      delivery: "uncertain",
    });
    expect(socket.sent).toHaveLength(1);
  });

  it("socket substituído entre bolhas bloqueia continuação e é uncertain", async () => {
    const { reply, socket, mgr, driver } = await captureReply();
    mgr.bubblePause = async () => {
      await mgr.connect("T1", PN);
      driver.emit({ type: "connection", state: "open" });
      await flush();
    };
    await expect(reply(MULTI_BUBBLE_REPLY)).rejects.toMatchObject({
      delivery: "uncertain",
    });
    expect(socket.sent).toHaveLength(1);
    expect(driver.opened.at(-1)!.conn.sent).toHaveLength(0);
  });

  it("falha ao persistir transcript depois de envio aceito é uncertain", async () => {
    const { reply, socket } = await captureReply();
    recordOutboundMessage.mockRejectedValueOnce(
      new Error("database_unavailable"),
    );
    await expect(reply("resposta")).rejects.toMatchObject({
      delivery: "uncertain",
    });
    expect(socket.sent).toHaveLength(1);
  });

  it("falha no livro-razão depois de envio aceito é uncertain", async () => {
    const { reply, socket, outbox } = await captureReply();
    outbox.recordReactiveDelivery.mockRejectedValueOnce(
      new Error("outbox_unavailable"),
    );
    await expect(reply("resposta")).rejects.toMatchObject({
      delivery: "uncertain",
    });
    expect(socket.sent).toHaveLength(1);
  });

  it.each(["human", "optout"])(
    "bloqueio %s entre bolhas interrompe como uncertain",
    async (kind) => {
      const { reply, socket } = await captureReply();
      const guard = kind === "human" ? isHumanTakeover : isContactOptedOut;
      guard.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await expect(reply(MULTI_BUBBLE_REPLY)).rejects.toMatchObject({
        delivery: "uncertain",
      });
      expect(socket.sent).toHaveLength(1);
    },
  );

  it("confirmação explícita de opt-out pode responder mesmo com bloqueio atual", async () => {
    const { reply, socket, outbox } = await captureReply();
    isHumanTakeover.mockResolvedValue(true);
    isContactOptedOut.mockResolvedValue(true);
    await reply("Tudo certo, não enviaremos novas mensagens.", {
      allowOptOutReply: true,
    });
    expect(socket.sent).toHaveLength(1);
    expect(outbox.recordReactiveDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "baileys" }),
      { strict: true },
    );
  });
});

/** Deixa os microtasks dos handlers de evento (void async) resolverem. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}
