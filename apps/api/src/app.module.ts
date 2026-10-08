import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import type { AppConfig } from "@sdr/config";
import { AppConfigModule, APP_CONFIG } from "./config/config.module";
import { RedisModule } from "./redis/redis.module";
import { AuthModule } from "./auth/auth.module";
import { QueueModule } from "./queue/queue.module";
import { MeteringModule } from "./metering/metering.module";
import { WhatsappModule } from "./whatsapp/whatsapp.module";
import { LlmModule } from "./llm/llm.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { OutboxModule } from "./outbox/outbox.module";
import { CurationModule } from "./curation/curation.module";
import { VerticalsModule } from "./verticals/verticals.module";
import { OpsModule } from "./ops/ops.module";
import { BaileysModule } from "./baileys/baileys.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { PanelModule } from "./panel/panel.module";
import { PlaygroundModule } from "./playground/playground.module";
import { TemplatesModule } from "./templates/templates.module";
import { SettingsModule } from "./settings/settings.module";
import { PlatformModule } from "./platform/platform.module";
import { CalendarModule } from "./calendar/calendar.module";
import { ImobModule } from "./imobiliario/imob.module";
import { IntakeModule } from "./intake/intake.module";
import { HealthModule } from "./observability/health.module";
import { buildPinoParams } from "./observability/logger";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { RolesGuard } from "./auth/roles.guard";
import { RequestContextMiddleware } from "./context/request-context.middleware";

@Module({
  imports: [
    AppConfigModule,
    // ThrottlerModule é GLOBAL: registrar UMA vez aqui. O limite por rota é
    // definido com @Throttle() (login/refresh = 10/min; plataforma = 30/min).
    // Registrar forRoot em mais de um módulo faz o segundo sobrescrever o
    // primeiro (perdíamos o limite do login).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 30 }]),
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => buildPinoParams(cfg),
    }),
    RedisModule,
    AuthModule,
    QueueModule,
    MeteringModule,
    WhatsappModule,
    LlmModule,
    KnowledgeModule,
    OutboxModule,
    CurationModule,
    VerticalsModule,
    OpsModule,
    BaileysModule,
    OnboardingModule,
    PanelModule,
    PlaygroundModule,
    TemplatesModule,
    SettingsModule,
    PlatformModule,
    CalendarModule,
    // Vertical imobiliária (fork sdr-ia-imob): distribuição p/ corretores + SLA
    ImobModule,
    // Entrada de leads de campanha (Meta Lead Ads / integrações)
    IntakeModule,
    HealthModule,
  ],
  providers: [
    // Ordem importa: autentica (entra no contexto de tenant) e depois RBAC.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
