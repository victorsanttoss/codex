import { and, eq, isNull, lt } from "drizzle-orm";
import { withTenant, withUser } from "./client";
import { authSessions } from "./schema";

/**
 * Sessões de REFRESH (ADR 0006 — dívida de revogação fechada). Cada refresh
 * token emitido tem uma linha aqui, indexada pelo sha256 do `jti` do JWT (o
 * token em si NUNCA é persistido). Os caminhos de leitura/escrita rodam como o
 * PRÓPRIO usuário (withUser) — a policy da 0031 libera por app.user_id, pois
 * refresh/logout acontecem antes de haver tenant ativo e a revogação global
 * (reuso detectado / troca de senha) cruza os tenants do usuário.
 */

export interface AuthSessionRow {
  id: string;
  tenantId: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface CreateAuthSessionInput {
  tenantId: string;
  userId: string;
  /** sha256 hex (64 chars) do jti do refresh JWT. */
  tokenHash: string;
  expiresAt: Date;
}

/** Cria a sessão do refresh recém-emitido (login/refresh/switch-tenant). */
export async function createAuthSession(input: CreateAuthSessionInput): Promise<string> {
  return withTenant(
    async (tx) => {
      const rows = await tx
        .insert(authSessions)
        .values({
          tenantId: input.tenantId,
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        })
        .returning({ id: authSessions.id });
      return rows[0]!.id;
    },
    { tenantId: input.tenantId, userId: input.userId },
  );
}

/** Sessão pelo hash do jti — inclui revogadas/expiradas (o chamador decide). */
export async function findAuthSession(
  userId: string,
  tokenHash: string,
): Promise<AuthSessionRow | null> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        id: authSessions.id,
        tenantId: authSessions.tenantId,
        userId: authSessions.userId,
        expiresAt: authSessions.expiresAt,
        revokedAt: authSessions.revokedAt,
      })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), eq(authSessions.tokenHash, tokenHash)))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Revoga UMA sessão (logout / rotação no refresh). Idempotente. */
export async function revokeAuthSession(userId: string, tokenHash: string): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.userId, userId),
          eq(authSessions.tokenHash, tokenHash),
          isNull(authSessions.revokedAt),
        ),
      )
      .returning({ id: authSessions.id });
    return rows.length > 0;
  });
}

/**
 * Revoga TODAS as sessões vivas do usuário — reuso de token rotacionado
 * (detecção de roubo, OWASP) e troca de senha. Cruza os tenants do usuário
 * (perna user_id da policy).
 */
export async function revokeAllUserSessions(userId: string): Promise<number> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id });
    return rows.length;
  });
}

/** Sweep oportunista (no login): apaga sessões já EXPIRADAS do usuário. */
export async function deleteExpiredAuthSessions(userId: string, now = new Date()): Promise<number> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .delete(authSessions)
      .where(and(eq(authSessions.userId, userId), lt(authSessions.expiresAt, now)))
      .returning({ id: authSessions.id });
    return rows.length;
  });
}
