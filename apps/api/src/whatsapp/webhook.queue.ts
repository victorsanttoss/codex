import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { AppConfig } from "@sdr/config";
import { APP_CONFIG } from "../config/config.module";
import { REDIS_CLIENT } from "../redis/redis.module";
import { runsWorkers } from "../runtime/roles";
import { LockTimeoutError } from "../queue/redis-mutex";
import { InboundPipelineService, InboundProcessingError } from "./inbound-pipeline.service";
import { AccountEventsService } from "./account-events.service";
import { TemplateStatusEventsService } from "../templates/template-status-events.service";

export interface WebhookJob {
  headers: Record<string, string>;
  query: Record<string, string>;
  rawBody: string;
  /** Nº de re-enfileiramentos por contenção de lock (interno; ver requeue abaixo). */
  lockRequeues?: number;
  /** Nº de re-enfileiramentos por COTA de jobs em voo do tenant (fair-scheduling). */
  quotaRequeues?: number;
}

/**
 * Extrai o `phone_number_id` do payload como CHAVE DE JUSTIÇA (proxy de tenant)
 * SEM tocar o banco: barato o suficiente para rodar por job. Se o parse falhar,
 * a cota é ignorada (processa normal). O 1º encontrado basta (webhooks com vários
 * números são raros).
 */
export function fairnessKeyFromRawBody(rawBody: string): string | undefined {
  try {
    const body = JSON.parse(rawBody) as {
      entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: unknown } } }> }>;
    };
    for (const e of body.entry ?? []) {
      for (const c of e.changes ?? []) {
        const pnid = c.value?.metadata?.phone_number_id;
        if (typeof pnid === "string" && pnid) return pnid;
      }
    }
  } catch {
    /* payload não-JSON / formato inesperado → sem cota */
  }
  return undefined;
}

const QUEUE_NAME = "whatsapp-webhook";

/** Delay do re-enfileiramento quando a conversa está com o lock ocupado. */
const LOCK_REQUEUE_DELAY_MS = 4_000;
/**
 * Teto de re-enfileiramentos por contenção: ~4min cobre o pior caso de um
 * detentor no teto do lock (maxHoldMs 180s) + folga. Depois disso o job falha
 * de vez (algo está estruturalmente errado, não é contenção normal).
 */
const MAX_LOCK_REQUEUES = 60;

/**
 * COTA de jobs em voo por tenant (fair-scheduling / anti "noisy neighbor"): a
 * fila é global com concurrency 16; sem cota, um tenant inundado ocupa todos os
 * slots e trava os demais. Um tenant pode processar no máximo
 * MAX_INFLIGHT_PER_TENANT jobs simultâneos (~metade da concurrency) — o excedente
 * é RE-ENFILEIRADO com delay, liberando slots para outros tenants. Contador Redis
 * com TTL de auto-cura (se um worker morrer sem decrementar, o contador expira).
 */
const MAX_INFLIGHT_PER_TENANT = 8;
const INFLIGHT_TTL_S = 300; // > maxHoldMs do lock (180s) + folga
const QUOTA_REQUEUE_DELAY_MS = 1_500;
/** Teto de re-enfileiramentos por cota: além disto, processa mesmo assim (não perde). */
const MAX_QUOTA_REQUEUES = 200;

/** O erro do pipeline inclui contenção de lock de conversa? (→ requeue, não retry). */
export function isLockContention(err: unknown): boolean {
  if (err instanceof LockTimeoutError) return true;
  return err instanceof InboundProcessingError && err.causes.some((c) => c instanceof LockTimeoutError);
}

/**
 * Fila durável de eventos do webhook. O controller ENFILEIRA e responde 200
 * rápido (achado ALTO do Codex: não processar síncrono); o worker processa
 * (com retry). A ordem FIFO por conversa continua garantida pelo SerializedRunner
 * dentro do pipeline; a concorrência aqui é entre conversas distintas.
 */
@Injectable()
export class WebhookQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookQueue.name);
  private queue?: Queue<WebhookJob>;
  private worker?: Worker<WebhookJob>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly pipeline: InboundPipelineService,
    private readonly accountEvents: AccountEventsService,
    private readonly templateStatus: TemplateStatusEventsService,
  ) {}

  // Opções de conexão (não instância) — o BullMQ cria as próprias conexões e
  // evita o conflito de versões do ioredis no monorepo.
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
    // Producer (enqueue do controller) existe em qualquer role.
    this.queue = new Queue<WebhookJob>(QUEUE_NAME, { connection: this.connection() });
    if (!runsWorkers(this.cfg.app.role)) return; // só o WORKER consome
    this.worker = new Worker<WebhookJob>(
      QUEUE_NAME,
      async (job) => {
        // Eventos de conta (lifecycle) ANTES das mensagens: são idempotentes e
        // não podem ficar reféns de falha/contenção do pipeline de mensagens do
        // mesmo webhook (achado Codex) — ex.: desconexão precisa ser registrada
        // mesmo que uma mensagem do payload esteja falhando.
        await this.accountEvents.process(job.data);
        // M8-ext: aprovação de template (idempotente, fora da pipeline de msg).
        await this.templateStatus.process(job.data);

        // Fair-scheduling: se o tenant já ocupa a cota de jobs em voo, devolve o
        // slot e re-enfileira com delay (até o teto) — evita monopolizar os 16
        // slots. O contador (Redis) é liberado no finally abaixo.
        const fairKey = fairnessKeyFromRawBody(job.data.rawBody);
        const inflightKey = fairKey ? `wq:inflight:${fairKey}` : undefined;
        let heldSlot = false;
        if (inflightKey) {
          const n = await this.redis.incr(inflightKey);
          await this.redis.expire(inflightKey, INFLIGHT_TTL_S);
          heldSlot = true;
          const quotaRequeues = job.data.quotaRequeues ?? 0;
          if (n > MAX_INFLIGHT_PER_TENANT && quotaRequeues < MAX_QUOTA_REQUEUES) {
            await this.redis.decr(inflightKey).catch(() => undefined);
            heldSlot = false;
            await this.enqueue(
              { ...job.data, quotaRequeues: quotaRequeues + 1 },
              { delayMs: QUOTA_REQUEUE_DELAY_MS },
            );
            this.logger.warn(
              `Cota de jobs em voo do tenant (${fairKey}) atingida (${MAX_INFLIGHT_PER_TENANT}) — job ${job.id} re-enfileirado (${quotaRequeues + 1}/${MAX_QUOTA_REQUEUES}).`,
            );
            return;
          }
        }
        try {
          await this.pipeline.process(job.data); // mensagens + status
        } catch (err) {
          // Contenção do FIFO por conversa (turno anterior ainda rodando): em vez
          // de queimar os attempts do BullMQ (mensagem seria PERDIDA ao esgotar),
          // re-enfileira com delay e completa o job atual (at-least-once — as
          // mensagens já processadas do webhook são puladas pelo dedup).
          if (isLockContention(err)) {
            const requeues = (job.data.lockRequeues ?? 0) + 1;
            if (requeues <= MAX_LOCK_REQUEUES) {
              await this.enqueue(
                { ...job.data, lockRequeues: requeues },
                { delayMs: LOCK_REQUEUE_DELAY_MS },
              );
              this.logger.warn(
                `Conversa ocupada (lock) — job ${job.id} re-enfileirado (${requeues}/${MAX_LOCK_REQUEUES}).`,
              );
              return;
            }
          }
          throw err; // falha o job → retry do BullMQ (backoff) ou DLQ ao esgotar
        } finally {
          // Libera o slot da cota (se tomado) — sempre, inclusive em erro/requeue.
          if (heldSlot && inflightKey) await this.redis.decr(inflightKey).catch(() => undefined);
        }
      },
      // I/O-bound (LLM/HTTP/DB): concorrência maior entre conversas distintas.
      { connection: this.connection(), concurrency: 16 },
    );
    this.worker.on("failed", (job, err) =>
      this.logger.error(`Job ${job?.id} falhou: ${err.message}`),
    );
  }

  async enqueue(job: WebhookJob, opts?: { delayMs?: number }): Promise<void> {
    if (!this.queue) throw new Error("WebhookQueue não inicializada");
    await this.queue.add("event", job, {
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      ...(opts?.delayMs !== undefined ? { delay: opts.delayMs } : {}),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
