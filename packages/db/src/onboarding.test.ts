import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient } from "./client";
import { activateOnboarding, getOnboarding, saveOnboarding } from "./onboarding";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("M14 — onboarding (db)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('A', ${"a-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('B', ${"b-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
  });
  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("default na 1ª leitura (step 1, payload vazio)", async () => {
    const o = await runWithTenant({ tenantId: tenantA }, () => getOnboarding());
    expect(o).toEqual({ step: 1, payload: {}, activatedAt: null });
  });

  it("autosave MESCLA o payload e avança o passo (não regride)", async () => {
    await runWithTenant({ tenantId: tenantA }, () => saveOnboarding(2, { niche: "solar" }));
    await runWithTenant({ tenantId: tenantA }, () => saveOnboarding(3, { tone: "consultivo" }));
    const o = await runWithTenant({ tenantId: tenantA }, () => getOnboarding());
    expect(o.step).toBe(3);
    expect(o.payload).toMatchObject({ niche: "solar", tone: "consultivo" });
    // salvar um passo MENOR não regride o step
    await runWithTenant({ tenantId: tenantA }, () => saveOnboarding(1, { products: ["Instalação"] }));
    expect((await runWithTenant({ tenantId: tenantA }, () => getOnboarding())).step).toBe(3);
  });

  it("RLS: tenant B não enxerga o onboarding de A", async () => {
    const o = await runWithTenant({ tenantId: tenantB }, () => getOnboarding());
    expect(o).toEqual({ step: 1, payload: {}, activatedAt: null });
  });

  it("activate marca a SDR ao vivo (activatedAt)", async () => {
    await runWithTenant({ tenantId: tenantA }, () => activateOnboarding());
    const o = await runWithTenant({ tenantId: tenantA }, () => getOnboarding());
    expect(o.activatedAt).not.toBeNull();
    expect(o.step).toBe(10); // última etapa (fork imob: Corretores parceiros entrou como 10ª)
  });
});
