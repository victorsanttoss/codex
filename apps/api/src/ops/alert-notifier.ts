import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { APP_CONFIG } from "../config/config.module";

export type AlertSeverity = "warning" | "critical";

export interface AlertEvent {
  kind: string;
  severity: AlertSeverity;
  message: string;
  metadata?: Record<string, unknown>;
}

export const ALERT_NOTIFIER = "ALERT_NOTIFIER";

/** Canal de alerta ao operador (injetável; testes usam um fake). */
export interface AlertNotifier {
  notify(alert: AlertEvent): Promise<void>;
}

/**
 * Notificador default: POST num webhook do operador (Telegram/Slack/custom). Sem
 * webhook configurado → só log (nunca silencioso). Segredos nunca no corpo.
 */
@Injectable()
export class WebhookAlertNotifier implements AlertNotifier {
  private readonly logger = new Logger(WebhookAlertNotifier.name);

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async notify(alert: AlertEvent): Promise<void> {
    const line = `[${alert.severity.toUpperCase()}] ${alert.kind}: ${alert.message}`;
    if (alert.severity === "critical") this.logger.error(line);
    else this.logger.warn(line);
    const url = this.cfg.alerts.webhookUrl;
    if (!url) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: line, ...(alert.metadata ? { metadata: alert.metadata } : {}) }),
      });
    } catch (err) {
      this.logger.error(`Falha ao enviar alerta: ${err instanceof Error ? err.message : err}`);
    }
  }
}
