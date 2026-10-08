import { createHash } from "node:crypto";
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
import { APP_CONFIG } from "../config/config.module";
import { runsWorkers } from "../runtime/roles";
import { safeErrorFields } from "../observability/logger";
import { CrmSyncService, type LeadSyncPayload } from "./crm-sync.service";

export interface SyncJob extends LeadSyncPayload {
  tenantId: string;
}

const QUEUE_NAME = "crm-sync";

/**
 * Identidade por empresa, conversa e conteúdo, sem `:` (reservado pelo BullMQ).
 * Ordenar as chaves torna equivalentes campos JSON com ordem diferente.
 * O mesmo conteúdo é deduplicado apenas enquanto o job existir no Redis
 * (inclusive após completar, durante a retenção). Depois de removido, poderá
 * ser executado novamente; a idempotência do destino continua necessária.
 */
export function syncJobId(job: SyncJob): string {
  const discriminator = createHash("sha256")
    .update(
      JSON.stringify(
        {
          tenantId: job.tenantId,
          conversationId: job.conversationId,
          phone: job.phone,
          name: job.name ?? null,
          fields: job.fields,
          stage: job.stage,
          status: job.status,
          score: job.score ?? null,
        },
        (_key, value: unknown) =>
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                Object.entries(value).sort(([left], [right]) =>
                  left < right ? -1 : left > right ? 1 : 0,
                ),
              )
            : value,
      ),
    )
    .digest("hex");
  return `crm-sync-${discriminator}`;
}

/** Fila durável de sync com o CRM (retry). O worker roda no contexto do tenant. */
@Injectable()
export class CrmSyncQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CrmSyncQueue.name);
  private queue?: Queue<SyncJob>;
  private worker?: Worker<SyncJob>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly sync: CrmSyncService,
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

  onModuleInit(): void {
    this.queue = new Queue<SyncJob>(QUEUE_NAME, {
      connection: this.connection(),
    });
    if (!runsWorkers(this.cfg.app.role)) return; // só o WORKER consome
    this.worker = new Worker<SyncJob>(
      QUEUE_NAME,
      async (job) => {
        const { tenantId, ...payload } = job.data;
        await runWithTenant({ tenantId }, () => this.sync.sync(payload));
      },
      { connection: this.connection(), concurrency: 4 },
    );
    this.worker.on("failed", (job, err) =>
      this.logger.error({
        event: "crm_sync_failed",
        jobId: job?.id,
        tenantId: job?.data.tenantId,
        conversationId: job?.data.conversationId,
        error: safeErrorFields(err),
      }),
    );
  }

  async enqueueSync(job: SyncJob): Promise<void> {
    if (!this.queue) throw new Error("CrmSyncQueue não inicializada");
    // Dedup por conteúdo enquanto retido no Redis; payload novo passa.
    await this.queue.add("sync", job, {
      jobId: syncJobId(job),
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
