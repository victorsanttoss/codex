import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient, withSystem, withTenant } from "./client";
import { isMessageProcessed, markMessageProcessed } from "./messages";
import { recordUsage, aggregateUsage } from "./usage";
import { usageEvents } from "./schema";

// Testes de integração — exigem Postgres com as migrations aplicadas.
// Rodam apenas quando DATABASE_URL está presente (ambiente docker).
const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("isolamento multi-tenant (RLS)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('A', ${"a-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('B', ${"b-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("query SEM WHERE tenant_id retorna só os dados do tenant ativo", async () => {
    await runWithTenant({ tenantId: tenantA }, () =>
      recordUsage({ type: "llm_call", tokensIn: 10, tokensOut: 5 }),
    );
    await runWithTenant({ tenantId: tenantB }, () =>
      recordUsage({ type: "llm_call", tokensIn: 99, tokensOut: 99 }),
    );

    const rowsA = await runWithTenant({ tenantId: tenantA }, () =>
      withTenant((tx) => tx.select().from(usageEvents)), // SEM where!
    );
    expect(rowsA.length).toBe(1);
    expect(rowsA[0]!.tenantId).toBe(tenantA);
  });

  it("não enxerga linha de outro tenant nem buscando pelo id", async () => {
    const bEventId = await runWithTenant({ tenantId: tenantB }, () =>
      withTenant(async (tx) => {
        const [row] = await tx.select().from(usageEvents).limit(1);
        return row!.id;
      }),
    );
    const found = await runWithTenant({ tenantId: tenantA }, () =>
      withTenant((tx) => tx.select().from(usageEvents).where(eq(usageEvents.id, bEventId))),
    );
    expect(found).toHaveLength(0);
  });

  it("WITH CHECK impede inserir linha para outro tenant", async () => {
    await expect(
      runWithTenant({ tenantId: tenantA }, () =>
        withTenant((tx) =>
          tx.insert(usageEvents).values({ tenantId: tenantB, type: "fraude" }),
        ),
      ),
    ).rejects.toThrow();
  });

  it("caminho system (sem contexto) não vê linhas tenant-scoped (deny-by-default)", async () => {
    const rows = await withSystem((db) => db.select().from(usageEvents));
    expect(rows).toHaveLength(0);
  });

  it("dedup: só considera processada APÓS marcar (registro pós-sucesso)", async () => {
    const ext = randomUUID();
    // antes de processar: não consta (uma falha transitória deixa retry entrar).
    const before = await runWithTenant({ tenantId: tenantA }, () =>
      isMessageProcessed("fake", ext),
    );
    expect(before).toBe(false);
    await runWithTenant({ tenantId: tenantA }, () => markMessageProcessed("fake", ext, "conv-1"));
    const after = await runWithTenant({ tenantId: tenantA }, () =>
      isMessageProcessed("fake", ext),
    );
    expect(after).toBe(true);
    // marcar de novo (reentrega concorrente) é idempotente — não explode.
    await runWithTenant({ tenantId: tenantA }, () => markMessageProcessed("fake", ext, "conv-1"));
  });

  it("dedup é POR TENANT: mesmo external_message_id em tenants distintos não colide", async () => {
    const ext = randomUUID();
    await runWithTenant({ tenantId: tenantA }, () => markMessageProcessed("fake", ext, "conv-x"));
    const inB = await runWithTenant({ tenantId: tenantB }, () =>
      isMessageProcessed("fake", ext),
    );
    expect(inB).toBe(false); // não é tratado como duplicado do tenant A
  });

  it("metering: agregação por tenant retorna valores corretos", async () => {
    const agg = await runWithTenant({ tenantId: tenantA }, () =>
      aggregateUsage(new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000)),
    );
    // tenant A teve 1 evento llm_call (10/5) neste teste-suite
    expect(agg.events).toBeGreaterThanOrEqual(1);
    expect(agg.tokensIn).toBeGreaterThanOrEqual(10);
  });

  it("app_user não consegue burlar RLS via SQL direto sem contexto", async () => {
    // sem set_config app.tenant_id, a policy esconde tudo
    const rows = await withSystem((db) => db.execute(sql`select count(*)::int as n from usage_events`));
    // count agrega sobre linhas visíveis (nenhuma) => 0
    const n = (rows as unknown as Array<{ n: number }>)[0]?.n ?? -1;
    expect(n).toBe(0);
  });
});
