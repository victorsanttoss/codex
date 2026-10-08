import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { AppConfig } from "@sdr/config";
import { APP_CONFIG } from "../config/config.module";
import { runsWorkers } from "../runtime/roles";
import {
  KnowledgeIngestService,
  type IngestJob,
  type ReindexJob,
} from "./knowledge-ingest.service";

type KnowledgeJob =
  | { kind: "ingest"; payload: IngestJob }
  | { kind: "reindex"; payload: ReindexJob };

const QUEUE_NAME = "knowledge-ingest";

/**
 * Fila durável de ingestão de conhecimento. O controller ENFILEIRA e responde
 * rápido; o worker processa (chunk → embed → persist) com retry. Concorrência
 * entre fontes; a idempotência por content_hash protege re-tentativas.
 */
@Injectable()
export class KnowledgeQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeQueue.name);
  private queue?: Queue<KnowledgeJob>;
  private worker?: Worker<KnowledgeJob>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly ingest: KnowledgeIngestService,
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
    this.queue = new Queue<KnowledgeJob>(QUEUE_NAME, { connection: this.connection() });
    if (!runsWorkers(this.cfg.app.role)) return; // só o WORKER consome
    this.worker = new Worker<KnowledgeJob>(
      QUEUE_NAME,
      async (job) => {
        if (job.data.kind === "ingest") await this.ingest.ingest(job.data.payload);
        else await this.ingest.reindex(job.data.payload);
      },
      { connection: this.connection(), concurrency: 4 },
    );
    this.worker.on("failed", (job, err) =>
      this.logger.error(`Job ${job?.id} falhou: ${err.message}`),
    );
  }

  async enqueueIngest(payload: IngestJob): Promise<void> {
    await this.add({ kind: "ingest", payload });
  }

  async enqueueReindex(payload: ReindexJob): Promise<void> {
    await this.add({ kind: "reindex", payload });
  }

  private async add(job: KnowledgeJob): Promise<void> {
    if (!this.queue) throw new Error("KnowledgeQueue não inicializada");
    await this.queue.add(job.kind, job, {
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
