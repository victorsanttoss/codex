import { Module } from "@nestjs/common";
import { CadenceConfigService } from "./cadence-config.service";
import { CadenceService } from "./cadence.service";
import { TemplateService } from "./template.service";
import { CadenceWorker } from "./cadence.worker";

/**
 * Cadência / follow-up proativo (M8). Enfileira templates no outbox (que envia).
 * O handler do agente consome `CadenceService` (stop-on-engagement, opt-out, arme).
 */
@Module({
  providers: [CadenceConfigService, CadenceService, TemplateService, CadenceWorker],
  exports: [CadenceService, CadenceConfigService],
})
export class CadenceModule {}
