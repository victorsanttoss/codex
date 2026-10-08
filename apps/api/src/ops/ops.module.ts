import { Module } from "@nestjs/common";
import { ALERT_NOTIFIER, WebhookAlertNotifier } from "./alert-notifier";
import { AlertsService } from "./alerts.service";
import { NoopTokenRefresher, TOKEN_REFRESHER, TokenRefreshService } from "./token-refresh.service";
import { ShutdownService } from "./shutdown.service";

/**
 * Operação (M11): alertas internos + refresh proativo de token. Os scans só rodam
 * no SCHEDULER (gating por role). Notificador e refresher são injetáveis.
 */
@Module({
  providers: [
    { provide: ALERT_NOTIFIER, useClass: WebhookAlertNotifier },
    { provide: TOKEN_REFRESHER, useClass: NoopTokenRefresher },
    AlertsService,
    TokenRefreshService,
    ShutdownService,
  ],
  exports: [ALERT_NOTIFIER, AlertsService],
})
export class OpsModule {}
