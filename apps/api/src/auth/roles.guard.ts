import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Roles, roleSatisfies, type MembershipRole } from "./roles";
import type { AccessClaims } from "./token.service";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<MembershipRole | undefined>(Roles, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true; // rota sem exigência de papel

    const req = context.switchToHttp().getRequest<{ user?: AccessClaims }>();
    const user = req.user;
    if (!user) throw new ForbiddenException("Sem usuário autenticado.");
    if (!roleSatisfies(user.role, required)) {
      throw new ForbiddenException(`Requer papel '${required}' ou superior.`);
    }
    return true;
  }
}
