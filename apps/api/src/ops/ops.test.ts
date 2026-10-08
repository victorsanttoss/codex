import { describe, expect, it } from "vitest";
import { evaluateAlerts } from "./alerts.service";

const thresholds = { diskPercent: 85, outboxFailed: 20, queueBacklog: 1000 };
const ok = { diskUsedPercent: 50, expiringTokens: 0, outboxFailed: 0, downConnections: 0, queueBacklog: 0 };

describe("evaluateAlerts (condições de alerta)", () => {
  it("nada acima do limiar → sem alertas", () => {
    expect(evaluateAlerts(ok, thresholds)).toEqual([]);
  });
  it("disco cheio → crítico", () => {
    const a = evaluateAlerts({ ...ok, diskUsedPercent: 90 }, thresholds);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "disk", severity: "critical" });
  });
  it("outbox falho acima do limiar → crítico", () => {
    const a = evaluateAlerts({ ...ok, outboxFailed: 25 }, thresholds);
    expect(a[0]).toMatchObject({ kind: "outbox_failed", severity: "critical" });
  });
  it("fila acumulada acima do limiar → crítico (worker travado)", () => {
    const a = evaluateAlerts({ ...ok, queueBacklog: 1500 }, thresholds);
    expect(a[0]).toMatchObject({ kind: "queue_backlog", severity: "critical" });
  });
  it("conexão caída + token expirando → warnings", () => {
    const a = evaluateAlerts({ ...ok, expiringTokens: 2, downConnections: 1 }, thresholds);
    expect(a.map((x) => x.kind).sort()).toEqual(["connection_down", "token_expiring"]);
    expect(a.every((x) => x.severity === "warning")).toBe(true);
  });
});
