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
import { listTenantsWithDueOutbox, sweepStuckOutbox } from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { runsScheduler } from "../runtime/roles";
import { OutboxService } from "./outbox.service";

const QUEUE_NAME = "outbox-dispatch";
const SCAN_EVERY_MS = 15_000;
/** Tenants processados em paralelo por tick (limite p/ não saturar pool/provedor). */
const TENANT_PARALLELISM = 4;

/**
 * Worker repetível: a cada intervalo, varre os tenants ativos e processa o outbox
 * vencido de cada um no contexto do tenant. Idempotente/concorrência-segura
 * (SKIP LOCKED no claim). O envio em si é at-least-once com dedup no provedor.
 */
@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly outbox: OutboxService,
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
    if (!runsScheduler(this.cfg.app.role)) return; // varredura é do SCHEDULER
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection() });
    this.worker = new Worker(QUEUE_NAME, async () => this.tick(), {
      connection: this.connection(),
      concurrency: 1,
    });
    this.worker.on("failed", (_job, err) => this.logger.error(`Outbox tick falhou: ${err.message}`));
    // job repetível (cron-like) — dispara a varredura periodicamente.
    await this.queue.add("scan", {}, { repeat: { every: SCAN_EVERY_MS }, removeOnComplete: 10, removeOnFail: 50 });
  }

  /**
   * Processa só os tenants COM outbox vencido (uma query system-level decide,
   * em vez de iterar todos os tenants a cada 15s), em lotes paralelos limitados.
   */
  async tick(): Promise<void> {
    const tenants = await listTenantsWithDueOutbox();
    for (let i = 0; i < tenants.length; i += TENANT_PARALLELISM) {
      const slice = tenants.slice(i, i + TENANT_PARALLELISM);
      const results = await Promise.allSettled(
        slice.map((tenantId) =>
          runWithTenant({ tenantId }, async () => {
            await this.outbox.processDue(50);
            // Sweep de 'sending' estagnado com tentativas esgotadas → 'failed'
            // (senão a linha fica invisível p/ sempre; 'failed' entra no alerta).
            const swept = await sweepStuckOutbox();
            if (swept > 0) this.logger.warn(`Outbox: ${swept} linha(s) 'sending' estagnada(s) marcadas failed (tenant ${tenantId}).`);
          }),
        ),
      );
      results.forEach((r, j) => {
        if (r.status === "rejected") {
          const err = r.reason;
          this.logger.warn(`Outbox do tenant ${slice[j]} falhou: ${err instanceof Error ? err.message : err}`);
        }
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
