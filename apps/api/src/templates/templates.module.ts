import { Module } from "@nestjs/common";
import { ChannelModule } from "../whatsapp/channel.module";
import { TemplatesController } from "./templates.controller";
import { MetaTemplateSubmitService } from "./meta-template-submit.service";

/**
 * Catálogo de templates do tenant + submissão automática de HSM à Meta (M8-ext).
 * Importa o ChannelModule pelo WHATSAPP_HTTP (mesmo HttpClient injetável do
 * Embedded Signup — mockável nos testes). O handler do webhook de aprovação
 * (TemplateStatusEventsService) vive no WhatsappModule, junto do worker.
 */
@Module({
  imports: [ChannelModule],
  controllers: [TemplatesController],
  providers: [MetaTemplateSubmitService],
})
export class TemplatesModule {}
