import { Module } from "@nestjs/common";
import { crmRegistryProvider } from "./crm.registry";
import { CrmConfigService } from "./crm-config.service";
import { CrmService } from "./crm.service";
import { CrmSyncService } from "./crm-sync.service";
import { CrmSyncQueue } from "./crm-sync.queue";
import { LeadOutcomeService } from "./lead-outcome.service";
import { ImobModule } from "../imobiliario/imob.module";

/**
 * CRM + agendamento + notificação (M7). Fecha o ciclo reativo do lead: o agente
 * (M6) chama `LeadOutcomeService.onTurnEnd` ao fim do turno. Exporta a facade.
 * ImobModule (fork): distribuição p/ corretor no handoff (sem ciclo — o módulo
 * imobiliário não importa Crm/Whatsapp).
 */
@Module({
  imports: [ImobModule],
  providers: [
    crmRegistryProvider,
    CrmConfigService,
    CrmService,
    CrmSyncService,
    CrmSyncQueue,
    LeadOutcomeService,
  ],
  exports: [LeadOutcomeService],
})
export class CrmModule {}
