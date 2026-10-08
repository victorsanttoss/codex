"use client";
import { useCallback, useEffect, useState } from "react";
import { getPlatformOverview, getPlatformTenants, type PlatformOverview, type PlatformTenant } from "../../../../lib/api";
import { Card, Kpi, SkeletonKpi, SkeletonRows, Td, statusLabelPt } from "../../../../components/ui";
import { PlatformError, PlatformTitle } from "../../../../components/platform-bits";

export default function VisaoGlobalPage() {
  const [ov, setOv] = useState<PlatformOverview | null>(null);
  const [tenants, setTenants] = useState<PlatformTenant[] | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    getPlatformOverview().then(setOv).catch((e: Error) => setErr(e.message));
    getPlatformTenants().then(setTenants).catch(() => setTenants([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <PlatformError message={err} onRetry={load} />;
  const loading = ov === null;
  return (
    <div>
      <PlatformTitle>Visão global</PlatformTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 14, marginBottom: 22 }}>
        {loading ? (
          <>
            <SkeletonKpi /><SkeletonKpi /><SkeletonKpi /><SkeletonKpi />
          </>
        ) : (
          <>
            <Kpi label="Tenants" value={String(ov.tenants)} />
            <Kpi label="Tenants ativos" value={String(ov.activeTenants)} />
            <Kpi label="Nichos" value={String(ov.niches)} />
            <Kpi label="Inativos" value={String(ov.tenants - ov.activeTenants)} />
          </>
        )}
      </div>
      <Card pad={false}>
        <div style={{ padding: 14 }} className="eyebrow">Tenants recentes</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {tenants === null && <SkeletonRows cols={3} rows={4} />}
            {tenants?.slice(0, 12).map((t) => (
              <tr key={t.id}>
                <Td style={{ fontWeight: 700 }}>{t.name}</Td>
                <Td className="muted">{t.slug}</Td>
                <Td style={{ textAlign: "right" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, display: "inline-block", marginRight: 6, background: t.status === "active" ? "var(--success)" : "var(--text-subtle)" }} />
                  {statusLabelPt(t.status)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
