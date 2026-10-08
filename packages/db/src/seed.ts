import { createHash } from "node:crypto";
import argon2 from "argon2";
import { makeMigrationClient } from "./client";

/** Tokens de staff de DEV (não-secretos, só local). Guardamos só o sha256. */
const STAFF_TOKENS: Record<string, string> = {
  "staff@v4.local": process.env.SEED_STAFF_ADMIN_TOKEN ?? "dev-staff-admin-token",
  "curador@v4.local": process.env.SEED_STAFF_CURATOR_TOKEN ?? "dev-staff-curator-token",
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Seed de desenvolvimento: 1 tenant demo + 1 usuário owner.
 * Roda como `migrator` (owner). Como `memberships` tem FORCE RLS, o insert
 * da membership exige `app.tenant_id` setado — exercitando a policy de verdade.
 */
const DEMO = {
  tenantName: "Demo Co",
  tenantSlug: "demo",
  // FORK IMOB: owner@demo.local é o LOGIN PADRÃO do tenant piloto imobiliário
  // (seed-imob) — o demo usa outro e-mail p/ re-seed nunca colidir (senha
  // resetada + membership extra mudariam o tenant do login, mems[0]).
  ownerEmail: "owner@demo-antigo.local",
  ownerPassword: process.env.SEED_OWNER_PASSWORD ?? "demo-owner-123456",
};

async function main(): Promise<void> {
  const { sql } = makeMigrationClient();
  try {
    const passwordHash = await argon2.hash(DEMO.ownerPassword, { type: argon2.argon2id });

    await sql.begin(async (tx) => {
      const [tenant] = await tx<{ id: string }[]>`
        INSERT INTO tenants (name, slug) VALUES (${DEMO.tenantName}, ${DEMO.tenantSlug})
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO users (email, password_hash) VALUES (${DEMO.ownerEmail}, ${passwordHash})
        ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
        RETURNING id`;

      if (!tenant || !user) throw new Error("seed: falha ao criar tenant/usuário");

      // memberships tem FORCE RLS: precisa do contexto do tenant para o WITH CHECK.
      await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      await tx`
        INSERT INTO memberships (tenant_id, user_id, role)
        VALUES (${tenant.id}, ${user.id}, 'owner')
        ON CONFLICT (user_id, tenant_id) DO NOTHING`;

      // M14: staff de plataforma demo (dado de plataforma, sem RLS de tenant),
      // cada um com seu token pessoal (guardamos só o hash sha256).
      await tx`
        INSERT INTO platform_staff (email, name, role, token_hash) VALUES
          ('staff@v4.local', 'Vitor Franco', 'admin', ${sha256(STAFF_TOKENS["staff@v4.local"]!)}),
          ('curador@v4.local', 'Curador Demo', 'curator', ${sha256(STAFF_TOKENS["curador@v4.local"]!)})
        ON CONFLICT (email) DO UPDATE SET token_hash = EXCLUDED.token_hash`;

      console.log(`Seed OK: tenant '${DEMO.tenantSlug}' (${tenant.id}), owner ${DEMO.ownerEmail}`);
      console.log("Tokens de staff (dev):");
      for (const [email, token] of Object.entries(STAFF_TOKENS)) console.log(`  ${email} -> ${token}`);
    });
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Falha no seed:", err);
  process.exit(1);
});
