import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { runWithTenant } from "@sdr/core";
import { getImobBrokerById } from "@sdr/db";
import { ImobWorkspaceTokenService } from "./imob-workspace-token.service";

export interface ActingBroker {
  brokerId: string;
  tenantId: string;
  name: string;
}

/**
 * Guard do WORKSPACE DO CORRETOR: token pessoal (Bearer ou x-broker-token) →
 * claims verificadas → corretor carregado NO tenant do token → versão do token
 * conferida (bump = revogado) e corretor ativo/não-arquivado. Anexa
 * `req.broker`; o controller roda runWithTenant(claims.tenantId).
 */
@Injectable()
export class ImobWorkspaceGuard implements CanActivate {
  constructor(private readonly tokens: ImobWorkspaceTokenService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { broker?: ActingBroker }>();
    const header = req.headers.authorization;
    const raw =
      (typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined) ??
      (typeof req.headers["x-broker-token"] === "string" ? (req.headers["x-broker-token"] as string) : undefined);
    if (!raw) throw new UnauthorizedException("Link do workspace ausente.");

    const claims = await this.tokens.verify(raw);
    if (!claims) throw new UnauthorizedException("Link do workspace inválido ou expirado.");

    const broker = await runWithTenant({ tenantId: claims.tenantId }, () =>
      getImobBrokerById(claims.brokerId),
    );
    if (!broker || broker.archivedAt || !broker.active) {
      throw new UnauthorizedException("Acesso do corretor desativado.");
    }
    if (broker.accessTokenVersion !== claims.v) {
      throw new UnauthorizedException("Link do workspace revogado — peça um novo.");
    }

    req.broker = { brokerId: claims.brokerId, tenantId: claims.tenantId, name: broker.name };
    return true;
  }
}
