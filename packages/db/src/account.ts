import { sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";

/** Leitura de conta (M14): equipe e compliance do tenant ativo (RLS). */

export interface MemberRow {
  userId: string;
  email: string;
  role: string;
}

/** Membros do tenant ativo (memberships × users). */
export async function listTenantMembers(): Promise<MemberRow[]> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    return (await tx.execute(sql`
      SELECT m.user_id AS "userId", u.email, m.role
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = ${tenantId}
      ORDER BY m.role, u.email
    `)) as unknown as MemberRow[];
  });
}

export interface ComplianceSummary {
  optedOut: number;
  contacts: number;
}

/** Resumo de compliance: opt-outs e total de contatos. */
export async function complianceSummary(): Promise<ComplianceSummary> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT count(*) FILTER (WHERE opted_out)::int AS "optedOut", count(*)::int AS contacts
      FROM contacts WHERE tenant_id = ${tenantId}
    `)) as unknown as Array<{ optedOut: number; contacts: number }>;
    return { optedOut: rows[0]?.optedOut ?? 0, contacts: rows[0]?.contacts ?? 0 };
  });
}
