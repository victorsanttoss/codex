import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { runWithTenant } from "@sdr/core";
import type { AppConfig } from "@sdr/config";
import {
  deleteExpiredQuarantine,
  listActiveTenantIds,
  listReplayableQuarantine,
  markQuarantineReplayed,
} from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { runsScheduler } from "../runtime/roles";
import { WebhookQueue, type WebhookJob } from "./webhook.queue";

const SWEEP_INTERVAL_MS = 60_000; // ~60s: reconexão vira replay em até 1 min

/**
 * REPLAY da quarentena de inbound (0032). A cada ~60s varre, por tenant ativo,
 * as linhas não-replayed cuja conexão VOLTOU a `active` e re-enfileira o payload
 * na WebhookQueue em ordem de received_at — a mensagem re-entra pela MESMA
 * pipeline (assinatura re-verifica; dedup pula o que já foi processado; FIFO por
 * conversa preserva a ordem). Linhas expiradas (~48h) são apagadas: fora da
 * janela de 24h a resposta free-form já não seria possível.
 */
@Injectable()
export class QuarantineReplayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuarantineReplayService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly queue: WebhookQueue,
  ) {}

  /** Uma passada do sweep (testável): expira velhas + re-enfileira liberadas. */
  async sweep(now: Date = new Date()): Promise<{ replayed: number; expired: number }> {
    let replayed = 0;
    let expired = 0;
    for (const tenantId of await listActiveTenantIds()) {
      await runWithTenant({ tenantId }, async () => {
        expired += await deleteExpiredQuarantine(now);
        const rows = await listReplayableQuarantine(100, now);
        for (const row of rows) {
          // Enfileira e marca UMA a uma, na ordem: se o processo cair no meio,
          // as não-marcadas voltam no próximo tick (at-least-once; o dedup do
          // pipeline protege contra o replay duplicado das já enfileiradas).
          await this.queue.enqueue(row.payload as unknown as WebhookJob);
          await markQuarantineReplayed([row.id]);
          replayed++;
        }
        if (rows.length > 0) {
          this.logger.log(
            `Quarentena: ${rows.length} payload(s) re-enfileirado(s) para o tenant ${tenantId}.`,
          );
        }
      });
    }
    return { replayed, expired };
  }

  onModuleInit(): void {
    if (!runsScheduler(this.cfg.app.role)) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((e: Error) => this.logger.error(`Sweep da quarentena falhou: ${e.message}`));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
