"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getLeadDetail, type AppointmentRow, type HistoryMessage, type LeadProfile } from "../../../../lib/api";
import { Button, Card, ErrorState, SkeletonBlock, StatusPill, statusLabelPt } from "../../../../components/ui";
import { ScoreTag, fmtDate } from "../../../../components/lead-bits";

type Detail = { profile: LeadProfile | null; appointments: AppointmentRow[]; history: HistoryMessage[] };

/** Nome de exibição do lead: nome qualificado → telefone → "Lead" (nunca uuid). */
function displayName(p: LeadProfile | null): string {
  const f = p?.fields ?? {};
  const name = f.nome ?? f.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  const phone = f.telefone ?? f.phone ?? f.whatsapp;
  if (typeof phone === "string" && phone.trim()) return phone.trim();
  return "Lead";
}

function DetailSkeleton() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 18 }} aria-busy="true">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Card>
          <SkeletonBlock height={20} width="50%" style={{ marginBottom: 12 }} />
          <SkeletonBlock height={14} width="35%" />
        </Card>
        <Card>
          <SkeletonBlock height={10} width={120} style={{ marginBottom: 14 }} />
          <SkeletonBlock height={14} style={{ marginBottom: 10 }} />
          <SkeletonBlock height={14} width="80%" />
        </Card>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Card>
          <SkeletonBlock height={10} width={100} style={{ marginBottom: 14 }} />
          <SkeletonBlock height={14} style={{ marginBottom: 10 }} />
          <SkeletonBlock height={14} width="70%" />
        </Card>
        <Card>
          <SkeletonBlock height={10} width={110} style={{ marginBottom: 14 }} />
          <SkeletonBlock height={14} style={{ marginBottom: 10 }} />
          <SkeletonBlock height={14} width="85%" style={{ marginBottom: 10 }} />
          <SkeletonBlock height={14} width="60%" />
        </Card>
      </div>
    </div>
  );
}

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    getLeadDetail(id).then(setData).catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div style={{ maxWidth: 560 }}>
        <div style={{ marginBottom: 16, fontSize: 12.5 }}><Link href="/leads" className="muted">← Leads</Link></div>
        <ErrorState message="Não conseguimos carregar este lead." detail={error} onRetry={load} />
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        <div style={{ marginBottom: 16, fontSize: 12.5 }}><Link href="/leads" className="muted">← Leads</Link></div>
        <DetailSkeleton />
      </div>
    );
  }
  const p = data.profile;
  const fields = Object.entries(p?.fields ?? {});

  return (
    <div>
      <div style={{ marginBottom: 16, fontSize: 12.5 }}>
        <Link href="/leads" className="muted">← Leads</Link>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 18 }}>
        {/* Coluna esquerda */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div>
                <h1 className="h2" style={{ marginBottom: 8 }}>{displayName(p)}</h1>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {p && <StatusPill status={p.status} />}
                  {p && <ScoreTag score={p.score} />}
                </div>
              </div>
              <Link href={`/conversas?c=${id}`}><Button size="sm" variant="secondary">Abrir conversa</Button></Link>
            </div>
            {p?.summary && <p className="muted" style={{ marginTop: 14, marginBottom: 0, fontSize: 13 }}>{p.summary}</p>}
          </Card>

          <Card>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Dados qualificados</div>
            {fields.length === 0 && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Ainda sem dados qualificados.</p>}
            <div style={{ display: "grid", gap: 10 }}>
              {fields.map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #f0f0f0", paddingBottom: 8 }}>
                  <span className="muted" style={{ fontSize: 13 }}>{k}</span>
                  <strong style={{ fontSize: 13 }}>{String(v)}</strong>
                </div>
              ))}
            </div>
          </Card>

          {data.appointments.length > 0 && (
            <Card style={{ borderColor: "rgba(82,204,90,0.5)", background: "var(--success-tint)" }}>
              <div className="eyebrow" style={{ color: "var(--success-text)", marginBottom: 10 }}>Agendamento</div>
              {data.appointments.map((a) => (
                <div key={a.id} style={{ fontSize: 13 }}>
                  <strong>{a.whenText ?? (a.startsAt ? fmtDate(a.startsAt) : "A combinar")}</strong> — {a.details}
                  <span className="caption" style={{ marginLeft: 8 }}>({statusLabelPt(a.status)})</span>
                </div>
              ))}
            </Card>
          )}
        </div>

        {/* Coluna direita */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Por que score {p?.score ?? 0}?</div>
            <p className="caption" style={{ marginTop: 0 }}>O score é determinístico: a IA extrai os campos, o código aplica os pesos do nicho.</p>
            {/* Checklist honesto: capturado ✓ / aguardando ○ (sem barras fake) */}
            <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
              {fields.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Sem contribuições ainda.</span>}
              {fields.map(([k]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <span style={{ color: "var(--success-text)", fontWeight: 800 }} aria-hidden>✓</span>
                  <span className="muted" style={{ flex: 1 }}>{k}</span>
                  <span style={{ fontWeight: 700, color: "var(--success-text)" }}>capturado</span>
                </div>
              ))}
              {fields.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <span style={{ color: "var(--text-subtle)", fontWeight: 800 }} aria-hidden>○</span>
                  <span className="muted" style={{ flex: 1 }}>demais campos do nicho</span>
                  <span style={{ fontWeight: 700, color: "var(--text-subtle)" }}>aguardando</span>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Linha do tempo</div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {data.history.slice(-12).map((m, i, arr) => (
                <div key={i} style={{ display: "flex", gap: 10 }}>
                  {/* Ponto + linha vertical conectando os eventos */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "none" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, marginTop: 5, flex: "none", background: m.direction === "inbound" ? "var(--text-subtle)" : "var(--red-600)" }} />
                    {i < arr.length - 1 && <span style={{ width: 2, flex: 1, minHeight: 14, background: "var(--border-200)", marginTop: 3, marginBottom: -2 }} />}
                  </div>
                  <div style={{ paddingBottom: i < arr.length - 1 ? 12 : 0 }}>
                    <div style={{ fontSize: 13 }}>{String(m.content.text ?? `[${m.type}]`)}</div>
                    <div className="caption">{m.direction === "inbound" ? "Lead" : "SDR"} · {fmtDate(m.createdAt)}</div>
                  </div>
                </div>
              ))}
              {data.history.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Sem mensagens.</span>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
