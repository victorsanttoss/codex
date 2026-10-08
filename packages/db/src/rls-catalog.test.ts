import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_SCOPED_TABLES } from "./schema";
import { makeMigrationClient } from "./client";

/**
 * Contrato #1 da revisão do Codex: RLS deny-by-default. Falha se alguma tabela
 * tenant-scoped não tiver RLS habilitado + FORÇADO + uma policy. É a rede de
 * segurança contra uma migration futura esquecer o isolamento. Usa a lista
 * canônica do schema — adicionar tabela tenant-scoped lá já a cobre aqui.
 */
const dbConfigured = Boolean(process.env.MIGRATION_DATABASE_URL);

const TENANT_SCOPED: readonly string[] = TENANT_SCOPED_TABLES;

describe.skipIf(!dbConfigured)("catálogo RLS", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  beforeAll(() => {
    mig = makeMigrationClient();
  });
  afterAll(() => mig.sql.end());

  it("toda tabela tenant-scoped tem RLS habilitado + FORCE", async () => {
    const rows = await mig.sql<{ relname: string; rls: boolean; force: boolean }[]>`
      SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force
      FROM pg_class
      WHERE relname = ANY(${TENANT_SCOPED}) AND relkind = 'r'`;
    expect(rows.length).toBe(TENANT_SCOPED.length);
    for (const r of rows) {
      expect(r.rls, `${r.relname}: ENABLE ROW LEVEL SECURITY`).toBe(true);
      expect(r.force, `${r.relname}: FORCE ROW LEVEL SECURITY`).toBe(true);
    }
  });

  it("toda tabela tenant-scoped tem ao menos uma policy", async () => {
    const rows = await mig.sql<{ tablename: string; n: number }[]>`
      SELECT tablename, count(*)::int AS n FROM pg_policies
      WHERE tablename = ANY(${TENANT_SCOPED}) GROUP BY tablename`;
    const byTable = new Map(rows.map((r) => [r.tablename, r.n]));
    for (const t of TENANT_SCOPED) {
      expect(byTable.get(t) ?? 0, `${t}: policy ausente`).toBeGreaterThanOrEqual(1);
    }
  });

  it("cada tabela isola por app.tenant_id (NULLIF) e nenhuma policy é blanket-permissiva", async () => {
    // Revisão Codex M7 #8: garante a EXPRESSÃO da policy, não só sua presença.
    // Invariante: (a) toda tabela tem AO MENOS UMA policy de isolamento por
    // app.tenant_id com NULLIF; (b) NENHUMA policy é blanket-permissiva (USING
    // vazio/`true`). Policies de SISTEMA gated (ex.: platform_audit em audit_log,
    // que só libera linhas SEM tenant sob app.platform_audit) são permitidas —
    // elas restringem, não expõem tenant cruzado.
    const rows = await mig.sql<{ tablename: string; policyname: string; qual: string | null; withCheck: string | null }[]>`
      SELECT tablename, policyname, qual, with_check AS "withCheck" FROM pg_policies
      WHERE tablename = ANY(${TENANT_SCOPED})`;
    const needle = `NULLIF(current_setting('app.tenant_id'::text, true)`;
    for (const t of TENANT_SCOPED) {
      const policies = rows.filter((r) => r.tablename === t);
      // (a) isolamento de tenant presente em ALGUMA policy (USING ou WITH CHECK).
      const isolates = policies.some((p) => (p.qual ?? "").includes(needle) || (p.withCheck ?? "").includes(needle));
      expect(isolates, `${t}: sem policy de isolamento por app.tenant_id`).toBe(true);
      // (b) nenhuma policy é blanket-permissiva (USING true expõe tudo).
      for (const p of policies) {
        const q = (p.qual ?? "").trim().toLowerCase();
        expect(q === "true", `${t}.${p.policyname}: policy permissiva (USING ${p.qual})`).toBe(false);
      }
    }
  });
});
