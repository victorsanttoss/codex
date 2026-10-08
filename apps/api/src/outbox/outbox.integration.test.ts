import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { runWithTenant } from "@sdr/core";
import {
  claimDueOutbox,
  closeDb,
  enqueueOutbox,
  getActiveConnectionForTenant,
  makeMigrationClient,
  markContactOptedOut,
  markOutboxSent,
  reconcileOutboxStatus,
  schema,
  setHumanTakeover,
  sweepStuckOutbox,
  withTenant,
} from "@sdr/db";
import { ChannelSendError } from "@sdr/whatsapp-cloud";
import { OutboxService } from "./outbox.service";
import type { ChannelFactory } from "../whatsapp/channel-factory.service";

const eqId = (id: string) => eq(schema.outboxMessages.id, id);

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

/** Sender fake que DEDUPLICA por clientMessageId (simula o provedor). */
function fakeChannel(opts: { failFirst?: boolean } = {}) {
  const deliveries = new Map<string, string>(); // clientMessageId -> externalId (único)
  let calls = 0;
  const sender = {
    async sendTemplate(msg: { to: string; clientMessageId?: string }) {
      calls++;
      if (opts.failFirst && calls === 1) throw new ChannelSendError("temporário", true, 503);
      const key = msg.clientMessageId ?? randomUUID();
      const ext = deliveries.get(key) ?? `ext-${randomUUID()}`; // dedup por clientMessageId
      deliveries.set(key, ext);
      return { externalMessageId: ext, acceptedAt: new Date(0).toISOString() };
    },
    async sendMessage() {
      throw new Error("não usado");
    },
  };
  const channels = {
    async tenantSender() {
      return sender;
    },
  } as unknown as ChannelFactory;
  return { channels, deliveries, callCount: () => calls };
}

describe.skipIf(!dbConfigured)("M8 — outbox (integração ao vivo)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";
  let convId = "";

  async function seedConnAndConv(): Promise<string> {
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`INSERT INTO channel_connections (tenant_id, phone_number_id, status, secret_ref)
               VALUES (${tenantId}, ${"pnid-" + randomUUID()}, 'active', 'whatsapp_token')`;
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id) VALUES (${tenantId}, ${"wa-" + randomUUID()}) RETURNING id`;
      const [cv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key)
        VALUES (${tenantId}, ${c!.id}, ${"ck-" + randomUUID()}) RETURNING id`;
      return cv!.id;
    }) as Promise<string>;
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('OBX', ${"obx-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    convId = await seedConnAndConv();
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await closeDb();
  });

  function tmpl(key: string) {
    return {
      conversationId: convId,
      toPhone: "+5511999",
      kind: "template" as const,
      payload: { templateName: "reengage", languageCode: "pt_BR" },
      idempotencyKey: key,
      clientMessageId: key,
      billing: "template" as const,
    };
  }

  it("processa pending → sent e grava external_message_id", async () => {
    const { channels, deliveries } = fakeChannel();
    const svc = new OutboxService(channels);
    await runWithTenant({ tenantId }, async () => {
      const conn = await getActiveConnectionForTenant();
      expect(conn, "conexão ativa do tenant não encontrada").not.toBeNull();
      await enqueueOutbox(tmpl("ob-1"));
      const sent = await svc.processDue(10);
      expect(sent).toBe(1);
      const rows = await withTenant((tx) => tx.select().from(schema.outboxMessages));
      const row = rows.find((r) => r.idempotencyKey === "ob-1")!;
      expect(row.status).toBe("sent");
      expect(row.externalMessageId).toBeTruthy();
    });
    expect(deliveries.size).toBe(1);
  });

  it("AT-LEAST-ONCE com DEDUP: órfã 'sending' reenviada não entrega 2× (mesmo clientMessageId)", async () => {
    const { channels, deliveries, callCount } = fakeChannel();
    const svc = new OutboxService(channels);
    await runWithTenant({ tenantId }, async () => {
      const { outboxId } = await enqueueOutbox(tmpl("ob-2"));
      await svc.processDue(10); // envia, marca sent
      // simula CRASH no meio do envio anterior: força a linha de volta p/ 'sending'
      await withTenant((tx) =>
        tx
          .update(schema.outboxMessages)
          .set({ status: "sending", externalMessageId: null })
          .where(eqId(outboxId)),
      );
      // reclaim de órfã (lease 0) → reenvia com o MESMO clientMessageId
      const claimed = await claimDueOutbox(10, 0);
      expect(claimed.some((c) => c.id === outboxId)).toBe(true);
      const sender = await channels.tenantSender("x", "whatsapp_token");
      const res = await sender.sendTemplate({ to: "+5511999", clientMessageId: "ob-2", templateName: "reengage", languageCode: "pt_BR" });
      await markOutboxSent(outboxId, res.externalMessageId);
    });
    expect(deliveries.size).toBe(1); // entregue UMA vez (dedup por clientMessageId)
    expect(callCount()).toBe(2); // tentou 2×, entregou 1×
  });

  it("falha transiente re-agenda (não perde); depois sucede", async () => {
    const { channels } = fakeChannel({ failFirst: true });
    const svc = new OutboxService(channels);
    await runWithTenant({ tenantId }, async () => {
      await enqueueOutbox({ ...tmpl("ob-3"), maxAttempts: 5 });
      const sent1 = await svc.processDue(10); // 1ª falha → pending+backoff
      expect(sent1).toBe(0);
      let row = (await withTenant((tx) => tx.select().from(schema.outboxMessages))).find((r) => r.idempotencyKey === "ob-3")!;
      expect(row.status).toBe("pending"); // não foi perdida
      // limpa o backoff p/ re-processar já
      await withTenant((tx) => tx.update(schema.outboxMessages).set({ nextAttemptAt: null }).where(eqId(row.id)));
      const sent2 = await svc.processDue(10);
      expect(sent2).toBe(1);
      row = (await withTenant((tx) => tx.select().from(schema.outboxMessages))).find((r) => r.idempotencyKey === "ob-3")!;
      expect(row.status).toBe("sent");
    });
  });

  it("GUARDRAIL no envio: opt-out depois de enfileirar → CANCELADO, não envia", async () => {
    const conv2 = await seedConnAndConv();
    const { channels, deliveries } = fakeChannel();
    const svc = new OutboxService(channels);
    await runWithTenant({ tenantId }, async () => {
      const { getConversationContact } = await import("@sdr/db");
      const contact = await getConversationContact(conv2);
      await enqueueOutbox({ ...tmpl("ob-cancel"), conversationId: conv2 });
      await markContactOptedOut(contact!.waId); // opt-out ENTRE enfileirar e enviar
      const sent = await svc.processDue(10);
      expect(sent).toBe(0);
      const row = (await withTenant((tx) => tx.select().from(schema.outboxMessages))).find((r) => r.idempotencyKey === "ob-cancel")!;
      expect(row.status).toBe("canceled");
    });
    expect(deliveries.size).toBe(0); // não entregou
  });

  it("GUARDRAIL no envio: humano assumiu a conversa → proativa CANCELADA, não envia", async () => {
    const conv3 = await seedConnAndConv();
    const { channels, deliveries } = fakeChannel();
    const svc = new OutboxService(channels);
    await runWithTenant({ tenantId }, async () => {
      await enqueueOutbox({ ...tmpl("ob-takeover"), conversationId: conv3 });
      await setHumanTakeover(conv3, true); // humano assume ENTRE enfileirar e enviar
      const sent = await svc.processDue(10);
      expect(sent).toBe(0);
      const row = (await withTenant((tx) => tx.select().from(schema.outboxMessages))).find((r) => r.idempotencyKey === "ob-takeover")!;
      expect(row.status).toBe("canceled");
      expect(row.lastError).toBe("human_takeover");
    });
    expect(deliveries.size).toBe(0); // nada saiu por cima do atendimento humano
  });

  it("SWEEP: órfã 'sending' com attempts esgotados vira 'failed' (visível no alerta)", async () => {
    const { channels } = fakeChannel();
    const svc = new OutboxService(channels);
    await runWithTenant({ tenantId }, async () => {
      const { outboxId } = await enqueueOutbox({ ...tmpl("ob-stuck"), maxAttempts: 1 });
      await claimDueOutbox(10); // attempts=1 (== max), status 'sending'
      // simula worker MORTO no meio do envio: linha estagnada em 'sending'
      await withTenant((tx) =>
        tx
          .update(schema.outboxMessages)
          .set({ status: "sending", updatedAt: new Date(Date.now() - 10 * 60_000) })
          .where(eq(schema.outboxMessages.id, outboxId)),
      );
      // o claim NUNCA mais a pega (attempts >= max) — só o sweep resolve.
      const claimed = await claimDueOutbox(10, 0);
      expect(claimed.some((c) => c.id === outboxId)).toBe(false);
      const swept = await sweepStuckOutbox(300_000);
      expect(swept).toBeGreaterThanOrEqual(1);
      const row = (await withTenant((tx) => tx.select().from(schema.outboxMessages))).find((r) => r.id === outboxId)!;
      expect(row.status).toBe("failed");
    });
  });

  it("reconciliação: delivered/read avançam a linha por external_message_id", async () => {
    const { channels } = fakeChannel();
    const svc = new OutboxService(channels);
    await runWithTenant({ tenantId }, async () => {
      await enqueueOutbox(tmpl("ob-4"));
      await svc.processDue(10);
      const row = (await withTenant((tx) => tx.select().from(schema.outboxMessages))).find((r) => r.idempotencyKey === "ob-4")!;
      await reconcileOutboxStatus(row.externalMessageId!, "delivered");
      const after = (await withTenant((tx) => tx.select().from(schema.outboxMessages))).find((r) => r.id === row.id)!;
      expect(after.status).toBe("delivered");
    });
  });
});
