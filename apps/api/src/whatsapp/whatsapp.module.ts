import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module";
import { AgentModule } from "../agent/agent.module";
import { AgentMessageHandler } from "../agent/agent-message.handler";
import { ChannelModule } from "./channel.module";
import { OutboxModule } from "../outbox/outbox.module";
import { TranscriptionModule } from "../transcription/transcription.module";
import { MediaService } from "./media.service";
import { InboundCoreService } from "./inbound-core.service";
import { InboundRateLimitService } from "./inbound-rate-limit.service";
import { InboundPipelineService } from "./inbound-pipeline.service";
import { INBOUND_HANDLER } from "./message-handler";
import { WebhookQueue } from "./webhook.queue";
import { QuarantineReplayService } from "./quarantine-replay.service";
import { AgentTurnRecoveryService } from "./agent-turn-recovery.service";
import { EmbeddedSignupService } from "./embedded-signup.service";
import { AccountEventsService } from "./account-events.service";
import { TemplateStatusEventsService } from "../templates/template-status-events.service";
import { WhatsappWebhookController } from "./webhook.controller";
import { WhatsappConnectionsController } from "./connections.controller";
import { WhatsappSignupController } from "./signup.controller";
import { ImobModule } from "../imobiliario/imob.module";

@Module({
  // OutboxModule: livro-razão de entrega compartilhado — o reply reativo registra
  // a linha `sent` via OutboxService (sem ciclo: OutboxModule importa só ChannelModule).
  // ImobModule (fork): desvio do inbound de CORRETORES (sem ciclo — imobiliário
  // não importa Whatsapp; responde pelo closure e envia proativo via outbox).
  imports: [
    QueueModule,
    AgentModule,
    ChannelModule,
    OutboxModule,
    TranscriptionModule,
    ImobModule,
  ],
  controllers: [
    WhatsappWebhookController,
    WhatsappConnectionsController,
    WhatsappSignupController,
  ],
  providers: [
    MediaService,
    InboundCoreService,
    InboundRateLimitService,
    InboundPipelineService,
    WebhookQueue,
    // 0032: sweep periódico (scheduler) que re-enfileira inbound quarentenado
    // quando a conexão volta a `active` — só ENFILEIRA na WebhookQueue.
    QuarantineReplayService,
    AgentTurnRecoveryService,
    EmbeddedSignupService,
    AccountEventsService,
    // M8-ext: status de aprovação de HSM (message_template_status_update) — vive
    // aqui (e não no TemplatesModule) para o worker do webhook consumir sem ciclo.
    TemplateStatusEventsService,
    // TokenExpiryService (M3) foi substituído pelo TokenRefreshService (M11/OpsModule).
    // M6: o agente substitui o EchoMessageHandler stub do M2 no seam.
    { provide: INBOUND_HANDLER, useExisting: AgentMessageHandler },
  ],
  exports: [InboundCoreService, MediaService],
})
export class WhatsappModule {}
