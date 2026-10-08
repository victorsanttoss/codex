"use client";

import { useCallback, useEffect, useState } from "react";
import { getCompliance, getDashboard, getMembers, type ComplianceSummary, type DashboardData, type MemberRow } from "../../../lib/api";
import { Badge, Button, Card, ErrorState, Kpi, SkeletonBlock, SkeletonKpi, SkeletonRows, Td, statusLabelPt } from "../../../components/ui";

type Tab = "custos" | "compliance" | "equipe";

export default function ContaPage() {
  const [tab, setTab] = useState<Tab>("custos");
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [compliance, setCompliance] = useState<ComplianceSummary | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    getDashboard().then(setDash).catch((e: Error) => setError(e.message));
    getMembers().then(setMembers).catch(() => setMembers([]));
    getCompliance().then(setCompliance).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const brl = (micros: number) => `R$ ${((micros / 1_000_000) * 5.5).toFixed(2)}`;
  const cost = dash ? dash.usage.costMicros : 0;
  const planLimit = 600;
  const used = Number(((cost / 1_000_000) * 5.5).toFixed(2));

  return (
    <div>
      <h1 className="h1-page" style={{ marginBottom: 16 }}>Conta &amp; uso</h1>
      <div style={{ display: "inline-flex", background: "#f0f0f0", borderRadius: 8, padding: 3, gap: 3, marginBottom: 20 }}>
        {([["custos", "Custos & uso"], ["compliance", "Compliance"], ["equipe", "Equipe"]] as const).map(([id, l]) => (
          <button key={id} onClick={() => setTab(id)} style={{ padding: "7px 14px", borderRadius: 6, border: "none", fontWeight: 700, fontSize: 12.5, cursor: "pointer", background: tab === id ? "#fff" : "transparent", color: tab === id ? "var(--ink-900)" : "var(--text-muted)", boxShadow: tab === id ? "var(--shadow-float)" : "none", transition: "background 0.15s ease, color 0.15s ease" }}>{l}</button>
        ))}
      </div>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <ErrorState message="Não conseguimos buscar os dados de uso da sua conta." detail={error} onRetry={load} />
        </div>
      )}

      {tab === "custos" && (
        <div>
          <Card style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <strong style={{ fontSize: 14 }}>Uso do plano</strong>
              <span className="muted" style={{ fontSize: 13 }}>{dash ? `R$ ${used.toFixed(2)} / R$ ${planLimit}` : "—"}</span>
            </div>
            {dash === null && !error ? (
              <SkeletonBlock height={10} style={{ borderRadius: 999 }} />
            ) : (
              <div style={{ height: 10, borderRadius: 999, background: "var(--border-200)" }}>
                <div style={{ height: "100%", width: `${Math.min(100, (used / planLimit) * 100)}%`, borderRadius: 999, background: "var(--red-600)" }} />
              </div>
            )}
          </Card>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 14 }}>
            {dash === null && !error ? (
              <>
                <SkeletonKpi /><SkeletonKpi /><SkeletonKpi /><SkeletonKpi />
              </>
            ) : (
              <>
                <Kpi label="Conversas de IA" value={dash ? brl(cost) : "—"} />
                <Kpi label="Eventos" value={dash ? String(dash.usage.events) : "—"} />
                <Kpi label="Tokens entrada" value={dash ? dash.usage.tokensIn.toLocaleString("pt-BR") : "—"} />
                <Kpi label="Tokens saída" value={dash ? dash.usage.tokensOut.toLocaleString("pt-BR") : "—"} />
              </>
            )}
          </div>
        </div>
      )}

      {tab === "compliance" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14 }}>
          {compliance === null ? (
            <>
              <SkeletonKpi /><SkeletonKpi />
            </>
          ) : (
            <>
              <Kpi label="Opt-outs (LGPD)" value={String(compliance.optedOut)} />
              <Kpi label="Contatos" value={String(compliance.contacts)} />
            </>
          )}
          <Card>
            <div className="eyebrow" style={{ marginBottom: 8 }}>LGPD</div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Contatos que pediram saída nunca são cadenciados. Os opt-outs são respeitados automaticamente.</p>
          </Card>
        </div>
      )}

      {tab === "equipe" && (
        <Card pad={false}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
            <strong style={{ fontSize: 14 }}>Membros</strong>
            {/* Convite de membros ainda não tem backend — desabilitado honesto
                (auditoria: clique morto parecia bug). */}
            <Button size="sm" variant="secondary" disabled title="Em breve — por enquanto, peça ao suporte para adicionar membros.">Convidar · em breve</Button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {members === null && <SkeletonRows cols={2} rows={3} />}
              {members?.map((m) => (
                <tr key={m.userId}>
                  <Td style={{ fontWeight: 600 }}>{m.email}</Td>
                  <Td style={{ textAlign: "right" }}>
                    <Badge tone={m.role === "owner" || m.role === "admin" ? "brand" : "neutral"}>{statusLabelPt(m.role)}</Badge>
                  </Td>
                </tr>
              ))}
              {members?.length === 0 && <tr><td style={{ padding: 16 }} className="muted">Sem membros.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
