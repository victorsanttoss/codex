import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { AppConfig } from "@sdr/config";
import { APP_CONFIG } from "../config/config.module";

export interface BrokerTokenClaims {
  brokerId: string;
  tenantId: string;
  /** versão do token do corretor — bump revoga links antigos. */
  v: number;
}

const AUDIENCE = "imob-broker-workspace";
const ISSUER = "sdr-imob";
// 7d: um atendimento dura dias, não semanas — a cada aceite chega link novo e
// o admin regenera pelo painel; TTL curto limita o dano de link vazado.
const EXPIRES = "7d";

/**
 * Token do WORKSPACE DO CORRETOR: link pessoal enviado no WhatsApp ao aceitar
 * um lead (modo workspace). Assinado com o segredo de access da plataforma,
 * mas com AUDIENCE própria — não serve como token de usuário e vice-versa.
 */
@Injectable()
export class ImobWorkspaceTokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly jwt: JwtService,
  ) {}

  sign(claims: BrokerTokenClaims): Promise<string> {
    return this.jwt.signAsync(claims, {
      secret: this.cfg.auth.accessSecret,
      algorithm: "HS256",
      audience: AUDIENCE,
      issuer: ISSUER,
      expiresIn: EXPIRES,
    });
  }

  /** null se inválido/expirado/audience errada. */
  async verify(token: string): Promise<BrokerTokenClaims | null> {
    try {
      const p = await this.jwt.verifyAsync<BrokerTokenClaims & { aud?: string }>(token, {
        secret: this.cfg.auth.accessSecret,
        algorithms: ["HS256"],
        audience: AUDIENCE,
        issuer: ISSUER,
      });
      if (typeof p.brokerId !== "string" || typeof p.tenantId !== "string" || typeof p.v !== "number") {
        return null;
      }
      return { brokerId: p.brokerId, tenantId: p.tenantId, v: p.v };
    } catch {
      return null;
    }
  }
}
