import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient, withTenant } from "./client";
import {
  applyLeadDecision,
  claimAgentResponse,
  getLeadProfile,
  getOrCreateLeadProfile,
  mergeLeadFields,
} from "./agent";
import { leadProfiles } from "./schema";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("agente: lead/funil + idempotência (RLS)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";
  let convA = "";
  let convB = "";

  async function seedConversation(tenantId: string): Promise<string> {
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [contact] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id) VALUES (${tenantId}, ${"wa-" + randomUUID()}) RETURNING id`;
      const [conv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key)
        VALUES (${tenantId}, ${contact!.id}, ${"ck-" + randomUUID()}) RETURNING id`;
      return conv!.id;
    }) as Promise<string>;
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('AG-A', ${"aga-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('AG-B', ${"agb-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
    convA = await seedConversation(tenantA);
    convB = await seedConversation(tenantB);
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("getOrCreate + merge de campos + decisão", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const lead = await getOrCreateLeadProfile(convA);
      expect(lead.status).toBe("new");
      await mergeLeadFields(convA, { budget: 5000 });
      const merged = await mergeLeadFields(convA, { authority: "decisor" });
      expect(merged).toMatchObject({ budget: 5000, authority: "decisor" });
      await applyLeadDecision(convA, { stage: "qualified", status: "qualified", score: 80 });
      const after = await getLeadProfile(convA);
      expect(after).toMatchObject({ status: "qualified", score: 80, stage: "qualified" });
    });
  });

  it("idempotência de envio: a MESMA chave só é reivindicada uma vez", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const key = `conv:${convA}:msg-1:0`;
      expect(await claimAgentResponse(key)).toBe(true);
      expect(await claimAgentResponse(key)).toBe(false); // 2ª vez (retry) → não envia
    });
  });

  it("ISOLAMENTO: tenant B não vê o lead do tenant A", async () => {
    await runWithTenant({ tenantId: tenantA }, () => getOrCreateLeadProfile(convA));
    const rowsB = await runWithTenant({ tenantId: tenantB }, () =>
      withTenant((tx) => tx.select().from(leadProfiles)),
    );
    expect(rowsB.every((r) => r.tenantId === tenantB)).toBe(true);
    expect(rowsB.some((r) => r.conversationId === convA)).toBe(false);
  });

  it("idempotência é POR TENANT: mesma claim_key em tenants distintos não colide", async () => {
    const key = "mesma-chave";
    const inA = await runWithTenant({ tenantId: tenantA }, () => claimAgentResponse(key));
    const inB = await runWithTenant({ tenantId: tenantB }, () => claimAgentResponse(key));
    expect(inA).toBe(true);
    expect(inB).toBe(true);
    void convB;
  });
});
