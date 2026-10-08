import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import { IsString, MinLength } from "class-validator";
import type { AppConfig } from "@sdr/config";
import { requireTenantContext } from "@sdr/core";
import { isPhoneNumberTakenByOtherTenant, upsertChannelConnection } from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { Roles } from "../auth/roles";
import { QR_STORE, type PairingState, type QrStore } from "./qr-store";

export class ConnectBaileysDto {
  /** Número do WhatsApp do cliente (só dígitos, com DDI). Vira o phone_number_id. */
  @IsString()
  @MinLength(8)
  phoneNumber!: string;
}

/**
 * Onboarding do canal NÃO-OFICIAL por QR (análogo não-oficial do Embedded Signup).
 * `connect` registra a conexão (provider=baileys) — o session-worker DONO do
 * número descobre no reconcile, abre o socket e publica o QR; o painel faz poll
 * em `qr` até `connected`. Admin, no contexto do tenant. O QR não é segredo
 * persistente (TTL curto no Redis); credenciais ficam cifradas no session-worker.
 */
@Controller("admin/whatsapp/baileys")
export class BaileysOnboardingController {
  constructor(
    @Inject(QR_STORE) private readonly qr: QrStore,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Roles("admin")
  @Post("connect")
  async connect(@Body() dto: ConnectBaileysDto): Promise<{ status: "pending"; phoneNumber: string }> {
    // Sem pool Baileys ligado, nenhum session-worker pareia → recusa explícita
    // (evita conexão pendente órfã, sem QR).
    if (!this.cfg.baileys.enabled) {
      throw new BadRequestException("Canal Baileys desabilitado (BAILEYS_ENABLED=false).");
    }
    const phoneNumberId = dto.phoneNumber.replace(/[^\d]/g, "");
    // Número de OUTRO tenant → 409 claro (o upsert bateria na unique de
    // phone_number_id sob RLS e viraria 500 cru na tela do cliente). A mensagem
    // não revela QUAL conta — o oráculo "número está na plataforma" é risco
    // aceito: sem ele o cliente não sabe por que a conexão não inicia.
    const conflict = new ConflictException(
      "Este número de WhatsApp já está conectado em outra conta. Desconecte-o lá primeiro ou use outro número.",
    );
    if (await isPhoneNumberTakenByOtherTenant(phoneNumberId)) throw conflict;
    // Registra a conexão Baileys como `connecting` (ainda NÃO pareada) — o
    // session-worker a descobre, abre o socket e publica o QR; só vira `active`
    // quando o socket parear de fato. Assim o tenant não conta como "conectado"
    // antes do scan (banner do início, envio proativo).
    try {
      await upsertChannelConnection({ phoneNumberId, displayPhone: dto.phoneNumber, provider: "baileys", status: "connecting" });
    } catch (err) {
      // TOCTOU (Codex): outro tenant registrou o número ENTRE o check e o
      // upsert — re-checa e converte para o mesmo 409; senão propaga.
      if (await isPhoneNumberTakenByOtherTenant(phoneNumberId)) throw conflict;
      throw err;
    }
    return { status: "pending", phoneNumber: phoneNumberId };
  }

  @Roles("admin")
  @Get("qr")
  async qrStatus(@Query("phoneNumber") phoneNumber: string): Promise<PairingState | { status: "pending" }> {
    const { tenantId } = requireTenantContext();
    const phoneNumberId = (phoneNumber ?? "").replace(/[^\d]/g, "");
    const state = await this.qr.read(tenantId, phoneNumberId);
    return state ?? { status: "pending" };
  }
}
