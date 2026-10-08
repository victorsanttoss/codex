import argon2 from "argon2";
import { sql } from "drizzle-orm";
import { getDb } from "./client";
import { memberships, tenants, users } from "./schema";

// ── Provisionamento de EMPREENDIMENTO (vertical imobiliária) ─────────────────
// Chamado pelo endpoint de plataforma (staff) quando a Central cria um
// empreendimento novo: tenant + owner + membership numa transação. O kit/nicho
// é atribuído pelo caller (camada API, que conhece o kit da vertical).

export interface ProvisionImobTenantInput {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerPassword: string;
}

export interface ProvisionImobTenantResult {
  tenantId: string;
  userId: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function provisionImobTenant(
  input: ProvisionImobTenantInput,
): Promise<ProvisionImobTenantResult> {
  const name = input.name?.trim();
  const slug = input.slug?.trim().toLowerCase();
  const email = input.ownerEmail?.trim().toLowerCase();
  if (!name) throw new Error("Informe o nome do empreendimento.");
  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error("Slug inválido (minúsculas, números e hífens; 3-48 caracteres).");
  }
  if (!email || !EMAIL_RE.test(email)) throw new Error("E-mail do responsável inválido.");
  if (!input.ownerPassword || input.ownerPassword.length < 8) {
    throw new Error("Senha do responsável precisa de pelo menos 8 caracteres.");
  }

  const passwordHash = await argon2.hash(input.ownerPassword, { type: argon2.argon2id });

  return getDb().transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({ name, slug })
      .onConflictDoNothing()
      .returning({ id: tenants.id });
    if (!tenant) throw new Error(`Slug '${slug}' já está em uso — escolha outro.`);

    // e-mail é identidade GLOBAL: reusar um existente daria 2 memberships e o
    // login ficaria não-determinístico (mems[0]) — exige e-mail novo, explícito
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!user) throw new Error(`E-mail '${email}' já tem conta — use outro e-mail para este empreendimento.`);

    // memberships tem FORCE RLS: contexto do tenant NOVO só nesta transação
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);
    await tx.insert(memberships).values({ tenantId: tenant.id, userId: user.id, role: "owner" });

    return { tenantId: tenant.id, userId: user.id };
  });
}

/** Tenants da vertical imobiliária (consulta SYSTEM — staff de plataforma). */
export interface ImobTenantRow {
  tenantId: string;
  name: string;
  slug: string;
  nicheName: string;
}

export async function listImobTenants(): Promise<ImobTenantRow[]> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_scan', 'on', true)`);
    const rows = (await tx.execute(sql`
      SELECT t.id AS "tenantId", t.name, t.slug, n.name AS "nicheName"
      FROM tenants t
      JOIN tenant_niche tn ON tn.tenant_id = t.id
      JOIN niches n ON n.id = tn.niche_id
      WHERE n.vertical = 'imobiliario' AND t.status = 'active'
      ORDER BY t.name
    `)) as unknown as ImobTenantRow[];
    return rows;
  });
}

/**
 * O tenant é da vertical imobiliária? Regra de autorização das integrações
 * (leitura da Central / intake de leads) quando a allowlist por env está
 * VAZIA: qualquer tenant imobiliário vale; env preenchida = lista estrita.
 */
export async function isImobTenant(tenantId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_scan', 'on', true)`);
    const rows = (await tx.execute(sql`
      SELECT 1 FROM tenant_niche tn
      JOIN niches n ON n.id = tn.niche_id
      JOIN tenants t ON t.id = tn.tenant_id
      WHERE tn.tenant_id = ${tenantId} AND n.vertical = 'imobiliario' AND t.status = 'active'
      LIMIT 1
    `)) as unknown as unknown[];
    return rows.length > 0;
  });
}
