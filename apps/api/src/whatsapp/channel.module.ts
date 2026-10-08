import { Module } from "@nestjs/common";
import { ChannelFactory } from "./channel-factory.service";
import { whatsappHttpProvider, WHATSAPP_HTTP } from "./http.token";

/**
 * Capacidade de ENVIO pelo canal (ChannelFactory + cliente HTTP), isolada num
 * módulo próprio para que tanto a pipeline (WhatsappModule) quanto o outbox
 * proativo (M8) a consumam SEM ciclo de dependência.
 */
@Module({
  providers: [whatsappHttpProvider, ChannelFactory],
  exports: [ChannelFactory, WHATSAPP_HTTP],
})
export class ChannelModule {}
