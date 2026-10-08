"use client";
import { useCallback, useEffect, useState } from "react";
import { getPlatformOperation, type OperationSnapshot } from "../../../../lib/api";
import { Card, Kpi, SkeletonKpi } from "../../../../components/ui";
import { PlatformError, PlatformTitle } from "../../../../components/platform-bits";

export default function OperacaoPage() {
  const [op, setOp] = useState<OperationSnapshot | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    getPlatformOperation().then(setOp).catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <PlatformError message={err} onRetry={load} />;
  const s = op?.signals;
  return (
    <div>
      <PlatformTitle>Operação &amp; alertas</PlatformTitle>
      {op && op.alerts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
          {op.alerts.map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: a.severity === "critical" ? "var(--error-bg)" : "var(--warning-tint)", color: a.severity === "critical" ? "var(--error-text)" : "var(--warning-text)" }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, flex: "none", background: a.severity === "critical" ? "var(--red-600)" : "var(--warning)" }} aria-hidden />
              {a.message}
            </div>
          ))}
        </div>
      )}
      {op && op.alerts.length === 0 && <Card style={{ marginBottom: 18, background: "var(--success-tint)", borderColor: "rgba(82,204,90,0.5)" }}><strong style={{ color: "var(--success-text)" }}>✓ Tudo operacional — sem alertas.</strong></Card>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 14 }}>
        {!op ? (
          <>
            <SkeletonKpi /><SkeletonKpi /><SkeletonKpi /><SkeletonKpi /><SkeletonKpi />
          </>
        ) : (
          <>
            <Kpi label="Fila acumulada" value={String(s!.queueBacklog)} dense />
            <Kpi label="Outbox falho" value={String(s!.outboxFailed)} dense />
            <Kpi label="Conexões caídas" value={String(s!.downConnections)} dense />
            <Kpi label="Tokens expirando" value={String(s!.expiringTokens)} dense />
            <Kpi label="Disco" value={`${s!.diskUsedPercent}%`} dense />
          </>
        )}
      </div>
    </div>
  );
}
