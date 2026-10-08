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
  getConnectionForConversation,
  listPendingAgentTurns,
  listTenantIdsWithPendingAgentTurns,
} from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { runsScheduler } from "../runtime/roles";
import { safeErrorFields } from "../observability/logger";
import { InboundPipelineService } from "./inbound-pipeline.service";

const SWEEP_INTERVAL_MS = 15_000;

/** Recovery is independent of webhook redelivery; only persisted plans are replayed. */
@Injectable()
export class AgentTurnRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTurnRecoveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly pipeline: InboundPipelineService,
  ) {}

  async sweep(): Promise<{
    attempted: number;
    failed: number;
    skipped: number;
  }> {
    const result = { attempted: 0, failed: 0, skipped: 0 };
    if (this.sweeping) return result;
    this.sweeping = true;
    try {
      for (const tenantId of await listTenantIdsWithPendingAgentTurns()) {
        await runWithTenant({ tenantId }, async () => {
          for (const turn of await listPendingAgentTurns(50, {
            provider: "cloud_api",
          })) {
            // Baileys recovery belongs to the session worker that owns its socket.
            if (!turn.conversationKey.startsWith("cloud_api:")) continue;
            try {
              const conn = await getConnectionForConversation(
                turn.conversationId,
              );
              if (
                !conn ||
                conn.provider !== "cloud_api" ||
                conn.status !== "active"
              ) {
                result.skipped++;
                continue;
              }
              if (turn.conversationKey.split(":")[1] !== conn.phoneNumberId) {
                result.skipped++;
                continue;
              }
              result.attempted++;
              await this.pipeline.recoverTurn(
                turn,
                {
                  tenantId,
                  connectionId: conn.connectionId,
                  secretRef: conn.secretRef,
                },
                conn.phoneNumberId,
              );
            } catch (err) {
              result.failed++;
              this.logger.error({
                event: "agent_turn_recovery_failed",
                tenantId,
                turnId: turn.id,
                error: safeErrorFields(err),
              });
            }
          }
        });
      }
      return result;
    } finally {
      this.sweeping = false;
    }
  }

  onModuleInit(): void {
    if (!runsScheduler(this.cfg.app.role)) return;
    const run = () => {
      void this.sweep().catch((err: unknown) =>
        this.logger.error({
          event: "agent_turn_recovery_sweep_failed",
          error: safeErrorFields(err),
        }),
      );
    };
    run();
    this.timer = setInterval(run, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
