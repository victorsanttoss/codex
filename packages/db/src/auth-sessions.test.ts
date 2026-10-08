import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, makeMigrationClient } from "./client";
import {
  createAuthSession,
  deleteExpiredAuthSessions,
  findAuthSession,
  revokeAllUserSessions,
  revokeAuthSession,
} from "./auth-sessions";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

function hashOf(jti: string): string {
  return createHash("sha256").update(jti).digest("hex");
}

const IN_1H = () => new Date(Date.now() + 3_600_000);

describe.skipIf(!dbConfigured)("0031 — sessões de refresh (db)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";
  let userId = "";
  let otherUserId = "";

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('Auth', ${"auth-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    const [u] = await mig.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash) VALUES (${randomUUID() + "@t.dev"}, 'x') RETURNING id`;
    const [o] = await mig.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash) VALUES (${randomUUID() + "@t.dev"}, 'x') RETURNING id`;
    userId = u!.id;
    otherUserId = o!.id;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql`DELETE FROM users WHERE id IN (${userId}, ${otherUserId})`;
    await mig.sql.end();
    await closeDb();
  });

  it("cria, encontra e revoga uma sessão (logout)", async () => {
    const jti = randomUUID();
    await createAuthSession({ tenantId, userId, tokenHash: hashOf(jti), expiresAt: IN_1H() });
    const found = await findAuthSession(userId, hashOf(jti));
    expect(found).toBeTruthy();
    expect(found!.revokedAt).toBeNull();
    expect(await revokeAuthSession(userId, hashOf(jti))).toBe(true);
    const revoked = await findAuthSession(userId, hashOf(jti));
    expect(revoked!.revokedAt).toBeInstanceOf(Date);
    // idempotente: já revogada não revoga de novo
    expect(await revokeAuthSession(userId, hashOf(jti))).toBe(false);
  });

  it("RLS: outro usuário NÃO enxerga nem revoga a sessão", async () => {
    const jti = randomUUID();
    await createAuthSession({ tenantId, userId, tokenHash: hashOf(jti), expiresAt: IN_1H() });
    expect(await findAuthSession(otherUserId, hashOf(jti))).toBeNull();
    expect(await revokeAuthSession(otherUserId, hashOf(jti))).toBe(false);
    const still = await findAuthSession(userId, hashOf(jti));
    expect(still!.revokedAt).toBeNull();
  });

  it("revoga TODAS as sessões vivas do usuário (reuso detectado / troca de senha)", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await createAuthSession({ tenantId, userId: otherUserId, tokenHash: hashOf(a), expiresAt: IN_1H() });
    await createAuthSession({ tenantId, userId: otherUserId, tokenHash: hashOf(b), expiresAt: IN_1H() });
    const n = await revokeAllUserSessions(otherUserId);
    expect(n).toBeGreaterThanOrEqual(2);
    expect((await findAuthSession(otherUserId, hashOf(a)))!.revokedAt).toBeInstanceOf(Date);
    expect((await findAuthSession(otherUserId, hashOf(b)))!.revokedAt).toBeInstanceOf(Date);
  });

  it("sweep: apaga só as sessões EXPIRADAS do usuário", async () => {
    const old = randomUUID();
    const fresh = randomUUID();
    await createAuthSession({
      tenantId,
      userId,
      tokenHash: hashOf(old),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await createAuthSession({ tenantId, userId, tokenHash: hashOf(fresh), expiresAt: IN_1H() });
    const n = await deleteExpiredAuthSessions(userId);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await findAuthSession(userId, hashOf(old))).toBeNull();
    expect(await findAuthSession(userId, hashOf(fresh))).toBeTruthy();
  });
});
