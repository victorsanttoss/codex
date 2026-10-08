import argon2 from "argon2";
import { makeMigrationClient } from "./client";

/**
 * Provisiona um tenant NOVO (cliente real) — clínica odontológica — + usuário owner.
 * Modelado em seed.ts. Idempotente por slug/email. Não atribui nicho aqui
 * (atribuição + templates vão pela API de plataforma, já testada).
 */
const CLINIC = {
  tenantName: process.env.CLINIC_NAME ?? "Clínica Sorriso",
  tenantSlug: process.env.CLINIC_SLUG ?? "sorriso",
  ownerEmail: process.env.CLINIC_OWNER_EMAIL ?? "owner@sorriso.local",
  ownerPassword: process.env.CLINIC_OWNER_PASSWORD ?? "sorriso-owner-123456",
};

async function main(): Promise<void> {
  const { sql } = makeMigrationClient();
  try {
    const passwordHash = await argon2.hash(CLINIC.ownerPassword, { type: argon2.argon2id });

    await sql.begin(async (tx) => {
      const [tenant] = await tx<{ id: string }[]>`
        INSERT INTO tenants (name, slug) VALUES (${CLINIC.tenantName}, ${CLINIC.tenantSlug})
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO users (email, password_hash) VALUES (${CLINIC.ownerEmail}, ${passwordHash})
        ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
        RETURNING id`;

      if (!tenant || !user) throw new Error("seed-odonto: falha ao criar tenant/usuário");

      await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      await tx`
        INSERT INTO memberships (tenant_id, user_id, role)
        VALUES (${tenant.id}, ${user.id}, 'owner')
        ON CONFLICT (user_id, tenant_id) DO NOTHING`;

      console.log(`TENANT_ID=${tenant.id}`);
      console.log(`Seed odonto OK: '${CLINIC.tenantSlug}' (${tenant.id}), owner ${CLINIC.ownerEmail}`);
    });
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Falha no seed-odonto:", err);
  process.exit(1);
});
