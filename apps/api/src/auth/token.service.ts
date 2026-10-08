import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { AppConfig } from "@sdr/config";
import type { MembershipRole } from "./roles";
import { APP_CONFIG } from "../config/config.module";

/** Claims do access token: identidade + tenant ATIVO + papel no tenant. */
export interface AccessClaims {
  sub: string; // userId
  tenantId: string;
  role: MembershipRole;
}

/**
 * Claims do refresh token: identidade + último tenant ativo (rotacionado).
 * `jti` referencia a SESSÃO server-side (auth_sessions guarda sha256(jti)) —
 * revogável no logout e rotacionada a cada refresh (ADR 0006, dívida fechada).
 * Opcional no TIPO porque tokens antigos (pré-0031) não o carregam — o refresh
 * rejeita em runtime quando ausente.
 */
export interface RefreshClaims {
  sub: string;
  tenantId: string;
  jti?: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  signAccess(claims: AccessClaims): Promise<string> {
    return this.jwt.signAsync(claims, {
      secret: this.cfg.auth.accessSecret,
      expiresIn: this.cfg.auth.accessTtl,
      algorithm: "HS256",
    });
  }

  signRefresh(claims: RefreshClaims): Promise<string> {
    return this.jwt.signAsync(claims, {
      secret: this.cfg.auth.refreshSecret,
      expiresIn: this.cfg.auth.refreshTtl,
      algorithm: "HS256",
    });
  }

  verifyAccess(token: string): Promise<AccessClaims> {
    // Pin de algoritmo (defense-in-depth contra alg confusion — ex.: `none`/RS256).
    return this.jwt.verifyAsync<AccessClaims>(token, {
      secret: this.cfg.auth.accessSecret,
      algorithms: ["HS256"],
    });
  }

  verifyRefresh(token: string): Promise<RefreshClaims> {
    return this.jwt.verifyAsync<RefreshClaims>(token, {
      secret: this.cfg.auth.refreshSecret,
      algorithms: ["HS256"],
    });
  }

  /**
   * `exp` de um JWT JÁ assinado — para alinhar o expires_at da sessão de
   * refresh ao próprio token (fonte única: o expiresIn aplicado na assinatura).
   */
  readExpiration(token: string): Date {
    const decoded = this.jwt.decode<{ exp?: number } | null>(token);
    if (!decoded?.exp) throw new Error("Token sem claim exp.");
    return new Date(decoded.exp * 1000);
  }
}
