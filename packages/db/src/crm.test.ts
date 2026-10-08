import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient, withTenant } from "./client";
import {
  addActivity,
  createAppointment,
  createNotification,
  getCrmSync,
  upsertCrmContact,
  upsertCrmSync,
  upsertOpportunity,
} from "./crm";
import { crmContacts, opportunities } from "./schema";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("CRM built-in + sync (RLS)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";
  let convA = "";

  async function seedConversation(tenantId: string): Promise<string> {
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id) VALUES (${tenantId}, ${"wa-" + randomUUID()}) RETURNING id`;
      const [conv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key)
        VALUES (${tenantId}, ${c!.id}, ${"ck-" + randomUUID()}) RETURNING id`;
      return conv!.id;
    }) as Promise<string>;
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('CRM-A', ${"crma-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('CRM-B', ${"crmb-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
    convA = await seedConversation(tenantA);
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("upsert de contato/oportunidade é idempotente (não duplica)", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const c1 = await upsertCrmContact({ phone: "+5511777", name: "Ana", fields: { necessidade: "CRM" } });
      const c2 = await upsertCrmContact({ phone: "+5511777", name: "Ana M.", fields: { orcamento: 5000 } });
      expect(c1.contactId).toBe(c2.contactId); // mesmo telefone → mesmo contato

      const o1 = await upsertOpportunity({ contactId: c1.contactId, title: "Lead", stage: "qualified", status: "open", score: 80 });
      const o2 = await upsertOpportunity({ contactId: c1.contactId, title: "Lead", stage: "qualified", status: "open", score: 90 });
      expect(o1.opportunityId).toBe(o2.opportunityId);

      const rows = await withTenant((tx) => tx.select().from(crmContacts));
      expect(rows.filter((r) => r.phone === "+5511777")).toHaveLength(1);
      const opps = await withTenant((tx) => tx.select().from(opportunities));
      expect(opps.filter((o) => o.contactId === c1.contactId)).toHaveLength(1);
      // fields foram MESCLADOS
      expect(rows.find((r) => r.phone === "+5511777")!.fields).toMatchObject({ necessidade: "CRM", orcamento: 5000 });
      await addActivity({ contactId: c1.contactId, kind: "handoff", body: "lead quente" });
    });
  });

  it("agendamento e notificação são idempotentes por chave", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const a1 = await createAppointment({ idempotencyKey: "appt-1", details: "demo", conversationId: convA });
      const a2 = await createAppointment({ idempotencyKey: "appt-1", details: "demo", conversationId: convA });
      expect(a1.created).toBe(true);
      expect(a2.created).toBe(false);
      expect(a1.appointmentId).toBe(a2.appointmentId);

      expect((await createNotification({ idempotencyKey: "n-1", kind: "handoff", title: "x", body: "y" })).created).toBe(true);
      expect((await createNotification({ idempotencyKey: "n-1", kind: "handoff", title: "x", body: "y" })).created).toBe(false);
    });
  });

  it("mapa de sync: upsert idempotente por conversa", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      await upsertCrmSync({ conversationId: convA, crmAdapter: "builtin", contactExternalId: "c1", status: "synced" });
      await upsertCrmSync({ conversationId: convA, crmAdapter: "builtin", contactExternalId: "c1", opportunityExternalId: "o1", status: "synced" });
      const row = await getCrmSync(convA);
      expect(row).toMatchObject({ status: "synced", contactExternalId: "c1", opportunityExternalId: "o1" });
    });
  });

  it("ISOLAMENTO: tenant B não vê contatos do tenant A", async () => {
    await runWithTenant({ tenantId: tenantA }, () => upsertCrmContact({ phone: "+5511777" }));
    const rowsB = await runWithTenant({ tenantId: tenantB }, () =>
      withTenant((tx) => tx.select().from(crmContacts)),
    );
    expect(rowsB.every((r) => r.tenantId === tenantB)).toBe(true);
    expect(rowsB.some((r) => r.phone === "+5511777")).toBe(false);
  });
});
