import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { runWithTenant } from "@sdr/core";
import type { AppConfig } from "@sdr/config";
import { listActiveConnectionsByProvider } from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { OutboxService } from "../outbox/outbox.service";
import { runsSessionWorker } from "../runtime/roles";
import { BaileysSessionManager } from "./baileys-session.manager";

const SCAN_EVERY_MS = 15_000;

/**
 * Tick de OUTBOX proativo do Baileys (M13): roda SÓ no session-worker. Varre os
 * números Baileys que ESTE worker possui (socket aberto) e processa o outbox de
 * cada tenant pelo socket local. O scheduler ignora tenants Baileys (partição no
 * OutboxService), então não há claim cruzado nem dupla entrega. Os guardrails do
 * M8 (opt-out/janela/resolvido) são revalidados no envio pelo próprio OutboxService.
 */
@Injectable()
export class BaileysOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BaileysOutboxWorker.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly outbox: OutboxService,
    private readonly manager: BaileysSessionManager,
  ) {}

  onModuleInit(): void {
    if (!runsSessionWorker(this.cfg.app.role) || !this.cfg.baileys.enabled) return;
    // Registra o seam de envio Baileys no OutboxService SÓ aqui (session-worker) —
    // evita dependência circular de módulo e mantém o scheduler sem envio Baileys.
    this.outbox.setBaileysOutbound(this.manager);
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.logger.error(`tick outbox Baileys falhou: ${e instanceof Error ? e.message : e}`));
    }, SCAN_EVERY_MS);
    this.timer.unref?.();
  }

  /** Processa o outbox dos números Baileys com socket vivo neste worker. */
  async tick(): Promise<void> {
    const conns = await listActiveConnectionsByProvider("baileys");
    for (const c of conns) {
      if (!this.manager.ownsLiveSocket(c.phoneNumberId)) continue; // não-dono ou socket fechado
      try {
        await runWithTenant({ tenantId: c.tenantId }, () => this.outbox.processDue(50));
      } catch (err) {
        this.logger.warn(`outbox Baileys do tenant ${c.tenantId} falhou: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
