import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictException, ForbiddenException, UnprocessableEntityException } from "@nestjs/common";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient, schema, withTenant } from "@sdr/db";
import { OutboxService } from "../outbox/outbox.service";
import type { ChannelFactory } from "../whatsapp/channel-factory.service";
import { PanelMessageService } from "./panel-message.service";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

/** Sender Cloud fake — registra o que saiu e por qual número. */
function fakeChannels() {
  const sent: Array<{ pnid: string; to: string; text: string }> = [];
  const factory = {
    async tenantSender(pnid: string) {
      return {
        async sendMessage(msg: { to: string; text: string }) {
          sent.push({ pnid, to: msg.to, text: msg.text });
          return { externalMessageId: `ext-${randomUUID()}`, acceptedAt: new Date().toISOString() };
        },
        async sendTemplate() {
          throw new Error("não usado");
        },
      };
    },
  } as unknown as ChannelFactory;
  return { factory, sent };
}

describe.skipIf(!dbConfigured)("Painel — envio manual do humano (integração ao vivo)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";
  let svc: PanelMessageService;
  let outbox: OutboxService;
  let sent: Array<{ pnid: string; to: string; text: string }> = [];

  interface SeedOpts {
    takeover?: boolean;
    windowFuture?: boolean;
    provider?: string;
  }

  /** Conexão + contato + conversa com conversation_key na convenção ADR 0010. */
  async function seed(opts: SeedOpts = {}): Promise<{ convId: string; connId: string; pnid: string; waId: string }> {
    const provider = opts.provider ?? "cloud_api";
    const pnid = "pnid-" + randomUUID();
    const waId = "wa-" + randomUUID();
    const windowExpires = opts.windowFuture ? new Date(Date.now() + 60 * 60_000).toISOString() : null;
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [cc] = await tx<{ id: string }[]>`
        INSERT INTO channel_connections (tenant_id, phone_number_id, provider, status, secret_ref)
        VALUES (${tenantId}, ${pnid}, ${provider}, 'active', 'whatsapp_token') RETURNING id`;
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id, phone) VALUES (${tenantId}, ${waId}, ${"+5511" + Math.floor(Math.random() * 1e8)}) RETURNING id`;
      const [cv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key, human_takeover, window_expires_at)
        VALUES (${tenantId}, ${c!.id}, ${`${provider}:${pnid}:${waId}`}, ${opts.takeover ?? false}, ${windowExpires})
        RETURNING id`;
      return { convId: cv!.id, connId: cc!.id, pnid, waId };
    }) as Promise<{ convId: string; connId: string; pnid: string; waId: string }>;
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('PANEL', ${"panel-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    const fake = fakeChannels();
    sent = fake.sent;
    outbox = new OutboxService(fake.factory);
    svc = new PanelMessageService(outbox);
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await closeDb();
  });

  it("409 quando a IA está no comando (sem takeover)", async () => {
    const { convId } = await seed({ takeover: false, windowFuture: true });
    await expect(
      runWithTenant({ tenantId }, () => svc.sendHumanMessage(convId, "oi")),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("403 quando o contato optou por não receber mensagens (opt-out)", async () => {
    const { convId, waId } = await seed({ takeover: true, windowFuture: true });
    await runWithTenant({ tenantId }, async () => {
      const { markContactOptedOut } = await import("@sdr/db");
      await markContactOptedOut(waId);
      await expect(svc.sendHumanMessage(convId, "oi")).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it("422 fora da janela de 24h (conexão Cloud)", async () => {
    const { convId } = await seed({ takeover: true, windowFuture: false });
    await runWithTenant({ tenantId }, async () => {
      await expect(svc.sendHumanMessage(convId, "oi")).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(svc.sendHumanMessage(convId, "oi")).rejects.toThrow(/janela/i);
    });
  });

  it("envia (Cloud, na janela): histórico outbound + linha origin='human' roteada pela conexão da conversa", async () => {
    const { convId, connId, pnid } = await seed({ takeover: true, windowFuture: true });
    const message = await runWithTenant({ tenantId }, () => svc.sendHumanMessage(convId, "resposta do humano"));
    expect(message).toMatchObject({ direction: "outbound", type: "text", content: { text: "resposta do humano" } });

    // saiu pelo NÚMERO da conversa (não pelo default do tenant, que aqui tem vários)
    expect(sent.some((s) => s.pnid === pnid && s.text === "resposta do humano")).toBe(true);

    await runWithTenant({ tenantId }, async () => {
      // histórico da conversa registra o outbound (como o reply() do agente)
      const msgs = await withTenant((tx) => tx.select().from(schema.messages));
      const out = msgs.find((m) => m.conversationId === convId && m.direction === "outbound");
      expect(out).toBeTruthy();
      expect(out!.status).toBe("sent");

      // livro-razão: linha nasce 'sent', origin='human', com a conexão da conversa
      const rows = await withTenant((tx) => tx.select().from(schema.outboxMessages));
      const ledger = rows.find((r) => r.conversationId === convId);
      expect(ledger).toBeTruthy();
      expect(ledger!.origin).toBe("human");
      expect(ledger!.status).toBe("sent");
      expect(ledger!.connectionId).toBe(connId);
      expect(ledger!.externalMessageId).toBe(out!.externalMessageId);
    });
  });

  it("IDEMPOTÊNCIA (achado Codex): retry com a MESMA clientMessageId não reenvia ao lead", async () => {
    const { convId, pnid } = await seed({ takeover: true, windowFuture: true });
    const key = randomUUID();
    const sentBefore = sent.length;
    await runWithTenant({ tenantId }, () => svc.sendHumanMessage(convId, "só uma vez", key));
    // retry do painel (falha de rede pós-envio / duplo clique) com a mesma chave
    const again = await runWithTenant({ tenantId }, () => svc.sendHumanMessage(convId, "só uma vez", key));
    expect(again).toMatchObject({ direction: "outbound", content: { text: "só uma vez" } });
    expect(sent.filter((s) => s.pnid === pnid && s.text === "só uma vez")).toHaveLength(1);
    expect(sent.length).toBe(sentBefore + 1); // provedor foi chamado UMA vez
    await runWithTenant({ tenantId }, async () => {
      const rows = await withTenant((tx) => tx.select().from(schema.outboxMessages));
      const ledger = rows.filter((r) => r.idempotencyKey === `human:client:${key}`);
      expect(ledger).toHaveLength(1); // uma linha só no livro-razão
      expect(ledger[0]!.status).toBe("sent");
    });
  });

  it("Baileys NÃO tem janela: envia mesmo sem window_expires_at (via seam do worker)", async () => {
    const { convId, pnid } = await seed({ takeover: true, windowFuture: false, provider: "baileys" });
    const sends: string[] = [];
    outbox.setBaileysOutbound({
      ownsLiveSocket: () => true,
      sendText: async (phoneNumberId: string) => {
        sends.push(phoneNumberId);
        return { id: "BLZ-" + randomUUID() };
      },
    });
    const message = await runWithTenant({ tenantId }, () => svc.sendHumanMessage(convId, "sem janela"));
    expect(message.direction).toBe("outbound");
    expect(sends).toEqual([pnid]); // saiu pelo socket do número da conversa
  });
});
