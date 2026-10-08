import { createHash, timingSafeEqual } from "node:crypto";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { AppConfig } from "@sdr/config";
import { findStaffByTokenHash } from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";

export type StaffRole = "admin" | "curator" | "support";

/** Identidade do staff que executa a requisição (anexada pelo guard). */
export interface ActingStaff {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
}

const STAFF_ROLES_KEY = "staffRoles";

/**
 * Exige que o staff tenha um dos papéis dados no endpoint. `admin` sempre passa.
 * Sem o decorator, basta estar autenticado (qualquer papel) — usado nas leituras.
 */
export const RequireStaffRole = (...roles: StaffRole[]) => SetMetadata(STAFF_ROLES_KEY, roles);

/** Injeta a identidade do staff resolvida pelo guard no handler. */
export const Staff = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ActingStaff | undefined =>
    (ctx.switchToHttp().getRequest() as { staff?: ActingStaff }).staff,
);

/**
 * Guard da ÁREA DA PLATAFORMA com IDENTIDADE POR-STAFF (M14). Resolve o header
 * `x-platform-token` para uma identidade concreta:
 *  1) casa com o token pessoal de um `platform_staff` (por sha256) → aquela pessoa;
 *  2) senão, casa com o `PLATFORM_ADMIN_TOKEN` compartilhado → identidade de
 *     bootstrap `platform-admin` (papel admin) — compat e superadmin;
 *  3) senão → nega (fail-closed).
 * Depois enforça o papel exigido pelo endpoint (@RequireStaffRole). A identidade
 * fica em `req.staff` para atribuição/auditoria das ações.
 */
@Injectable()
export class PlatformStaffGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { staff?: ActingStaff }>();
    const got = req.headers["x-platform-token"];
    const token = Array.isArray(got) ? got[0] : got;
    if (typeof token !== "string" || token.length === 0) return false;

    const acting = await this.resolveIdentity(token);
    if (!acting) return false;
    req.staff = acting;

    const required = this.reflector.getAllAndOverride<StaffRole[]>(STAFF_ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true; // só exige autenticação
    if (acting.role === "admin") return true; // admin faz tudo
    return required.includes(acting.role);
  }

  private async resolveIdentity(token: string): Promise<ActingStaff | null> {
    // 1) Token pessoal de staff → identidade concreta. O token é de alta entropia
    // e o lookup é por igualdade de HASH (índice único) — não há canal de tempo útil.
    const staff = await findStaffByTokenHash(createHash("sha256").update(token).digest("hex"));
    if (staff) {
      const role = asStaffRole(staff.role);
      if (!role) {
        // Papel corrompido/desconhecido no banco → nega (não rebaixa silenciosamente).
        // eslint-disable-next-line no-console
        console.error(`[PlatformStaffGuard] papel inválido para staff ${staff.id}: ${staff.role}`);
        return null;
      }
      return { ...staff, role };
    }

    // 2) Fallback: token compartilhado de plataforma → admin de bootstrap.
    const expected = this.cfg.platform.adminToken;
    if (expected && constantTimeEqual(token, expected)) {
      return { id: "platform-admin", email: "platform-admin", name: "Plataforma (token compartilhado)", role: "admin" };
    }
    return null;
  }
}

/** Compara em tempo constante via digests de tamanho fixo (não vaza comprimento). */
function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** Valida o papel vindo do banco; retorna null se desconhecido (fail-closed). */
function asStaffRole(role: string): StaffRole | null {
  return role === "admin" || role === "curator" || role === "support" ? role : null;
}
