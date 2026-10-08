import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module";
import { RedisModule } from "../redis/redis.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { OpsModule } from "../ops/ops.module";
import { OutboxModule } from "../outbox/outbox.module";
import { baileysRegistryProvider } from "./baileys.registry";
import { baileysDriverProvider } from "./baileys.driver.provider";
import { baileysSessionStoreProvider } from "./baileys-session-store.provider";
import { qrStoreProvider } from "./qr-store.provider";
import { BaileysSessionManager } from "./baileys-session.manager";
import { BaileysOutboxWorker } from "./baileys-outbox.worker";
import { BaileysOnboardingController } from "./baileys-onboarding.controller";

/**
 * Canal NÃO-OFICIAL via Baileys (M13). Topologia de SESSION-WORKER: o
 * BaileysSessionManager mantém os sockets vivos dos números atribuídos (sticky),
 * alimenta o MESMO núcleo de entrada (InboundCore) e roteia o envio proativo pelo
 * socket dono (BAILEYS_OUTBOUND → OutboxService). Onboarding por QR via controller
 * + Redis. Default do produto continua a Cloud API; Baileys é opção por tenant.
 */
@Module({
  imports: [RedisModule, QueueModule, WhatsappModule, OpsModule, OutboxModule],
  controllers: [BaileysOnboardingController],
  providers: [
    baileysRegistryProvider,
    baileysDriverProvider,
    baileysSessionStoreProvider,
    qrStoreProvider,
    BaileysSessionManager,
    BaileysOutboxWorker,
  ],
})
export class BaileysModule {}
