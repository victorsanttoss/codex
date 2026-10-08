import { Body, Controller, Get, Post } from "@nestjs/common";
import { IsOptional, IsString, MinLength } from "class-validator";
import { getActiveConnectionForTenant, makeCipherFromEnv, TenantSecretsStore, upsertChannelConnection } from "@sdr/db";
import { Roles } from "../auth/roles";

export class RegisterConnectionDto {
  @IsString()
  @MinLength(1)
  phoneNumberId!: string;

  @IsString()
  @MinLength(1)
  accessToken!: string;

  @IsOptional()
  @IsString()
  wabaId?: string;

  @IsOptional()
  @IsString()
  displayPhone?: string;
}

/**
 * Registro manual de conexão (M2). Guarda o token de envio do tenant
 * (cifrado) e mapeia phone_number_id -> tenant. A automação é o M3 (Embedded
 * Signup). Requer papel admin; roda no contexto do tenant ativo.
 */
@Controller("admin/whatsapp/connections")
export class WhatsappConnectionsController {
  /**
   * Status da conexão ATIVA do tenant (cloud_api ou baileys) — usado pela tela
   * inicial para mostrar o estado vazio "nenhum WhatsApp conectado" + onboarding.
   */
  @Roles("admin")
  @Get()
  async status(): Promise<{ connected: boolean; provider?: string; phoneNumberId?: string }> {
    const conn = await getActiveConnectionForTenant();
    return conn
      ? { connected: true, provider: conn.provider, phoneNumberId: conn.phoneNumberId }
      : { connected: false };
  }

  @Roles("admin")
  @Post()
  async register(@Body() dto: RegisterConnectionDto): Promise<{ ok: true }> {
    await new TenantSecretsStore(makeCipherFromEnv()).put("whatsapp_token", dto.accessToken);
    await upsertChannelConnection({
      phoneNumberId: dto.phoneNumberId,
      ...(dto.wabaId ? { wabaId: dto.wabaId } : {}),
      ...(dto.displayPhone ? { displayPhone: dto.displayPhone } : {}),
    });
    return { ok: true };
  }
}
