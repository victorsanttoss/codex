import { Module } from "@nestjs/common";
import { LlmModule } from "../llm/llm.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { CrmModule } from "../crm/crm.module";
import { CadenceModule } from "../cadence/cadence.module";
import { NicheModule } from "../niche/niche.module";
import { CalendarModule } from "../calendar/calendar.module";
import { AgentService } from "./agent.service";
import { AgentConfigService } from "./agent-config";
import { AgentMessageHandler } from "./agent-message.handler";
import { FieldExtractor } from "./field-extractor";
import { TenantCostGuard } from "./tenant-cost-guard";
import { AgentTurnService } from "./agent-turn.service";

/**
 * O AGENTE (M6). Consome `LlmService` (LlmModule) e `KnowledgeRetriever`
 * (KnowledgeModule). Exporta o `AgentMessageHandler` para o WhatsappModule
 * ligá-lo no seam `INBOUND_HANDLER` (substitui o EchoMessageHandler do M2).
 */
@Module({
  imports: [
    LlmModule,
    KnowledgeModule,
    CrmModule,
    CadenceModule,
    NicheModule,
    CalendarModule,
  ],
  providers: [
    AgentService,
    AgentConfigService,
    AgentMessageHandler,
    FieldExtractor,
    TenantCostGuard,
    AgentTurnService,
  ],
  exports: [
    AgentMessageHandler,
    AgentService,
    AgentConfigService,
    FieldExtractor,
    AgentTurnService,
  ],
})
export class AgentModule {}
