import argon2 from "argon2";
import { makeMigrationClient } from "./client";

/**
 * Provisiona o tenant piloto da vertical imobiliária — Menin / Parque das
 * Flores — + usuário owner. Modelado em seed-odonto.ts. Idempotente por
 * slug/email. Não atribui nicho aqui (atribuição + kit vão pela API de
 * plataforma, como no fluxo odonto).
 */
const IMOB = {
  tenantName: process.env.IMOB_NAME ?? "Menin — Parque das Flores",
  tenantSlug: process.env.IMOB_SLUG ?? "parque-das-flores",
  // Login padrão de DEV (pedido do Victor 13/08): owner@demo.local / 1234.
  // O usuário do tenant 'demo' (seed base) foi renomeado p/
  // owner@demo-antigo.local para liberar este e-mail — se o seed base re-rodar,
  // ele recria owner@demo.local com membership no demo e a ordem de memberships
  // pode mudar o tenant do login (mems[0]).
  ownerEmail: process.env.IMOB_OWNER_EMAIL ?? "owner@demo.local",
  ownerPassword: process.env.IMOB_OWNER_PASSWORD ?? "1234",
};

async function main(): Promise<void> {
  const { sql } = makeMigrationClient();
  try {
    const passwordHash = await argon2.hash(IMOB.ownerPassword, { type: argon2.argon2id });

    await sql.begin(async (tx) => {
      const [tenant] = await tx<{ id: string }[]>`
        INSERT INTO tenants (name, slug) VALUES (${IMOB.tenantName}, ${IMOB.tenantSlug})
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id`;
      // Só reseta a senha quando pedida explicitamente via env — re-rodar o
      // seed não pode desfazer uma troca de senha feita depois (achado Codex).
      let [user] = process.env.IMOB_OWNER_PASSWORD
        ? await tx<{ id: string }[]>`
            INSERT INTO users (email, password_hash) VALUES (${IMOB.ownerEmail}, ${passwordHash})
            ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
            RETURNING id`
        : await tx<{ id: string }[]>`
            INSERT INTO users (email, password_hash) VALUES (${IMOB.ownerEmail}, ${passwordHash})
            ON CONFLICT (email) DO NOTHING
            RETURNING id`;
      user ??= (await tx<{ id: string }[]>`
        SELECT id FROM users WHERE email = ${IMOB.ownerEmail}`)[0];

      if (!tenant || !user) throw new Error("seed-imob: falha ao criar tenant/usuário");

      await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      // DO UPDATE garante owner mesmo se a membership existir com role menor.
      await tx`
        INSERT INTO memberships (tenant_id, user_id, role)
        VALUES (${tenant.id}, ${user.id}, 'owner')
        ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`;

      console.log(`TENANT_ID=${tenant.id}`);
      console.log(`Seed imob OK: '${IMOB.tenantSlug}' (${tenant.id}), owner ${IMOB.ownerEmail}`);
    });
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Falha no seed-imob:", err);
  process.exit(1);
});
