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
import { listActiveTenantIds } from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { runsScheduler } from "../runtime/roles";
import { CadenceService } from "./cadence.service";

const QUEUE_NAME = "cadence-scan";
const SCAN_EVERY_MS = 60_000;

/** Worker repetível: varre cadências vencidas de cada tenant ativo e dispara. */
@Injectable()
export class CadenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CadenceWorker.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly cadence: CadenceService,
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
    if (!runsScheduler(this.cfg.app.role)) return; // varredura de cadência é do SCHEDULER
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection() });
    this.worker = new Worker(QUEUE_NAME, async () => this.tick(), {
      connection: this.connection(),
      concurrency: 1,
    });
    this.worker.on("failed", (_job, err) => this.logger.error(`Cadência tick falhou: ${err.message}`));
    await this.queue.add("scan", {}, { repeat: { every: SCAN_EVERY_MS }, removeOnComplete: 10, removeOnFail: 50 });
  }

  async tick(): Promise<void> {
    for (const tenantId of await listActiveTenantIds()) {
      try {
        await runWithTenant({ tenantId }, () => this.cadence.scanAndDispatch());
      } catch (err) {
        this.logger.warn(`Cadência do tenant ${tenantId} falhou: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
