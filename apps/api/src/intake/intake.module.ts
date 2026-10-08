import { Module } from "@nestjs/common";
import { IntakeController } from "./intake.controller";
import { LeadIntakeService } from "./lead-intake.service";
import { MetaLeadsWebhookController } from "./meta-leads.webhook.controller";

/**
 * ENTRADA DE LEADS DE CAMPANHA (fork imob): a SDR deixa de ser só receptiva —
 * cadastros de Meta Lead Ads (formulários nativos) e de qualquer integração
 * viram conversa com perfil pré-preenchido + primeiro contato ativo no
 * WhatsApp. Sem dependências de outros módulos (usa @sdr/db direto).
 */
@Module({
  controllers: [IntakeController, MetaLeadsWebhookController],
  providers: [LeadIntakeService],
  exports: [LeadIntakeService],
})
export class IntakeModule {}
