import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { CadenceModule } from "../cadence/cadence.module";
import { CalendarModule } from "../calendar/calendar.module";
import { SettingsController } from "./settings.controller";

/** Configuração & Conta (M14) — reusa AgentConfigService + CadenceConfigService + SchedulingConfigService (0034). */
@Module({
  imports: [AgentModule, CadenceModule, CalendarModule],
  controllers: [SettingsController],
})
export class SettingsModule {}
