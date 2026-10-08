import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import { runWithTenant } from "@sdr/core";
import type { AppConfig } from "@sdr/config";
import {
  claimImobDueStatusFollowups,
  createNotification,
  enqueueOutbox,
  expireImobAssignment,
  getImobAssignmentJoined,
  listImobDueAcceptExpiries,
  listTenantsWithImobDue,
  recordImobEvent,
  revertImobStatusPrompt,
} from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { runsScheduler } from "../runtime/roles";
import { ImobDistributionService } from "./imob-distribution.service";
import { IMOB_CONFIG } from "./imob.config";
import { buildStatusMenuMessage, leadDisplayName } from "./imob-messages";

const QUEUE_NAME = "imob-sla";
const SCAN_EVERY_MS = 60_000;
const TENANT_PARALLELISM = 4;

/**
 * SLA do fluxo imobiliário (padrão OutboxWorker/0029): a cada minuto varre os
 * tenants com trabalho e, no contexto de cada um:
 *  1. EXPIRA ofertas com aceite vencido e REDISTRIBUI para o próximo corretor;
 *  2. COBRA status de atendimentos aceitos parados (menu numérico ao corretor);
 *     na 3ª cobrança sem resposta, ALERTA o gestor.
 */
@Injectable()
export class ImobSlaWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImobSlaWorker.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly distribution: ImobDistributionService,
  ) {}

  private connection() {
    const u = new URL(this.cfg.redis.url);
    return {
      host: u.hostname,
      port: Number(u.port) || 6379,
      ...(u.username ? { username: u.username } : {}),
      ...(u.password ? { password: u.password } : {}),
      maxRetriesPerRequest: null,
    };
  }

  async onModuleInit(): Promise<void> {
    if (!runsScheduler(this.cfg.app.role)) return;
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection() });
    this.worker = new Worker(QUEUE_NAME, async () => this.tick(), {
      connection: this.connection(),
      concurrency: 1,
    });
    this.worker.on("failed", (_job, err) => this.logger.error(`Imob SLA tick falhou: ${err.message}`));
    await this.queue.add("scan", {}, { repeat: { every: SCAN_EVERY_MS }, removeOnComplete: 10, removeOnFail: 50 });
  }

  async tick(): Promise<void> {
    const tenants = await listTenantsWithImobDue();
    for (let i = 0; i < tenants.length; i += TENANT_PARALLELISM) {
      const slice = tenants.slice(i, i + TENANT_PARALLELISM);
      const results = await Promise.allSettled(
        slice.map((tenantId) =>
          runWithTenant({ tenantId }, async () => {
            await this.expireDueOffers();
            await this.sendDueFollowups();
          }),
        ),
      );
      results.forEach((r, j) => {
        if (r.status === "rejected") {
          const err = r.reason;
          this.logger.warn(`Imob SLA do tenant ${slice[j]} falhou: ${err instanceof Error ? err.message : err}`);
        }
      });
    }
  }

  /** 1) Aceite vencido: expira (guard por status) e redistribui. */
  private async expireDueOffers(): Promise<void> {
    const due = await listImobDueAcceptExpiries();
    for (const offer of due) {
      const expired = await expireImobAssignment(offer.id);
      if (!expired) continue; // corrida benigna: corretor respondeu no meio
      await recordImobEvent({
        conversationId: offer.conversationId,
        assignmentId: offer.id,
        brokerId: offer.brokerId,
        type: "expired",
        metadata: { attempt: offer.attempt },
      });
      await this.distribution.redistributeSafely(offer.conversationId, offer.attempt);
    }
  }

  /** 2) Atendimento aceito parado: cobra status; 3ª sem resposta alerta o gestor. */
  private async sendDueFollowups(): Promise<void> {
    // CLAIM atômico (SKIP LOCKED): réplicas/ticks sobrepostos não duplicam a
    // cobrança. As linhas voltam JÁ marcadas (followupCount incrementado).
    const due = await claimImobDueStatusFollowups({
      inactivityMs: IMOB_CONFIG.followupInactivityHours * 3_600_000,
      maxFollowups: IMOB_CONFIG.maxFollowups,
    });
    for (const a of due) {
      const joined = await getImobAssignmentJoined(a.id);
      if (!joined) continue;
      const leadName = leadDisplayName(joined.leadFields, joined.contactName);

      try {
        await enqueueOutbox({
          toPhone: joined.brokerWhatsapp,
          kind: "free_form",
          payload: { text: buildStatusMenuMessage(joined.brokerName, leadName, IMOB_CONFIG.projectName) },
          idempotencyKey: `imob:followup:${a.id}:${a.followupCount}`,
          clientMessageId: `imob-followup-${a.id}-${a.followupCount}`,
          billing: "service",
        });
      } catch (err) {
        // Compensa o claim: devolve contador/prompt p/ o próximo tick re-tentar
        // (senão a cobrança "sai" no contador sem nunca chegar ao corretor).
        this.logger.error(
          `Enqueue de follow-up falhou (assignment ${a.id}) — revertendo claim: ${err instanceof Error ? err.message : err}`,
        );
        await revertImobStatusPrompt(a.id).catch(() => undefined);
        continue;
      }
      await recordImobEvent({
        conversationId: a.conversationId,
        assignmentId: a.id,
        brokerId: a.brokerId,
        type: "followup_sent",
        metadata: { count: a.followupCount },
      });

      // Esta era a última cobrança permitida → alerta o gestor (uma vez).
      if (a.followupCount >= IMOB_CONFIG.maxFollowups) {
        await createNotification({
          idempotencyKey: `imob:silent:${a.id}`,
          kind: "handoff",
          title: "Corretor sem resposta",
          body: `Corretor ${joined.brokerName} não responde sobre o lead ${leadName} após ${IMOB_CONFIG.maxFollowups} cobranças — verificar atendimento.`,
        }).catch((err) =>
          this.logger.warn(`Alerta de corretor silencioso falhou: ${err instanceof Error ? err.message : err}`),
        );
        await recordImobEvent({
          conversationId: a.conversationId,
          assignmentId: a.id,
          brokerId: a.brokerId,
          type: "alert",
          metadata: { reason: "broker_silent", followups: a.followupCount },
        });
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
