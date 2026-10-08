import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AccessClaims } from "./token.service";

/** Marca uma rota como pública (pula o JwtAuthGuard). */
export const IS_PUBLIC_KEY = "isPublic";
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Injeta os claims do usuário autenticado no handler. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessClaims | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: AccessClaims }>();
    return req.user;
  },
);
