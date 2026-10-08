import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PanelModule } from "../panel/panel.module";
import { PlatformStaffGuard } from "../platform/platform-staff.guard";
import { VerticalsModule } from "../verticals/verticals.module";
import { ImobAdminController } from "./imob-admin.controller";
import { ImobBrokerInboundService } from "./imob-broker-inbound.service";
import { ImobDistributionService } from "./imob-distribution.service";
import { ImobPlatformController } from "./imob-platform.controller";
import { ImobSlaWorker } from "./imob-sla.worker";
import { ImobWorkspaceController } from "./imob-workspace.controller";
import { ImobWorkspaceGuard } from "./imob-workspace.guard";
import { ImobWorkspaceTokenService } from "./imob-workspace-token.service";

/**
 * VERTICAL IMOBILIÁRIA (fork sdr-ia-imob): distribuição de leads qualificados
 * para corretores parceiros via WhatsApp + acompanhamento de SLA.
 *
 * Integrações (sem dependência circular — este módulo NÃO importa Whatsapp/Crm):
 *  - CrmModule injeta ImobDistributionService (opcional) no handoff do lead;
 *  - WhatsappModule injeta ImobBrokerInboundService (opcional) no inbound;
 *  - envio ao corretor via outbox (@sdr/db.enqueueOutbox → OutboxWorker envia).
 */
@Module({
  // VerticalsModule: KitApplierService p/ o provisionamento; PanelModule:
  // envio humano reusado pelo Workspace do Corretor. Sem ciclos (nenhum dos
  // dois importa Imob).
  imports: [VerticalsModule, PanelModule, JwtModule.register({})],
  controllers: [ImobAdminController, ImobPlatformController, ImobWorkspaceController],
  providers: [
    ImobDistributionService,
    ImobBrokerInboundService,
    ImobSlaWorker,
    ImobWorkspaceTokenService,
    ImobWorkspaceGuard,
    PlatformStaffGuard,
  ],
  exports: [ImobDistributionService, ImobBrokerInboundService],
})
export class ImobModule {}
