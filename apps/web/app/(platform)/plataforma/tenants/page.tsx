"use client";
import { useCallback, useEffect, useState } from "react";
import { getPlatformTenants, type PlatformTenant } from "../../../../lib/api";
import { Button, Card, statusLabelPt } from "../../../../components/ui";
import { PlatformError, PlatformTitle } from "../../../../components/platform-bits";

export default function TenantsPage() {
  const [tenants, setTenants] = useState<PlatformTenant[]>([]);
  const [sel, setSel] = useState<PlatformTenant | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    getPlatformTenants().then((t) => { setTenants(t); setSel(t[0] ?? null); }).catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <PlatformError message={err} onRetry={load} />;
  return (
    <div>
      <PlatformTitle>Tenants ({tenants.length})</PlatformTitle>
      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16 }}>
        <Card pad={false} style={{ maxHeight: "70vh", overflowY: "auto" }}>
          {tenants.map((t) => (
            <div key={t.id} onClick={() => setSel(t)} style={{ padding: "12px 16px", borderTop: "1px solid #f0f0f0", cursor: "pointer", background: sel?.id === t.id ? "var(--surface-subtle)" : "transparent", boxShadow: sel?.id === t.id ? "inset 3px 0 0 var(--red-600)" : "none" }}>
              <div style={{ fontWeight: 700 }}>{t.name}</div>
              <div className="caption">{t.slug} · {statusLabelPt(t.status)}</div>
            </div>
          ))}
        </Card>
        {sel && (
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div><h2 className="h2">{sel.name}</h2><div className="caption">{sel.slug}</div></div>
              <div style={{ display: "flex", gap: 8 }}>
                {/* Sem endpoints ainda (dívida conhecida: support/impersonar) —
                    desabilitados honestos até o backend existir. */}
                <Button size="sm" variant="secondary" disabled title="Em breve">Notificar cliente · em breve</Button>
                <Button size="sm" disabled title="Em breve — exigirá registro em auditoria">Impersonar · em breve</Button>
              </div>
            </div>
            <p className="muted" style={{ marginTop: 16, fontSize: 13 }}>Status: <strong>{statusLabelPt(sel.status)}</strong> · criado em {new Date(sel.createdAt).toLocaleDateString("pt-BR")}.</p>
            <p className="caption">Impersonar entra na conta do tenant para suporte (registrado em auditoria).</p>
          </Card>
        )}
      </div>
    </div>
  );
}
