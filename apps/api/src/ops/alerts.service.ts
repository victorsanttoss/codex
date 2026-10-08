import { statfs } from "node:fs/promises";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Queue } from "bullmq";
import { runWithTenant } from "@sdr/core";
import type { AppConfig } from "@sdr/config";
import {
  countNonActiveConnections,
  countOutboxFailed,
  listActiveTenantIds,
  listExpiringConnections,
} from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { runsScheduler } from "../runtime/roles";
import { ALERT_NOTIFIER, type AlertEvent, type AlertNotifier } from "./alert-notifier";

const TOKEN_HORIZON_MS = 3 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5min
const QUEUE_NAMES = ["whatsapp-webhook", "crm-sync", "knowledge-ingest", "outbox-dispatch", "cadence-scan"];

export interface AlertSignals {
  diskUsedPercent: number;
  expiringTokens: number;
  outboxFailed: number;
  downConnections: number;
  queueBacklog: number;
}

export interface AlertThresholds {
  diskPercent: number;
  outboxFailed: number;
  queueBacklog: number;
}

/**
 * AVALIAÇÃO PURA (testável): converte sinais + limiares em alertas. Disco e
 * outbox-falho críticos; o resto warning. Numa VPS, simples é melhor.
 */
export function evaluateAlerts(s: AlertSignals, t: AlertThresholds): AlertEvent[] {
  const out: AlertEvent[] = [];
  if (s.diskUsedPercent >= t.diskPercent) {
    out.push({ kind: "disk", severity: "critical", message: `Disco em ${s.diskUsedPercent}% (limiar ${t.diskPercent}%).` });
  }
  if (s.outboxFailed >= t.outboxFailed) {
    out.push({ kind: "outbox_failed", severity: "critical", message: `${s.outboxFailed} mensagens 'failed' no outbox.` });
  }
  if (s.downConnections > 0) {
    out.push({ kind: "connection_down", severity: "warning", message: `${s.downConnections} conexão(ões) de tenant fora do ar.` });
  }
  if (s.expiringTokens > 0) {
    out.push({ kind: "token_expiring", severity: "warning", message: `${s.expiringTokens} token(s) de WhatsApp perto de expirar.` });
  }
  if (s.queueBacklog >= t.queueBacklog) {
    out.push({ kind: "queue_backlog", severity: "critical", message: `Filas com ${s.queueBacklog} jobs acumulados (limiar ${t.queueBacklog}) — worker travado?` });
  }
  return out;
}

/**
 * Checador de alertas internos (SCHEDULER). Periodicamente reúne sinais (disco,
 * tokens, outbox falho, conexões caídas) e dispara alertas ao operador. Mantido
 * simples para VPS — sem stack pesada de observabilidade no dia 1.
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertsService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(ALERT_NOTIFIER) private readonly notifier: AlertNotifier,
  ) {}

  /** Reúne sinais reais (disco + por-tenant). Testável via injeção de override. */
  async gatherSignals(diskPath = "/"): Promise<AlertSignals> {
    let diskUsedPercent = 0;
    try {
      const fsStat = await statfs(diskPath);
      const total = Number(fsStat.blocks);
      const free = Number(fsStat.bavail);
      if (total > 0) diskUsedPercent = Math.round((1 - free / total) * 100);
    } catch {
      /* sem disco acessível (ex.: ambiente sem statfs) → 0 */
    }
    let outboxFailed = 0;
    let downConnections = 0;
    let expiringTokens = 0;
    const tokenBefore = new Date(Date.now() + TOKEN_HORIZON_MS);
    for (const tenantId of await listActiveTenantIds()) {
      outboxFailed += await runWithTenant({ tenantId }, () => countOutboxFailed());
      downConnections += await runWithTenant({ tenantId }, () => countNonActiveConnections());
      expiringTokens += (await runWithTenant({ tenantId }, () => listExpiringConnections(tokenBefore))).length;
    }
    const queueBacklog = await this.measureQueueBacklog();
    return { diskUsedPercent, expiringTokens, outboxFailed, downConnections, queueBacklog };
  }

  /** Soma waiting+delayed+failed das filas BullMQ (sinal de worker travado). */
  private async measureQueueBacklog(): Promise<number> {
    const u = new URL(this.cfg.redis.url);
    const connection = {
      host: u.hostname,
      port: Number(u.port) || 6379,
      ...(u.username ? { username: u.username } : {}),
      ...(u.password ? { password: u.password } : {}),
      maxRetriesPerRequest: null,
    };
    let total = 0;
    for (const name of QUEUE_NAMES) {
      const q = new Queue(name, { connection });
      try {
        const c = await q.getJobCounts("waiting", "delayed", "failed");
        total += (c.waiting ?? 0) + (c.delayed ?? 0) + (c.failed ?? 0);
      } catch {
        /* fila inexistente/redis indisponível → ignora */
      } finally {
        await q.close();
      }
    }
    return total;
  }

  /** Snapshot READ-ONLY (não notifica) p/ o painel de operação da plataforma (M14). */
  async snapshot(): Promise<{ signals: AlertSignals; alerts: AlertEvent[] }> {
    const signals = await this.gatherSignals();
    const alerts = evaluateAlerts(signals, {
      diskPercent: this.cfg.alerts.diskThresholdPercent,
      outboxFailed: this.cfg.alerts.outboxFailedThreshold,
      queueBacklog: this.cfg.alerts.queueBacklogThreshold,
    });
    return { signals, alerts };
  }

  /** Roda um ciclo de checagem e notifica os alertas. Retorna os disparados. */
  async runChecks(): Promise<AlertEvent[]> {
    const signals = await this.gatherSignals();
    const alerts = evaluateAlerts(signals, {
      diskPercent: this.cfg.alerts.diskThresholdPercent,
      outboxFailed: this.cfg.alerts.outboxFailedThreshold,
      queueBacklog: this.cfg.alerts.queueBacklogThreshold,
    });
    for (const a of alerts) await this.notifier.notify(a);
    return alerts;
  }

  onModuleInit(): void {
    if (!runsScheduler(this.cfg.app.role)) return;
    this.timer = setInterval(() => {
      void this.runChecks().catch((e) => this.logger.error(`checagem de alertas falhou: ${e.message}`));
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
