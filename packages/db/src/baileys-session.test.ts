import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient } from "./client";
import { BaileysSessionStore } from "./baileys-session-store";
import {
  getActiveConnectionForTenant,
  listActiveConnectionsByProvider,
  upsertChannelConnection,
} from "./channel-connections";
import { makeCipherFromEnv } from "./secrets-store";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("M13 — sessão Baileys + conexão por provedor (db)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";
  const store = new BaileysSessionStore(makeCipherFromEnv());
  const pnA = "55119" + randomUUID().slice(0, 8);

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

  it("save/get cifrado: reabre o blob (reconectar sem novo QR)", async () => {
    const blob = JSON.stringify({ creds: { me: "x" }, keys: { "pre-key-1": "abc" } });
    await runWithTenant({ tenantId: tenantA }, () => store.save(pnA, blob));
    const got = await runWithTenant({ tenantId: tenantA }, () => store.get(pnA));
    expect(got).toBe(blob);
  });

  it("idempotente: save de novo substitui (upsert), get retorna o último", async () => {
    await runWithTenant({ tenantId: tenantA }, () => store.save(pnA, "v2"));
    expect(await runWithTenant({ tenantId: tenantA }, () => store.get(pnA))).toBe("v2");
  });

  it("RLS: tenant B não enxerga a sessão do tenant A", async () => {
    expect(await runWithTenant({ tenantId: tenantB }, () => store.get(pnA))).toBeNull();
  });

  it("AAD: blob de A não descriptografa no contexto de B (mesmo número)", async () => {
    // injeta o ciphertext de A na linha de B e prova que o AAD (tenant+phone) barra.
    const rows = (await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
      return tx<{ ciphertext: string; nonce: string; key_version: number }[]>`
        SELECT ciphertext, nonce, key_version FROM baileys_sessions WHERE tenant_id = ${tenantA} AND phone_number_id = ${pnA}`;
    })) as unknown as { ciphertext: string; nonce: string; key_version: number }[];
    await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
      await tx`INSERT INTO baileys_sessions (tenant_id, phone_number_id, ciphertext, nonce, key_version)
        VALUES (${tenantB}, ${pnA}, ${rows[0]!.ciphertext}, ${rows[0]!.nonce}, ${rows[0]!.key_version})`;
    });
    await expect(runWithTenant({ tenantId: tenantB }, () => store.get(pnA))).rejects.toThrow();
  });

  it("clear apaga a sessão (logout → exige novo pareamento)", async () => {
    await runWithTenant({ tenantId: tenantA }, () => store.clear(pnA));
    expect(await runWithTenant({ tenantId: tenantA }, () => store.get(pnA))).toBeNull();
  });

  it("conexão por provedor: getActive traz provider; lista por provedor (system)", async () => {
    await runWithTenant({ tenantId: tenantA }, () =>
      upsertChannelConnection({ phoneNumberId: pnA, displayPhone: "+5511", provider: "baileys" }),
    );
    const active = await runWithTenant({ tenantId: tenantA }, () => getActiveConnectionForTenant());
    expect(active?.provider).toBe("baileys");
    const baileys = await listActiveConnectionsByProvider("baileys");
    expect(baileys.some((c) => c.phoneNumberId === pnA && c.tenantId === tenantA)).toBe(true);
    const cloud = await listActiveConnectionsByProvider("cloud_api");
    expect(cloud.some((c) => c.phoneNumberId === pnA)).toBe(false);
  });
});
