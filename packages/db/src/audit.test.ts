import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertAuditLog } from "./audit";
import { closeDb, makeMigrationClient } from "./client";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

/**
 * Auditoria de PLATAFORMA sob RLS. `audit_log` é FORCE RLS: a policy de tenant
 * exige tenant_id = app.tenant_id, o que bloquearia eventos de plataforma (NULL).
 * A migration 0026 adiciona a policy `platform_audit` (linhas SEM tenant sob a
 * flag app.platform_audit). Estes testes provam que o INSERT passa pela role `app`
 * (NOBYPASSRLS) e que a linha fica isolada sem a flag.
 */
describe.skipIf(!dbConfigured)("audit_log — auditoria de plataforma (RLS)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  beforeAll(() => { mig = makeMigrationClient(); });
  afterAll(async () => { await mig.sql.end(); await closeDb(); });

  async function purge(target: string): Promise<void> {
    await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.platform_audit', 'on', true)`;
      await tx`DELETE FROM audit_log WHERE target = ${target}`;
    });
  }

  it("insere evento de plataforma (tenant_id NULL) — a role app passa pelo WITH CHECK", async () => {
    const target = "cand-" + randomUUID();
    await expect(
      insertAuditLog({ actor: "staff-x", action: "curation.approve", target, metadata: { nicheId: "n1" } }),
    ).resolves.toBeUndefined();

    const rows = await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.platform_audit', 'on', true)`;
      return tx<{ actor: string; tenant_id: string | null }[]>`
        SELECT actor, tenant_id FROM audit_log WHERE target = ${target}`;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("staff-x");
    expect(rows[0]!.tenant_id).toBeNull();
    await purge(target);
  });

  it("evento de plataforma é INVISÍVEL sem a flag (isolamento mantido)", async () => {
    const target = "cand-" + randomUUID();
    await insertAuditLog({ actor: "staff-y", action: "curation.reject", target });
    // Sem app.platform_audit setado, nem o owner (FORCE RLS) enxerga a linha.
    const rows = await mig.sql`SELECT 1 FROM audit_log WHERE target = ${target}`;
    expect(rows).toHaveLength(0);
    await purge(target);
  });
});
