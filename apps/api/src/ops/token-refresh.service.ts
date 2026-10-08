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
  listActiveTenantIds,
  listExpiringConnections,
  makeCipherFromEnv,
  TenantSecretsStore,
  upsertChannelConnection,
  type ExpiringConnection,
} from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { runsScheduler } from "../runtime/roles";
import { ALERT_NOTIFIER, type AlertNotifier } from "./alert-notifier";

export const TOKEN_REFRESHER = "TOKEN_REFRESHER";

/**
 * Estratégia de refresh de token (provider-specific, injetável). Devolve o novo
 * token + expiração, ou null se não há como renovar automaticamente.
 */
export interface TokenRefresher {
  refresh(conn: ExpiringConnection): Promise<{ token?: string; expiresAt: Date } | null>;
}

/** Default: sem refresh automático para Cloud API (system-user) — alerta o operador. */
@Injectable()
export class NoopTokenRefresher implements TokenRefresher {
  async refresh(): Promise<null> {
    return null;
  }
}

const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const HORIZON_MS = 3 * 24 * 60 * 60 * 1000; // 3 dias de antecedência

/**
 * Refresh PROATIVO de token (resolve a dívida do M3). Antes da expiração: tenta
 * renovar; sucesso → atualiza `token_expires_at` (e o segredo, se veio novo);
 * falha/sem estratégia → ALERTA o operador (reconectar via Embedded Signup) ANTES
 * de o token expirar de madrugada e silenciar o cliente. Não desconecta um token
 * ainda válido — o caminho de envio (M3) já desconecta em 401/190.
 */
@Injectable()
export class TokenRefreshService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TokenRefreshService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(TOKEN_REFRESHER) private readonly refresher: TokenRefresher,
    @Inject(ALERT_NOTIFIER) private readonly notifier: AlertNotifier,
  ) {}

  /** Renova/alerta as conexões com token vencendo antes de `now + horizonte`. Testável. */
  async refreshExpiring(now: Date = new Date(), horizonMs = HORIZON_MS): Promise<{ refreshed: number; alerted: number }> {
    const before = new Date(now.getTime() + horizonMs);
    let refreshed = 0;
    let alerted = 0;
    for (const tenantId of await listActiveTenantIds()) {
      const expiring = await runWithTenant({ tenantId }, () => listExpiringConnections(before));
      for (const conn of expiring) {
        try {
          const res = await this.refresher.refresh(conn);
          if (res) {
            await runWithTenant({ tenantId }, async () => {
              // grava o TOKEN NOVO (cifrado) — senão o envio segue com o token velho.
              if (res.token) {
                await new TenantSecretsStore(makeCipherFromEnv()).put(conn.secretRef, res.token);
              }
              await upsertChannelConnection({ phoneNumberId: conn.phoneNumberId, tokenExpiresAt: res.expiresAt });
            });
            refreshed++;
            this.logger.log(`Token de ${conn.phoneNumberId} (tenant ${tenantId}) renovado.`);
            continue;
          }
        } catch (err) {
          this.logger.warn(`Refresh de ${conn.phoneNumberId} falhou: ${err instanceof Error ? err.message : err}`);
        }
        // sem refresh → alerta proativo (reconectar antes de expirar).
        await this.notifier.notify({
          kind: "token_refresh_needed",
          severity: "warning",
          message: `Token de ${conn.phoneNumberId} (tenant ${tenantId}) expira em ${conn.tokenExpiresAt?.toISOString()} e não pôde ser renovado automaticamente — reconectar.`,
          metadata: { tenantId, phoneNumberId: conn.phoneNumberId },
        });
        alerted++;
      }
    }
    return { refreshed, alerted };
  }

  onModuleInit(): void {
    if (!runsScheduler(this.cfg.app.role)) return;
    this.timer = setInterval(() => {
      void this.refreshExpiring().catch((e) => this.logger.error(`refresh falhou: ${e.message}`));
    }, SCAN_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
