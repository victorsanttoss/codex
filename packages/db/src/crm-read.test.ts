import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient } from "./client";
import { recordInboundMessage } from "./conversations";
import { applyLeadDecision, getOrCreateLeadProfile } from "./agent";
import { isHumanTakeover, leadFunnel, listConversations, listLeads, setHumanTakeover } from "./crm-read";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("M14 — APIs de leitura do painel (db)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";
  let convA = "";

  async function seedLead(tenantId: string, name: string, status: string, score: number): Promise<string> {
    return runWithTenant({ tenantId }, async () => {
      const rec = await recordInboundMessage({
        conversationKey: `cloud_api:pn:${randomUUID().slice(0, 6)}`,
        waId: "5511" + randomUUID().slice(0, 7),
        profileName: name,
        externalMessageId: "wamid." + randomUUID(),
        type: "text",
        content: { text: "olá" },
      });
      await getOrCreateLeadProfile(rec.conversationId);
      await applyLeadDecision(rec.conversationId, { status, stage: status, score });
      return rec.conversationId;
    });
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('A', ${"a-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('B', ${"b-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
    convA = await seedLead(tenantA, "Fulano Qualificado", "qualified", 92);
    await seedLead(tenantA, "Beltrano Novo", "new", 10);
    await seedLead(tenantB, "Outro Tenant", "qualified", 80);
  });
  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("listLeads: paginado, filtra por status, isolado por tenant", async () => {
    const all = await runWithTenant({ tenantId: tenantA }, () => listLeads({ limit: 10 }));
    expect(all.total).toBe(2);
    expect(all.rows.every((r) => r.name !== "Outro Tenant")).toBe(true);
    const qualified = await runWithTenant({ tenantId: tenantA }, () => listLeads({ status: "qualified" }));
    expect(qualified.total).toBe(1);
    expect(qualified.rows[0]!.score).toBe(92);
  });

  it("listLeads: busca por nome", async () => {
    const r = await runWithTenant({ tenantId: tenantA }, () => listLeads({ search: "Beltrano" }));
    expect(r.total).toBe(1);
    expect(r.rows[0]!.name).toBe("Beltrano Novo");
  });

  it("leadFunnel: conta por status (isolado)", async () => {
    const f = await runWithTenant({ tenantId: tenantA }, () => leadFunnel());
    expect(f.qualified).toBe(1);
    expect(f.new).toBe(1);
  });

  it("RLS: tenant B só vê o seu lead", async () => {
    const r = await runWithTenant({ tenantId: tenantB }, () => listLeads({}));
    expect(r.total).toBe(1);
    expect(r.rows[0]!.name).toBe("Outro Tenant");
  });

  it("listConversations + assumir conversa (takeover)", async () => {
    const before = await runWithTenant({ tenantId: tenantA }, () => listConversations({}));
    expect(before.total).toBe(2);
    expect(await runWithTenant({ tenantId: tenantA }, () => isHumanTakeover(convA))).toBe(false);
    await runWithTenant({ tenantId: tenantA }, () => setHumanTakeover(convA, true));
    expect(await runWithTenant({ tenantId: tenantA }, () => isHumanTakeover(convA))).toBe(true);
    const conv = (await runWithTenant({ tenantId: tenantA }, () => listConversations({}))).rows.find((c) => c.conversationId === convA);
    expect(conv?.humanTakeover).toBe(true);
  });

  it("takeover NÃO cruza tenant (B não altera conversa de A)", async () => {
    const ok = await runWithTenant({ tenantId: tenantB }, () => setHumanTakeover(convA, false));
    expect(ok).toBe(false); // fora do tenant → nada atualizado
    expect(await runWithTenant({ tenantId: tenantA }, () => isHumanTakeover(convA))).toBe(true);
  });
});
