import { Module } from "@nestjs/common";
import { ChannelModule } from "../whatsapp/channel.module";
import { OutboxService } from "./outbox.service";
import { OutboxWorker } from "./outbox.worker";

/**
 * Outbox de entrega (M8). Consome a capacidade de envio do `ChannelModule`
 * (sem ciclo). Exporta `OutboxService` para o caminho de cadência (M8) e qualquer
 * envio proativo enfileirar.
 */
@Module({
  imports: [ChannelModule],
  providers: [OutboxService, OutboxWorker],
  exports: [OutboxService],
})
export class OutboxModule {}
