import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient, withTenant } from "./client";
import {
  claimDueOutbox,
  countOutboxFailed,
  countOutboxSentSince,
  enqueueOutbox,
  listTenantsWithDueOutbox,
  markOutboxFailed,
  markOutboxSent,
  reconcileOutboxStatus,
  recordSentOutbox,
  sweepStuckOutbox,
} from "./outbox";
import {
  armCadence,
  getCadenceState,
  isContactOptedOut,
  markContactOptedOut,
  stopCadence,
} from "./cadence";
import { getConnectionForConversation } from "./channel-connections";
import { outboxMessages } from "./schema";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("outbox + cadência (RLS)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";
  let convA = "";
  let waA = "";

  async function seed(tenantId: string): Promise<{ conv: string; waId: string }> {
    const waId = "wa-" + randomUUID();
    const conv = await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id) VALUES (${tenantId}, ${waId}) RETURNING id`;
      const [cv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key)
        VALUES (${tenantId}, ${c!.id}, ${"ck-" + randomUUID()}) RETURNING id`;
      return cv!.id;
    });
    return { conv: conv as string, waId };
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('OB-A', ${"oba-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('OB-B', ${"obb-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
    const s = await seed(tenantA);
    convA = s.conv;
    waA = s.waId;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  function tmpl(key: string) {
    return {
      conversationId: convA,
      toPhone: "+5511999",
      kind: "template" as const,
      payload: { templateName: "reengage", languageCode: "pt_BR" },
      idempotencyKey: key,
      clientMessageId: key,
      billing: "template" as const,
    };
  }

  it("enqueue é idempotente por idempotency_key; claim move pending->sending", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const a = await enqueueOutbox(tmpl("k1"));
      const b = await enqueueOutbox(tmpl("k1"));
      expect(a.created).toBe(true);
      expect(b.created).toBe(false); // não duplica
      expect(a.outboxId).toBe(b.outboxId);

      const claimed = await claimDueOutbox(10);
      expect(claimed.some((c) => c.id === a.outboxId)).toBe(true);
      // já em 'sending' → segundo claim não pega de novo
      const again = await claimDueOutbox(10);
      expect(again.some((c) => c.id === a.outboxId)).toBe(false);
    });
  });

  it("máquina de estados: sent + reconciliação delivered/read (monotônica)", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const { outboxId } = await enqueueOutbox(tmpl("k2"));
      await claimDueOutbox(10);
      await markOutboxSent(outboxId, "ext-2");
      expect(await reconcileOutboxStatus("ext-2", "delivered")).toBe(true);
      expect(await reconcileOutboxStatus("ext-2", "read")).toBe(true);
      expect(await reconcileOutboxStatus("ext-2", "delivered")).toBe(false); // não regride
      const row = await withTenant((tx) => tx.select().from(outboxMessages));
      expect(row.find((r) => r.id === outboxId)!.status).toBe("read");
    });
  });

  it("ledger reativo: linha nasce 'sent', é idempotente, NUNCA é reivindicada e reconcilia", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const input = {
        conversationId: convA,
        toPhone: "+5511999",
        payload: { text: "resposta do agente" },
        idempotencyKey: "reactive:ext-r1",
        externalMessageId: "ext-r1",
        billing: "service" as const,
      };
      await recordSentOutbox(input);
      await recordSentOutbox(input); // idempotente — não duplica

      const rows = await withTenant((tx) => tx.select().from(outboxMessages));
      const mine = rows.filter((r) => r.idempotencyKey === "reactive:ext-r1");
      expect(mine).toHaveLength(1);
      expect(mine[0]!.status).toBe("sent"); // nasce sent, nunca pending

      // O scheduler/resgate de órfãs JAMAIS a reivindica (at-most-once preservado).
      const claimed = await claimDueOutbox(50);
      expect(claimed.some((c) => c.id === mine[0]!.id)).toBe(false);

      // Webhook de status reconcilia a resposta do agente (delivered/read).
      expect(await reconcileOutboxStatus("ext-r1", "read")).toBe(true);
      const after = await withTenant((tx) => tx.select().from(outboxMessages));
      expect(after.find((r) => r.id === mine[0]!.id)!.status).toBe("read");
    });
  });

  it("ledger reativo: CATCH-UP quando o receipt chegou ANTES do insert (corrida)", async () => {
    // O webhook grava o status em `messages` primeiro; se o insert do ledger vier
    // depois, recordSentOutbox aplica o status já conhecido (não fica stale em 'sent').
    await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
      await tx`
        INSERT INTO messages (tenant_id, conversation_id, direction, type, content, status, external_message_id)
        VALUES (${tenantA}, ${convA}, 'outbound', 'text', '{"text":"resp"}'::jsonb, 'read', 'ext-race')`;
    });
    await runWithTenant({ tenantId: tenantA }, async () => {
      await recordSentOutbox({
        conversationId: convA,
        toPhone: "+5511999",
        payload: { text: "resp" },
        idempotencyKey: "reactive:ext-race",
        externalMessageId: "ext-race",
        billing: "service",
      });
      const rows = await withTenant((tx) => tx.select().from(outboxMessages));
      expect(rows.find((r) => r.idempotencyKey === "reactive:ext-race")!.status).toBe("read");
    });
  });

  it("linhas reativas NÃO consomem a quota da cadência nem o namespace proativo", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      // countOutboxSentSince (teto de frequência) ignora origin='reactive' — as
      // respostas do agente acima (+5511999) não bloqueiam o follow-up.
      const since = new Date(Date.now() - 60_000);
      const rows = await withTenant((tx) => tx.select().from(outboxMessages));
      const reactive = rows.filter((r) => r.origin === "reactive" && r.toPhone === "+5511999").length;
      expect(reactive).toBeGreaterThanOrEqual(2);
      const counted = await countOutboxSentSince("+5511999", since);
      const proactive = rows.filter((r) => r.origin === "proactive" && r.toPhone === "+5511999").length;
      expect(counted).toBe(proactive); // só proativas contam

      // Namespace 'reactive:' é reservado — enqueue proativo com o prefixo lança.
      await expect(enqueueOutbox({ ...tmpl("reactive:abuso") })).rejects.toThrow(/reservado/i);
    });
  });

  it("falha re-agenda até o máximo, depois 'failed'", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const { outboxId } = await enqueueOutbox({ ...tmpl("k3"), maxAttempts: 2 });
      await claimDueOutbox(10); // attempts=1
      await markOutboxFailed(outboxId, "boom", 1, 2, 0); // retry
      let row = (await withTenant((tx) => tx.select().from(outboxMessages))).find((r) => r.id === outboxId)!;
      expect(row.status).toBe("pending");
      await claimDueOutbox(10); // attempts=2
      await markOutboxFailed(outboxId, "boom", 2, 2, 0); // esgotou
      row = (await withTenant((tx) => tx.select().from(outboxMessages))).find((r) => r.id === outboxId)!;
      expect(row.status).toBe("failed");
    });
  });

  it("teto de frequência conta envios recentes", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const { outboxId } = await enqueueOutbox(tmpl("k4"));
      await claimDueOutbox(10);
      await markOutboxSent(outboxId, "ext-4");
      const n = await countOutboxSentSince("+5511999", new Date(Date.now() - 3600_000));
      expect(n).toBeGreaterThanOrEqual(1);
    });
  });

  it("cadência: arma e para; opt-out por contato", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      await armCadence(convA, 1, new Date(Date.now() + 1000));
      expect((await getCadenceState(convA))?.status).toBe("active");
      await stopCadence(convA, "engagement");
      expect((await getCadenceState(convA))?.status).toBe("stopped");

      expect(await isContactOptedOut(waA)).toBe(false);
      await markContactOptedOut(waA);
      expect(await isContactOptedOut(waA)).toBe(true);
    });
  });

  it("ISOLAMENTO: tenant B não vê o outbox do tenant A", async () => {
    await runWithTenant({ tenantId: tenantA }, () => enqueueOutbox(tmpl("k-iso")));
    const rowsB = await runWithTenant({ tenantId: tenantB }, () =>
      withTenant((tx) => tx.select().from(outboxMessages)),
    );
    expect(rowsB.every((r) => r.tenantId === tenantB)).toBe(true);
    expect(rowsB.some((r) => r.conversationId === convA)).toBe(false);
  });

  it("listTenantsWithDueOutbox (system): tenant com pending vencido entra; sem trabalho, não", async () => {
    // k-iso (teste acima) deixou um pending vencido no tenant A; B está vazio.
    const due = await listTenantsWithDueOutbox();
    expect(due).toContain(tenantA);
    expect(due).not.toContain(tenantB);
  });

  it("sweepStuckOutbox: 'sending' estagnado com attempts esgotados → 'failed' (conta no alerta)", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const { outboxId } = await enqueueOutbox({ ...tmpl("k-stuck"), maxAttempts: 1 });
      await claimDueOutbox(10); // attempts=1 (== max), status 'sending'
      // simula worker morto no meio do envio há >5min (linha órfã e INVISÍVEL:
      // o claim exige attempts < max; o alerta conta só 'failed').
      await withTenant((tx) =>
        tx
          .update(outboxMessages)
          .set({ status: "sending", updatedAt: new Date(Date.now() - 10 * 60_000) })
          .where(eq(outboxMessages.id, outboxId)),
      );
      // ANTES do sweep: a linha estagnada mantém o tenant na varredura system.
      expect(await listTenantsWithDueOutbox(300_000)).toContain(tenantA);
      const failedBefore = await countOutboxFailed();
      const swept = await sweepStuckOutbox(300_000);
      expect(swept).toBe(1);
      expect(await countOutboxFailed()).toBe(failedBefore + 1); // entra no alerta outbox_failed
      const row = (await withTenant((tx) => tx.select().from(outboxMessages))).find((r) => r.id === outboxId)!;
      expect(row.status).toBe("failed");
      // idempotente: segundo sweep não acha nada.
      expect(await sweepStuckOutbox(300_000)).toBe(0);
    });
  });

  it("sweepStuckOutbox NÃO toca 'sending' recente nem com tentativas restantes", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      // sending RECENTE com attempts esgotados → fora da janela de estagnação.
      const a = await enqueueOutbox({ ...tmpl("k-fresh"), maxAttempts: 1 });
      await claimDueOutbox(10);
      // sending ESTAGNADO mas com tentativas restantes → é órfã do claim, não do sweep.
      const b = await enqueueOutbox({ ...tmpl("k-retryable"), maxAttempts: 5 });
      await claimDueOutbox(10);
      await withTenant((tx) =>
        tx
          .update(outboxMessages)
          .set({ status: "sending", updatedAt: new Date(Date.now() - 10 * 60_000) })
          .where(eq(outboxMessages.id, b.outboxId)),
      );
      expect(await sweepStuckOutbox(300_000)).toBe(0);
      const rows = await withTenant((tx) => tx.select().from(outboxMessages));
      expect(rows.find((r) => r.id === a.outboxId)!.status).toBe("sending");
      expect(rows.find((r) => r.id === b.outboxId)!.status).toBe("sending");
      // ...e a órfã re-tentável segue reivindicável pelo claim normal.
      const reclaimed = await claimDueOutbox(10, 0);
      expect(reclaimed.some((c) => c.id === b.outboxId)).toBe(true);
    });
  });

  it("multi-conexão (0030): enqueue grava a conexão da CONVERSA; claim particiona por provedor", async () => {
    // Conexão + conversa cuja conversation_key segue a convenção ADR 0010
    // (`{provider}:{phone_number_id}:{wa_id}`) — a linha deve nascer roteada.
    const pnid = "pnid-" + randomUUID();
    const waId = "wa-" + randomUUID();
    const { connId, convId } = (await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
      const [cc] = await tx<{ id: string }[]>`
        INSERT INTO channel_connections (tenant_id, phone_number_id, provider, status, secret_ref)
        VALUES (${tenantA}, ${pnid}, 'cloud_api', 'active', 'whatsapp_token') RETURNING id`;
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id) VALUES (${tenantA}, ${waId}) RETURNING id`;
      const [cv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key)
        VALUES (${tenantA}, ${c!.id}, ${`cloud_api:${pnid}:${waId}`}) RETURNING id`;
      return { connId: cc!.id, convId: cv!.id };
    })) as { connId: string; convId: string };

    await runWithTenant({ tenantId: tenantA }, async () => {
      // Derivação direta pela conversa (usada no enqueue e no envio manual).
      const derived = await getConnectionForConversation(convId);
      expect(derived?.connectionId).toBe(connId);
      expect(derived?.provider).toBe("cloud_api");

      const { outboxId } = await enqueueOutbox({ ...tmpl("k-conn"), conversationId: convId });
      const row = (await withTenant((tx) => tx.select().from(outboxMessages))).find((r) => r.id === outboxId)!;
      expect(row.connectionId).toBe(connId); // roteada no ENQUEUE

      // Partição Baileys NÃO reivindica a linha Cloud (nem as sem vínculo).
      const baileysClaim = await claimDueOutbox(50, 0, { provider: "baileys", includeUnrouted: false });
      expect(baileysClaim.some((c) => c.id === outboxId)).toBe(false);

      // Partição Cloud reivindica e devolve a CONEXÃO da linha (roteamento explícito).
      const cloudClaim = await claimDueOutbox(50, 0, { provider: "cloud_api", includeUnrouted: false });
      const mine = cloudClaim.find((c) => c.id === outboxId);
      expect(mine).toBeTruthy();
      expect(mine!.connection).toMatchObject({ connectionId: connId, phoneNumberId: pnid, provider: "cloud_api", status: "active" });
    });
  });
});
