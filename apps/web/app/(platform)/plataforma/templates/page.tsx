"use client";
import { useCallback, useEffect, useState } from "react";
import { getPlatformTemplates, type PlatformTemplatesView } from "../../../../lib/api";
import { Card, Kpi, SkeletonKpi, SkeletonRows, Td, Th, statusLabelPt } from "../../../../components/ui";
import { PlatformError, PlatformTitle } from "../../../../components/platform-bits";

function statusBadge(s: string) {
  const map: Record<string, [string, string]> = { approved: ["var(--success-tint)", "var(--success-text)"], rejected: ["var(--error-bg)", "var(--error-text)"] };
  const [bg, fg] = map[s] ?? ["var(--warning-tint)", "var(--warning-text)"];
  return <span style={{ fontSize: 11, fontWeight: 800, padding: "3px 9px", borderRadius: 999, background: bg, color: fg }}>{statusLabelPt(s)}</span>;
}

export default function TemplatesPage() {
  const [data, setData] = useState<PlatformTemplatesView | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    getPlatformTemplates().then(setData).catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <PlatformError message={err} onRetry={load} />;
  return (
    <div>
      <PlatformTitle>Templates HSM</PlatformTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 18 }}>
        {!data ? (
          <>
            <SkeletonKpi /><SkeletonKpi /><SkeletonKpi />
          </>
        ) : (
          <>
            <Kpi label="Aprovados" value={String(data.counts.approved)} />
            <Kpi label="Em aprovação" value={String(data.counts.pending)} />
            <Kpi label="Rejeitados" value={String(data.counts.rejected)} />
          </>
        )}
      </div>
      <Card pad={false}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr><Th>Template</Th><Th>Categoria</Th><Th>Idioma</Th><Th style={{ textAlign: "right" }}>Status Meta</Th></tr></thead>
          <tbody>
            {!data && <SkeletonRows cols={4} rows={4} />}
            {data?.templates.map((t, i) => (
              <tr key={i}>
                <Td><strong>{t.name}</strong></Td>
                <Td className="muted">{t.category}</Td>
                <Td className="muted">{t.languageCode}</Td>
                <Td style={{ textAlign: "right" }}>{statusBadge(t.status)}</Td>
              </tr>
            ))}
            {data?.templates.length === 0 && <tr><Td className="muted">Nenhum template cadastrado nos tenants.</Td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
