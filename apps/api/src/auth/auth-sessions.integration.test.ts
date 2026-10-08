import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwtService } from "@nestjs/jwt";
import { UnauthorizedException } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { closeDb, makeMigrationClient } from "@sdr/db";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { TokenService } from "./token.service";

/**
 * Integração das SESSÕES de refresh (ADR 0006, migration 0031): login cria a
 * sessão; refresh ROTACIONA; logout revoga; reuso de token rotacionado revoga
 * TODAS as sessões do usuário (padrão OWASP de detecção de roubo).
 */
const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

const cfg = {
  auth: {
    accessSecret: "access-secret-com-mais-de-32-caracteres!!",
    refreshSecret: "refresh-secret-com-mais-de-32-caracteres!",
    accessTtl: "15m",
    refreshTtl: "30d",
    cookieDomain: "localhost",
    cookieSecure: false,
  },
} as unknown as AppConfig;

describe.skipIf(!dbConfigured)("0031 — refresh com sessão server-side (integração)", () => {
  const passwords = new PasswordService();
  const tokens = new TokenService(new JwtService({}), cfg);
  const auth = new AuthService(passwords, tokens);

  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";
  let userId = "";
  const email = `sess-${randomUUID()}@t.dev`;
  const password = "senha-forte-123";

  /** Sessões do usuário (via migrator com app.user_id — FORCE RLS exige contexto). */
  async function sessionsOf(): Promise<Array<{ token_hash: string; revoked_at: Date | null }>> {
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${userId}, true)`;
      return tx<Array<{ token_hash: string; revoked_at: Date | null }>>`
        SELECT token_hash, revoked_at FROM auth_sessions WHERE user_id = ${userId}
        ORDER BY created_at`;
    }) as Promise<Array<{ token_hash: string; revoked_at: Date | null }>>;
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('Sess', ${"sess-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    const hash = await passwords.hash(password);
    const [u] = await mig.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash) VALUES (${email}, ${hash}) RETURNING id`;
    userId = u!.id;
    // FORCE RLS: até o migrator precisa do contexto de tenant para inserir.
    await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`
        INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenantId}, ${userId}, 'owner')`;
    });
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql`DELETE FROM users WHERE id = ${userId}`;
    await mig.sql.end();
    await closeDb();
  });

  it("login cria sessão e o refresh JWT carrega o jti", async () => {
    const result = await auth.login(email, password);
    const claims = await tokens.verifyRefresh(result.refreshToken);
    expect(claims.jti).toBeTruthy();
    const sessions = await sessionsOf();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.every((s) => s.token_hash.match(/^[0-9a-f]{64}$/))).toBe(true);
  });

  it("refresh ROTACIONA: revoga a sessão antiga e emite nova utilizável", async () => {
    const login = await auth.login(email, password);
    const oldClaims = await tokens.verifyRefresh(login.refreshToken);

    const rotated = await auth.refresh(oldClaims);
    // token novo funciona (sessão nova, não-revogada)
    const newClaims = await tokens.verifyRefresh(rotated.refreshToken);
    expect(newClaims.jti).not.toBe(oldClaims.jti);
    const again = await auth.refresh(newClaims);
    expect(again.accessToken).toBeTruthy();
  });

  it("logout revoga a sessão: o refresh apresentado deixa de valer", async () => {
    const login = await auth.login(email, password);
    await auth.logout(login.refreshToken, userId);
    const claims = await tokens.verifyRefresh(login.refreshToken);
    await expect(auth.refresh(claims)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("REUSO de token rotacionado revoga TODAS as sessões do usuário (OWASP)", async () => {
    const login = await auth.login(email, password);
    const oldClaims = await tokens.verifyRefresh(login.refreshToken);
    const rotated = await auth.refresh(oldClaims); // rotaciona: old revogado
    const liveClaims = await tokens.verifyRefresh(rotated.refreshToken);

    // atacante (ou replay) apresenta o token ANTIGO → nega e derruba tudo
    await expect(auth.refresh(oldClaims)).rejects.toBeInstanceOf(UnauthorizedException);
    // inclusive a sessão VIVA que tinha acabado de ser emitida
    await expect(auth.refresh(liveClaims)).rejects.toBeInstanceOf(UnauthorizedException);
    const sessions = await sessionsOf();
    expect(sessions.every((s) => s.revoked_at !== null)).toBe(true);
  });

  it("ROTAÇÃO ATÔMICA (achado Codex): refreshes CONCORRENTES com o mesmo token → só um vence", async () => {
    const login = await auth.login(email, password);
    const claims = await tokens.verifyRefresh(login.refreshToken);
    // dois requests simultâneos com o MESMO refresh: o consume é o UPDATE atômico
    // (WHERE revoked_at IS NULL) — o perdedor NÃO pode emitir uma 2ª sessão viva.
    const results = await Promise.allSettled([auth.refresh(claims), auth.refresh(claims)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeLessThanOrEqual(1);
    // e o perdedor tratou como reuso: nenhuma sessão além da vencedora sobrevive
    const sessions = await sessionsOf();
    const vivas = sessions.filter((s) => s.revoked_at === null);
    expect(vivas.length).toBeLessThanOrEqual(1);
  });

  it("refresh sem jti (token pré-0031) é rejeitado", async () => {
    await expect(auth.refresh({ sub: userId, tenantId })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("login faz sweep oportunista das sessões já expiradas", async () => {
    // planta uma sessão expirada diretamente
    await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`select set_config('app.user_id', ${userId}, true)`;
      await tx`
        INSERT INTO auth_sessions (tenant_id, user_id, token_hash, expires_at)
        VALUES (${tenantId}, ${userId}, ${"a".repeat(64)}, now() - interval '1 hour')`;
    });
    await auth.login(email, password);
    const sessions = await sessionsOf();
    expect(sessions.find((s) => s.token_hash === "a".repeat(64))).toBeUndefined();
  });
});
