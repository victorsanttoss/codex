"use client";
import { useCallback, useEffect, useState } from "react";
import { getPlatformNiches, type PlatformNiche } from "../../../../lib/api";
import { Badge, Card, statusLabelPt } from "../../../../components/ui";
import { PlatformError, PlatformTitle } from "../../../../components/platform-bits";

export default function NichosPage() {
  const [niches, setNiches] = useState<PlatformNiche[]>([]);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    getPlatformNiches().then(setNiches).catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <PlatformError message={err} onRetry={load} />;
  return (
    <div>
      <PlatformTitle>Nichos</PlatformTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14 }}>
        {niches.map((n) => (
          <Card key={n.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <strong style={{ fontSize: 15 }}>{n.name}</strong>
              <Badge tone="brand">{n.motion}</Badge>
            </div>
            <div className="caption" style={{ marginTop: 4 }}>vertical: {n.vertical} · {statusLabelPt(n.status)}</div>
            {n.guidance && <p className="muted" style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>{n.guidance.slice(0, 140)}…</p>}
          </Card>
        ))}
        {niches.length === 0 && <p className="muted">Nenhum nicho cadastrado.</p>}
      </div>
    </div>
  );
}
