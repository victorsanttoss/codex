import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { NicheModule } from "../niche/niche.module";
import { CalendarModule } from "../calendar/calendar.module";
import { PlaygroundController } from "./playground.controller";
import { PlaygroundService } from "./playground.service";

/**
 * Playground (M14): reusa AgentService/AgentConfigService (AgentModule),
 * KnowledgeRetriever (KnowledgeModule) e NicheService (NicheModule) para rodar o
 * agente REAL em sandbox — sem tocar a pipeline/handler.
 */
@Module({
  imports: [AgentModule, KnowledgeModule, NicheModule, CalendarModule],
  controllers: [PlaygroundController],
  providers: [PlaygroundService],
})
export class PlaygroundModule {}
