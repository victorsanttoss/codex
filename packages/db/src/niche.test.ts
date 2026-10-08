import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient, withTenant } from "./client";
import {
  assignTenantNiche,
  createCandidate,
  createNiche,
  getNicheConfig,
  getTenantNicheId,
  insertNicheKnowledge,
  listCandidates,
  retireNicheKnowledge,
  searchNicheKnowledge,
  upsertNicheConfig,
} from "./niche";
import { KNOWLEDGE_VECTOR_DIM, curationCandidates, nicheKnowledge } from "./schema";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

function basis(i: number): number[] {
  const v = new Array<number>(KNOWLEDGE_VECTOR_DIM).fill(0);
  v[i] = 1;
  return v;
}

describe.skipIf(!dbConfigured)("camada de nicho + curadoria (RLS por nicho)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";
  let nicheA = "";
  let nicheB = "";

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('NA', ${"na-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('NB', ${"nb-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
    nicheA = (await createNiche({ name: "niche-A-" + randomUUID(), vertical: "solar", motion: "inbound" })).id;
    nicheB = (await createNiche({ name: "niche-B-" + randomUUID(), vertical: "saude", motion: "outbound" })).id;
    await runWithTenant({ tenantId: tenantA }, () => assignTenantNiche(nicheA));
    await runWithTenant({ tenantId: tenantB }, () => assignTenantNiche(nicheB));
    // conhecimento em cada nicho (curadoria)
    await insertNicheKnowledge(nicheA, "objeção de preço em solar: foque no payback", basis(0), "manual");
    await insertNicheKnowledge(nicheB, "agendamento em saúde exige confirmação", basis(1), "manual");
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql`DELETE FROM niches WHERE id in (${nicheA}, ${nicheB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("tenant resolve o próprio nicho (server-side)", async () => {
    expect(await runWithTenant({ tenantId: tenantA }, () => getTenantNicheId())).toBe(nicheA);
    expect(await runWithTenant({ tenantId: tenantB }, () => getTenantNicheId())).toBe(nicheB);
  });

  it("busca de nicho retorna só o conhecimento DO nicho", async () => {
    const hits = await searchNicheKnowledge(nicheA, basis(0), 5, -1);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.content).toContain("solar");
  });

  it("ISOLAMENTO CRÍTICO: nicho A não enxerga conhecimento do nicho B", async () => {
    const fromA = await searchNicheKnowledge(nicheA, basis(1), 10, -1); // query do tema de B
    expect(fromA.some((h) => h.content.includes("saúde"))).toBe(false);
    // e via SELECT direto sob app.niche_id de A não há linhas de B
    const { withNiche } = await import("./client");
    const rows = await withNiche(nicheA, (tx) => tx.select().from(nicheKnowledge));
    expect(rows.every((r) => r.nicheId === nicheA)).toBe(true);
  });

  it("CANDIDATOS são invisíveis ao tenant (caminho withTenant não lê)", async () => {
    await createCandidate(nicheA, { candidateType: "faq", content: "padrão genérico", redactionChecked: true });
    // tenant (withTenant, sem app.curation) NÃO vê candidatos
    const seenByTenant = await runWithTenant({ tenantId: tenantA }, () =>
      withTenant((tx) => tx.select().from(curationCandidates)),
    );
    expect(seenByTenant).toHaveLength(0);
    // curador (withCuration) vê
    const seenByCurator = await listCandidates(nicheA, "pending");
    expect(seenByCurator.length).toBeGreaterThanOrEqual(1);
  });

  it("tenant NÃO consegue escrever niche_knowledge (WITH CHECK exige curadoria)", async () => {
    const { withNiche } = await import("./client");
    await expect(
      withNiche(nicheA, (tx) =>
        tx.insert(nicheKnowledge).values({ nicheId: nicheA, content: "hack", embedding: basis(2), version: 99 }),
      ),
    ).rejects.toThrow(); // policy WITH CHECK barra (sem app.curation)
  });

  it("niche_configs: schema por nicho isolado (A não lê config de B)", async () => {
    await upsertNicheConfig(nicheA, { qualification: { fields: [{ key: "conta_luz", type: "number" }], qualifyAtScore: 1 }, kitVersion: "1.0.0" });
    const cfgA = await getNicheConfig(nicheA);
    expect(cfgA?.kitVersion).toBe("1.0.0");
    expect((cfgA?.qualification as { fields: unknown[] }).fields).toHaveLength(1);
    // nicho B não tem config própria (não vê a de A)
    expect(await getNicheConfig(nicheB)).toBeNull();
  });

  it("tenant NÃO consegue APAGAR niche_knowledge (write só na curadoria)", async () => {
    const { withNiche } = await import("./client");
    const { eq } = await import("drizzle-orm");
    await expect(
      withNiche(nicheA, (tx) => tx.delete(nicheKnowledge).where(eq(nicheKnowledge.nicheId, nicheA))),
    ).resolves.toBeDefined(); // não lança, mas...
    // a policy de SELECT some os dados? não — confirmamos que NADA foi apagado:
    const still = await searchNicheKnowledge(nicheA, basis(0), 5, -1);
    expect(still.length).toBeGreaterThanOrEqual(1); // delete sem curadoria não afeta linhas
  });

  it("versionamento + rollback (retire)", async () => {
    const k = await insertNicheKnowledge(nicheA, "novo padrão", basis(3), "manual");
    let active = await searchNicheKnowledge(nicheA, basis(3), 5, 0.5);
    expect(active.some((h) => h.id === k.id)).toBe(true);
    await retireNicheKnowledge(nicheA, k.id);
    active = await searchNicheKnowledge(nicheA, basis(3), 5, 0.5);
    expect(active.some((h) => h.id === k.id)).toBe(false); // aposentado some da busca
  });
});
