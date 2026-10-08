import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { assignTenant } from "@sdr/core";
import { TokenService, type AccessClaims } from "./token.service";
import { IS_PUBLIC_KEY } from "./decorators";

interface AuthedRequest extends Request {
  user?: AccessClaims;
  requestId?: string;
  // `cookies` já vem de Express (tipado como any via cookie-parser).
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = extractToken(req);
    if (!token) throw new UnauthorizedException("Token de acesso ausente.");

    let claims: AccessClaims;
    try {
      claims = await this.tokens.verifyAccess(token);
    } catch {
      throw new UnauthorizedException("Token de acesso inválido ou expirado.");
    }

    req.user = claims;
    // Preenche o tenant no contexto da requisição (mutação do store já criado
    // pelo middleware) — visível para handler e services/db.
    assignTenant({ tenantId: claims.tenantId, userId: claims.sub });
    return true;
  }
}

function extractToken(req: AuthedRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const cookie = req.cookies?.access_token;
  return cookie ?? null;
}
