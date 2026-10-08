import { createHash, randomBytes } from "node:crypto";
import { ForbiddenException, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  createAuthSession,
  deleteExpiredAuthSessions,
  findAuthSession,
  memberships,
  revokeAllUserSessions,
  revokeAuthSession,
  tenants,
  users,
  withSystem,
  withUser,
} from "@sdr/db";
import { PasswordService } from "./password.service";
import { TokenService, type RefreshClaims } from "./token.service";
import type { MembershipRole } from "./roles";

export interface TenantMembership {
  tenantId: string;
  role: MembershipRole;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends AuthTokens {
  userId: string;
  activeTenantId: string;
  tenants: TenantMembership[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
    // users não é tenant-scoped — leitura pelo caminho system (identidade).
    const user = await withSystem(async (db) => {
      const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return rows[0] ?? null;
    });
    if (!user) {
      // Roda um verify "dummy" para equalizar o tempo de resposta e não vazar
      // a existência do e-mail por timing (Argon2 é caro).
      await this.passwords.verify(await this.dummyHash(), password);
      throw new UnauthorizedException("Credenciais inválidas.");
    }
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new UnauthorizedException("Credenciais inválidas.");
    }

    const mems = await this.membershipsOf(user.id);
    const active = mems[0];
    if (!active) throw new ForbiddenException("Usuário sem tenant associado.");

    // Sweep oportunista: sessões de refresh já expiradas do usuário não servem
    // para nada — apaga aqui (best-effort) em vez de manter um cron dedicado.
    try {
      await deleteExpiredAuthSessions(user.id);
    } catch (err) {
      this.logger.warn(`Sweep de sessões expiradas falhou: ${asMsg(err)}`);
    }

    const issued = await this.issue(user.id, active.tenantId, active.role);
    return { userId: user.id, activeTenantId: active.tenantId, tenants: mems, ...issued };
  }

  /**
   * Troca de tenant ativo: emite tokens novos (nova sessão de refresh) e revoga
   * a sessão do refresh APRESENTADO (o cookie será sobrescrito — sem revogar,
   * a sessão antiga ficaria órfã e válida até expirar).
   */
  async switchTenant(
    userId: string,
    tenantId: string,
    presentedRefreshToken?: string,
  ): Promise<AuthTokens> {
    const role = await this.roleFor(userId, tenantId);
    if (!role) throw new ForbiddenException("Usuário não pertence a este tenant.");
    const issued = await this.issue(userId, tenantId, role);
    if (presentedRefreshToken) await this.revokePresented(userId, presentedRefreshToken);
    return issued;
  }

  /**
   * ROTAÇÃO do refresh (ADR 0006 + padrão OWASP): valida a SESSÃO server-side
   * (existe, não-revogada, não-expirada) além da assinatura (já verificada pelo
   * controller), revoga a sessão apresentada e emite tokens novos. Reuso de um
   * token JÁ rotacionado (sessão revogada) indica roubo → revoga TODAS as
   * sessões do usuário e nega.
   */
  async refresh(claims: RefreshClaims): Promise<AuthTokens> {
    if (!claims.jti) {
      // Token pré-0031 (sem sessão): inválido — força novo login.
      throw new UnauthorizedException("Refresh token sem sessão — faça login novamente.");
    }
    const session = await findAuthSession(claims.sub, sha256(claims.jti));
    if (!session) throw new UnauthorizedException("Sessão de refresh inexistente.");
    if (session.revokedAt) {
      // Reuso de token rotacionado/revogado: possível roubo — derruba TUDO.
      const n = await revokeAllUserSessions(claims.sub);
      this.logger.warn(
        `Reuso de refresh token rotacionado (user ${claims.sub}) — ${n} sessão(ões) revogada(s).`,
      );
      throw new UnauthorizedException("Refresh token revogado.");
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("Sessão de refresh expirada.");
    }
    const role = await this.roleFor(claims.sub, claims.tenantId);
    if (!role) throw new UnauthorizedException("Membership não é mais válida.");
    // Rotaciona ANTES de emitir: se a emissão falhar, o token velho morre (falha
    // fechada) em vez de sobrar um refresh eterno. O revoke é o CONSUME atômico
    // (UPDATE ... WHERE revoked_at IS NULL): se voltou false, um refresh
    // concorrente com o MESMO token já consumiu a sessão — é reuso (achado
    // Codex), não emite segunda sessão e derruba tudo.
    const consumed = await revokeAuthSession(claims.sub, sha256(claims.jti));
    if (!consumed) {
      const n = await revokeAllUserSessions(claims.sub);
      this.logger.warn(
        `Refresh concorrente/reuso na rotação (user ${claims.sub}) — ${n} sessão(ões) revogada(s).`,
      );
      throw new UnauthorizedException("Refresh token revogado.");
    }
    return this.issue(claims.sub, claims.tenantId, role);
  }

  /** Logout: revoga a sessão do refresh APRESENTADO (best-effort, idempotente). */
  async logout(presentedRefreshToken: string | undefined, userId?: string): Promise<void> {
    if (!presentedRefreshToken) return;
    await this.revokePresented(userId, presentedRefreshToken);
  }

  /**
   * Troca de senha / comprometimento: revoga TODAS as sessões de refresh do
   * usuário (não há endpoint de troca de senha hoje — exposto para quando houver
   * e usado na detecção de reuso).
   */
  revokeAllSessions(userId: string): Promise<number> {
    return revokeAllUserSessions(userId);
  }

  /** Revoga a sessão de um refresh token apresentado, sem lançar (best-effort). */
  private async revokePresented(userId: string | undefined, token: string): Promise<void> {
    try {
      const claims = await this.tokens.verifyRefresh(token);
      if (!claims.jti) return;
      // Se veio identidade autenticada (access), ela manda; um refresh de OUTRO
      // usuário não revoga nada (a policy por user_id já bloquearia).
      await revokeAuthSession(userId ?? claims.sub, sha256(claims.jti));
    } catch (err) {
      this.logger.warn(`Revogação de refresh no logout falhou: ${asMsg(err)}`);
    }
  }

  private async issue(
    userId: string,
    tenantId: string,
    role: MembershipRole,
  ): Promise<AuthTokens> {
    // jti de alta entropia; a sessão guarda só o sha256 (vazamento do banco não
    // reconstrói um refresh válido — e forjar o JWT exigiria o segredo).
    const jti = randomBytes(32).toString("hex");
    const [accessToken, refreshToken] = await Promise.all([
      this.tokens.signAccess({ sub: userId, tenantId, role }),
      this.tokens.signRefresh({ sub: userId, tenantId, jti }),
    ]);
    await createAuthSession({
      tenantId,
      userId,
      tokenHash: sha256(jti),
      expiresAt: this.tokens.readExpiration(refreshToken),
    });
    return { accessToken, refreshToken };
  }

  /** Memberships do próprio usuário em tenants ATIVOS (policy permite ver por user_id). */
  private membershipsOf(userId: string): Promise<TenantMembership[]> {
    return withUser(userId, async (tx) => {
      const rows = await tx
        .select({ tenantId: memberships.tenantId, role: memberships.role })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(and(eq(memberships.userId, userId), eq(tenants.status, "active")));
      return rows;
    });
  }

  /** Papel do usuário num tenant ATIVO específico (null se inexistente/suspenso). */
  private roleFor(userId: string, tenantId: string): Promise<MembershipRole | null> {
    return withUser(userId, async (tx) => {
      const rows = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.tenantId, tenantId),
            eq(tenants.status, "active"),
          ),
        )
        .limit(1);
      return rows[0]?.role ?? null;
    });
  }

  private cachedDummyHash: string | undefined;
  private async dummyHash(): Promise<string> {
    if (!this.cachedDummyHash) {
      this.cachedDummyHash = await this.passwords.hash("§usuario-inexistente§");
    }
    return this.cachedDummyHash;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
