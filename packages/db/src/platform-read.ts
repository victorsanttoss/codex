import { sql } from "drizzle-orm";
import { runWithTenant } from "@sdr/core";
import { getDb, withTenant } from "./client";
import { listActiveTenantIds } from "./channel-connections";

/**
 * Leitura da ÁREA DA PLATAFORMA (staff, M14). Caminho SYSTEM, cross-tenant — usado
 * SÓ atrás do PlatformGuard (token de plataforma). `tenants`/`niches` não são
 * RLS-tenant (são dados de plataforma).
 */

export interface PlatformTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
}

export async function listAllTenants(): Promise<PlatformTenant[]> {
  const rows = (await getDb().execute(sql`
    SELECT id, name, slug, status, created_at AS "createdAt" FROM tenants ORDER BY created_at DESC
  `)) as unknown as PlatformTenant[];
  return rows;
}

export interface PlatformNiche {
  id: string;
  name: string;
  vertical: string;
  motion: string;
  guidance: string | null;
  status: string;
}

export async function listNiches(): Promise<PlatformNiche[]> {
  return (await getDb().execute(sql`
    SELECT id, name, vertical, motion, guidance, status FROM niches ORDER BY name
  `)) as unknown as PlatformNiche[];
}

export interface PlatformOverview {
  tenants: number;
  activeTenants: number;
  niches: number;
}

/** KPIs da visão global (contagens cross-tenant; curadoria é por-nicho na tela). */
export async function platformOverview(): Promise<PlatformOverview> {
  const db = getDb();
  const t = (await db.execute(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='active')::int AS active FROM tenants`)) as unknown as Array<{ total: number; active: number }>;
  const n = (await db.execute(sql`SELECT count(*)::int AS n FROM niches`)) as unknown as Array<{ n: number }>;
  return { tenants: t[0]?.total ?? 0, activeTenants: t[0]?.active ?? 0, niches: n[0]?.n ?? 0 };
}

// ── Templates HSM (cross-tenant) ──────────────────────────────
export interface PlatformTemplate {
  tenantId: string;
  name: string;
  category: string;
  languageCode: string;
  status: string;
}
export interface PlatformTemplatesView {
  templates: PlatformTemplate[];
  counts: { approved: number; pending: number; rejected: number };
}

/**
 * Templates HSM de TODOS os tenants. `message_templates` é RLS FORCE por tenant —
 * então NÃO dá para um SELECT global; iteramos os tenants ativos sob `withTenant`
 * (respeitando a RLS) e agregamos. Eventos raros (tela de staff); custo aceitável.
 */
export async function listPlatformTemplates(): Promise<PlatformTemplatesView> {
  const out: PlatformTemplate[] = [];
  for (const tenantId of await listActiveTenantIds()) {
    const rows = await runWithTenant({ tenantId }, () =>
      withTenant(async (tx) =>
        (await tx.execute(sql`
          SELECT name, category, language_code AS "languageCode", status
          FROM message_templates WHERE tenant_id = ${tenantId} ORDER BY name
        `)) as unknown as Array<{ name: string; category: string; languageCode: string; status: string }>,
      ),
    );
    for (const r of rows) out.push({ tenantId, ...r });
  }
  const counts = { approved: 0, pending: 0, rejected: 0 };
  for (const t of out) {
    if (t.status === "approved") counts.approved++;
    else if (t.status === "rejected") counts.rejected++;
    else counts.pending++;
  }
  return { templates: out, counts };
}

// ── Staff ─────────────────────────────────────────────────────
export interface StaffRow {
  id: string;
  email: string;
  name: string;
  role: string;
}
export async function listPlatformStaff(): Promise<StaffRow[]> {
  return (await getDb().execute(sql`
    SELECT id, email, name, role FROM platform_staff ORDER BY role, email
  `)) as unknown as StaffRow[];
}

/**
 * Identidade de staff por TOKEN (M14). `tokenHash` = sha256 hex do token pessoal.
 * Caminho SYSTEM (platform_staff não é tenant-scoped). Retorna a linha do staff
 * quando o hash bate (índice único), senão null. O token nunca é persistido cru.
 */
export async function findStaffByTokenHash(tokenHash: string): Promise<StaffRow | null> {
  const rows = (await getDb().execute(sql`
    SELECT id, email, name, role FROM platform_staff WHERE token_hash = ${tokenHash} LIMIT 1
  `)) as unknown as StaffRow[];
  return rows[0] ?? null;
}

/** Grava/rotaciona o hash do token de um staff (por email). Provisionamento/seed. */
export async function setStaffTokenHash(email: string, tokenHash: string): Promise<void> {
  assertSha256Hex(tokenHash);
  await getDb().execute(sql`UPDATE platform_staff SET token_hash = ${tokenHash} WHERE email = ${email}`);
}

/** Rotaciona o hash do token por ID (gestão pela UI). Retorna false se não existe. */
export async function setStaffTokenHashById(id: string, tokenHash: string): Promise<boolean> {
  assertSha256Hex(tokenHash);
  const rows = (await getDb().execute(sql`
    UPDATE platform_staff SET token_hash = ${tokenHash} WHERE id = ${id} RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

/** Cria um membro de staff (gestão pela UI). Falha se o email já existe. */
export async function createPlatformStaff(input: {
  email: string;
  name: string;
  role: string;
  tokenHash: string;
}): Promise<StaffRow> {
  assertSha256Hex(input.tokenHash);
  const rows = (await getDb().execute(sql`
    INSERT INTO platform_staff (email, name, role, token_hash)
    VALUES (${input.email}, ${input.name}, ${input.role}, ${input.tokenHash})
    RETURNING id, email, name, role
  `)) as unknown as StaffRow[];
  return rows[0]!;
}

/** Remove um membro de staff. Retorna false se não existia. */
export async function deletePlatformStaff(id: string): Promise<boolean> {
  const rows = (await getDb().execute(sql`
    DELETE FROM platform_staff WHERE id = ${id} RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

function assertSha256Hex(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("tokenHash deve ser sha256 hex (64 chars).");
}
