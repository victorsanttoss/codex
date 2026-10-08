import { Module } from "@nestjs/common";
import { OutboxModule } from "../outbox/outbox.module";
import { PanelController } from "./panel.controller";
import { PanelMessageService } from "./panel-message.service";

/**
 * Painel (M14): APIs de leitura (leads/conversas/dashboard) + assumir conversa
 * + envio manual do humano (via núcleo de entrega do OutboxModule).
 */
@Module({
  imports: [OutboxModule],
  controllers: [PanelController],
  providers: [PanelMessageService],
  // exportado p/ o Workspace do Corretor (fork imob) reusar o envio humano
  exports: [PanelMessageService],
})
export class PanelModule {}
