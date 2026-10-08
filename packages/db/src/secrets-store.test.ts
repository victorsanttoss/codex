import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient } from "./client";
import { clearTenantSecretsCache, makeCipherFromEnv, TenantSecretsStore } from "./secrets-store";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("TenantSecretsStore — cache TTL in-process", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";
  const store = new TenantSecretsStore(makeCipherFromEnv());

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('SEC', ${"sec-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await closeDb();
    clearTenantSecretsCache(); // não vazar cache p/ outras suítes (fork único)
  });

  it("get serve do CACHE dentro do TTL (não relê/decifra do banco a cada chamada)", async () => {
    await runWithTenant({ tenantId }, () => store.put("llm_api_key", "sk-original"));
    expect(await runWithTenant({ tenantId }, () => store.get("llm_api_key"))).toBe("sk-original");
    // muda a linha POR FORA do store (outra instância teria feito isso): dentro
    // do TTL, o processo local continua servindo o valor cacheado. (Sob FORCE
    // RLS até o owner precisa do app.tenant_id p/ enxergar/deletar a linha.)
    await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`DELETE FROM tenant_secrets WHERE tenant_id = ${tenantId} AND kind = 'llm_api_key'`;
    });
    expect(await runWithTenant({ tenantId }, () => store.get("llm_api_key"))).toBe("sk-original");
    // limpando o cache (equivale ao TTL expirar), o banco volta a mandar.
    clearTenantSecretsCache();
    expect(await runWithTenant({ tenantId }, () => store.get("llm_api_key"))).toBeNull();
  });

  it("put é WRITE-THROUGH: o novo valor vale imediatamente", async () => {
    await runWithTenant({ tenantId }, () => store.put("whatsapp_token", "tok-1"));
    expect(await runWithTenant({ tenantId }, () => store.get("whatsapp_token"))).toBe("tok-1");
    await runWithTenant({ tenantId }, () => store.put("whatsapp_token", "tok-2"));
    expect(await runWithTenant({ tenantId }, () => store.get("whatsapp_token"))).toBe("tok-2");
  });

  it("delete INVALIDA o cache: get volta null na hora", async () => {
    await runWithTenant({ tenantId }, () => store.put("embedding_api_key", "emb-1"));
    expect(await runWithTenant({ tenantId }, () => store.get("embedding_api_key"))).toBe("emb-1");
    await runWithTenant({ tenantId }, () => store.delete("embedding_api_key"));
    expect(await runWithTenant({ tenantId }, () => store.get("embedding_api_key"))).toBeNull();
  });

  it("cacheia AUSÊNCIA (null) — fallback de chave não martela o banco", async () => {
    const miss = await runWithTenant({ tenantId }, () => store.get("crm_api_key"));
    expect(miss).toBeNull();
    // put subsequente substitui o null cacheado (write-through).
    await runWithTenant({ tenantId }, () => store.put("crm_api_key", "crm-1"));
    expect(await runWithTenant({ tenantId }, () => store.get("crm_api_key"))).toBe("crm-1");
  });
});
