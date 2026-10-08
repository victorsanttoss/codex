import {
  BadGatewayException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { IsString, MinLength } from "class-validator";
import type { AppConfig } from "@sdr/config";
import { makeCipherFromEnv, setConnectionStatus, TenantSecretsStore } from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { Roles } from "../auth/roles";
import {
  EmbeddedSignupService,
  SignupConflictError,
  SignupError,
} from "./embedded-signup.service";

export class SignupCallbackDto {
  // NOTA: sem tenantId aqui — o tenant vem da SESSÃO (binding via auth). O
  // ValidationPipe (whitelist) descarta qualquer tenantId que o cliente envie.
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  phoneNumberId!: string;

  @IsString()
  @MinLength(1)
  wabaId!: string;
}

/** Onboarding (Embedded Signup) e lifecycle de conexão. Admin do tenant ativo. */
@Controller("admin/whatsapp")
export class WhatsappSignupController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly signup: EmbeddedSignupService,
  ) {}

  /** Config pública para o front iniciar o Embedded Signup (sem segredos). */
  @Roles("admin")
  @Get("signup/config")
  config(): { appId?: string; configId?: string; graphApiVersion: string } {
    return {
      ...(this.cfg.whatsapp.appId ? { appId: this.cfg.whatsapp.appId } : {}),
      ...(this.cfg.whatsapp.embeddedSignupConfigId
        ? { configId: this.cfg.whatsapp.embeddedSignupConfigId }
        : {}),
      graphApiVersion: this.cfg.whatsapp.graphApiVersion,
    };
  }

  /** Callback do front: { code, phoneNumberId, wabaId }. Tenant = sessão. */
  @Roles("admin")
  @Post("signup/callback")
  async callback(@Body() dto: SignupCallbackDto): Promise<unknown> {
    try {
      return await this.signup.connect({
        code: dto.code,
        phoneNumberId: dto.phoneNumberId,
        wabaId: dto.wabaId,
      });
    } catch (err) {
      if (err instanceof SignupConflictError) throw new ConflictException(err.message);
      if (err instanceof SignupError) throw new BadGatewayException(err.message);
      throw err;
    }
  }

  @Roles("admin")
  @Post("connections/:phoneNumberId/disconnect")
  async disconnect(
    @Param("phoneNumberId") phoneNumberId: string,
  ): Promise<{ ok: true; status: string }> {
    const ok = await setConnectionStatus(phoneNumberId, "disconnected");
    if (!ok) throw new NotFoundException("Conexão não encontrada.");
    return { ok: true, status: "disconnected" };
  }

  @Roles("admin")
  @Post("connections/:phoneNumberId/revoke")
  async revoke(
    @Param("phoneNumberId") phoneNumberId: string,
  ): Promise<{ ok: true; status: string }> {
    const ok = await setConnectionStatus(phoneNumberId, "revoked");
    if (!ok) throw new NotFoundException("Conexão não encontrada.");
    // revogação inativa o token de envio.
    await new TenantSecretsStore(makeCipherFromEnv()).delete("whatsapp_token");
    return { ok: true, status: "revoked" };
  }
}
