import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { GoogleCalendarService } from "./google-calendar.service";
import { SchedulingConfigService } from "./scheduling-config.service";
import { SchedulingService } from "./scheduling.service";

/**
 * Agenda da plataforma (0034): CRUD da agenda interna (UI estilo Google
 * Agenda), integração Google Calendar via conta de serviço e o motor de
 * disponibilidade/reserva usado pelas tools do agente (AgentModule importa
 * este módulo para injetar o SchedulingService no handler).
 */
@Module({
  controllers: [CalendarController],
  providers: [GoogleCalendarService, SchedulingConfigService, SchedulingService],
  exports: [GoogleCalendarService, SchedulingConfigService, SchedulingService],
})
export class CalendarModule {}
