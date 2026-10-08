"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  getConnectionStatus,
  getConversations,
  getDashboard,
  getLeads,
  getMe,
  getOnboarding,
  type DashboardData,
  type LeadRow,
} from "../../../lib/api";
import { Button, Card, ErrorState, Kpi, SkeletonBlock, SkeletonKpi, StatusPill } from "../../../components/ui";
import { fmtDate, ScoreTag } from "../../../components/lead-bits";
import s from "./inicio.module.css";

/**
 * Funil DESENHADO (rampa V4): topo escuro → fundo em vermelho. A SILHUETA é
 * fixa (funil legível mesmo com contagens baixas ou zeradas — o número carrega
 * o dado, a forma comunica o fluxo). Desqualificados ficam FORA do funil, em
 * cinza #595959 (disciplina do vermelho).
 */
const FUNNEL_STAGES = [
  { key: "new", label: "Novos", color: "#1a1a1a", top: 100, bottom: 80 },
  { key: "qualified", label: "Qualificados", color: "#80050b", top: 80, bottom: 62 },
  { key: "scheduled", label: "Agendados", color: "#b5070f", top: 62, bottom: 46 },
  { key: "handoff", label: "Atendimento humano", color: "#e50914", top: 46, bottom: 34 },
];

/** Trapézio centrado da faixa (top/bottom em % da largura do card). */
const trapezoid = (top: number, bottom: number): string => {
  const t = (100 - top) / 2;
  const b = (100 - bottom) / 2;
  return `polygon(${t}% 0, ${100 - t}% 0, ${100 - b}% 100%, ${b}% 100%)`;
};

function firstNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const piece = local.split(/[._-]/)[0] ?? "";
  if (!piece) return "";
  return piece.charAt(0).toUpperCase() + piece.slice(1);
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const ini = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : name.slice(0, 2);
  return ini.toUpperCase() || "?";
}

export default function InicioPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [recent, setRecent] = useState<LeadRow[] | null>(null);
  const [liveConvs, setLiveConvs] = useState<number | null>(null);
  const [name, setName] = useState("");
  // null = ainda carregando; false = sem WhatsApp conectado (mostra onboarding).
  const [connected, setConnected] = useState<boolean | null>(null);
  // Onboarding JÁ ativado? O wizard sem ?revisar redireciona de volta p/ cá —
  // mandar um tenant ativado para /onboarding vira um vai-e-volta que parece
  // "botão quebrado". Ativado + desconectado = problema de CONEXÃO (reconectar).
  const [activated, setActivated] = useState<boolean | null>(null);
  // Passo salvo do wizard (retomada): >1 = onboarding pela metade.
  const [obStep, setObStep] = useState(1);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    getConnectionStatus().then((c) => setConnected(c.connected)).catch(() => setConnected(null));
    getOnboarding()
      .then((o) => {
        setActivated(Boolean(o.activatedAt));
        setObStep(o.step);
      })
      .catch(() => setActivated(null));
    getDashboard().then(setData).catch((e: Error) => setError(e.message));
    getLeads({ limit: 6 }).then((p) => setRecent(p.rows)).catch((e: Error) => { setRecent([]); setError(e.message); });
    getConversations({ limit: 1 }).then((p) => setLiveConvs(p.total)).catch(() => setLiveConvs(null));
  }, []);

  useEffect(() => {
    getMe().then((m) => setName(firstNameFromEmail(m.sub ?? ""))).catch(() => {});
    load();
  }, [load]);

  const f = data?.funnel ?? {};
  // Contagem REAL de leads no funil (pode ser 0) — o % das faixas guarda o ÷0
  // no próprio render (leadCount > 0).
  const leadCount = Object.values(f).reduce((a, b) => a + b, 0);
  // % das faixas e caption do card: só quem está NO funil (desqualificado é fora
  // — achado Codex: incluí-lo distorcia o percentual das faixas).
  const inFunnel = FUNNEL_STAGES.reduce((a, st) => a + (f[st.key] ?? 0), 0);
  const brl = (micros: number) => `R$ ${((micros / 1_000_000) * 5.5).toFixed(2)}`;
  const qualified = f.qualified ?? 0;
  const loading = data === null && !error;
  const today = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
        <div>
          <h1 className="h1-hero" style={{ marginBottom: 4 }}>{name ? `Olá, ${name} 👋` : "Olá 👋"}</h1>
          <p style={{ margin: 0, fontSize: 13, color: "#8a8a8a" }}>
            {today.charAt(0).toUpperCase() + today.slice(1)}
            {" · "}
            {connected === false
              ? "vamos colocar sua SDR para atender no WhatsApp."
              : data
                ? `${leadCount} lead${leadCount === 1 ? "" : "s"} recebido${leadCount === 1 ? "" : "s"} e ${qualified} qualificado${qualified === 1 ? "" : "s"} — resumo da semana.`
                : "sua SDR está atendendo no WhatsApp."}
          </p>
        </div>
        <Link href="/playground"><Button variant="secondary">Testar SDR</Button></Link>
      </div>

      {/* Só renderiza com `activated` RESOLVIDO (Codex): connected chega antes e
          um tenant ativado veria/clicaria "Iniciar onboarding" por um instante —
          exatamente o vai-e-volta que este banner corrige. */}
      {connected === false && activated !== null && (
        <Card style={{ marginBottom: 20, border: "1.5px solid var(--red-700)", background: "var(--surface-subtle)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ fontSize: 26 }} aria-hidden>📵</span>
            <div>
              <strong style={{ fontSize: 15, color: "var(--ink-900)" }}>
                {activated
                  ? "WhatsApp desconectado — sua SDR não está atendendo"
                  : obStep > 1
                    ? "Continue configurando sua SDR"
                    : "Você não possui nenhuma conta de WhatsApp conectada"}
              </strong>
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                {activated
                  ? "Sua SDR já está configurada — reconecte o número para voltar a atender."
                  : obStep > 1
                    ? `Você parou na etapa ${obStep} de 8 — é só continuar de onde parou.`
                    : "Conecte um número e configure sua SDR para começar a atender seus leads."}
              </p>
            </div>
          </div>
          {activated ? (
            // /conectar = página de ESCOLHA do canal (Oficial × QR, explicadas)
            // — nunca pular direto para um canal específico.
            <Link href="/conectar"><Button>Reconectar WhatsApp</Button></Link>
          ) : (
            <Link href="/onboarding"><Button>{obStep > 1 ? "Continuar onboarding" : "Iniciar onboarding agora"}</Button></Link>
          )}
        </Card>
      )}

      {error && (
        <div style={{ marginBottom: 20 }}>
          <ErrorState message="Não conseguimos buscar o resumo da sua SDR agora." detail={error} onRetry={load} />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 16, marginBottom: 20 }}>
        {loading ? (
          <>
            <SkeletonKpi /><SkeletonKpi /><SkeletonKpi /><SkeletonKpi />
          </>
        ) : (
          <>
            <Kpi label="Leads recebidos" value={leadCount} />
            <Kpi label="Qualificados" value={qualified} />
            <Kpi label="Agendamentos" value={f.scheduled ?? 0} />
            <Kpi label="Uso no mês" value={data ? brl(data.usage.costMicros) : "—"} />
          </>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 18 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
            <div className="eyebrow">Funil de qualificação</div>
            {!loading && <span className="caption">{inFunnel} no funil</span>}
          </div>
          {loading ? (
            <div className={s.funnel} aria-hidden>
              {FUNNEL_STAGES.map((st) => (
                <SkeletonBlock key={st.key} height={52} width={`${st.top}%`} style={{ margin: "0 auto", borderRadius: 6 }} />
              ))}
            </div>
          ) : (
            <>
              <div className={s.funnel}>
                {FUNNEL_STAGES.map((st) => {
                  const n = f[st.key] ?? 0;
                  const pct = inFunnel > 0 ? Math.round((n / inFunnel) * 100) : 0;
                  return (
                    <div
                      key={st.key}
                      className={s.funnelBand}
                      style={{ background: st.color, clipPath: trapezoid(st.top, st.bottom) }}
                      title={inFunnel > 0 ? `${st.label}: ${n} lead${n === 1 ? "" : "s"} (${pct}% do funil)` : st.label}
                    >
                      {/* teto = largura VISÍVEL do trapézio (base menor) — senão o
                          clip-path corta o texto antes de o ellipsis agir */}
                      <span className={s.funnelLabel} style={{ maxWidth: `${st.bottom - 4}%` }}>{st.label}</span>
                      <span className={s.funnelCount}>
                        {n}
                        {inFunnel > 0 && n > 0 && <em className={s.funnelPct}>{pct}%</em>}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className={s.funnelOut}>
                <span className={s.funnelOutDot} aria-hidden />
                Desqualificados (fora do funil)
                <strong style={{ marginLeft: "auto", color: "var(--ink-900)" }}>{f.disqualified ?? 0}</strong>
              </div>
            </>
          )}
          <div className={s.liveBanner}>
            <div style={{ fontSize: 11, color: "var(--neutral-dot)", fontWeight: 700, letterSpacing: "0.1em" }}>
              {connected === false ? "AGUARDANDO CONEXÃO" : "AO VIVO"}
            </div>
            {connected === false ? (
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>Conecte um WhatsApp para sua SDR começar a atender.</div>
            ) : (
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
                <span className={s.liveNum}>{liveConvs ?? "—"}</span>
                <span className={s.liveConv}>{liveConvs === 1 ? "conversa" : "conversas"}</span>
                <span style={{ fontSize: 12.5, color: "var(--neutral-dot)" }}>sua SDR está atendendo agora.</span>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Atividade recente</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {recent === null && (
              <>
                <SkeletonBlock height={40} style={{ borderRadius: 8 }} />
                <SkeletonBlock height={40} style={{ borderRadius: 8 }} />
                <SkeletonBlock height={40} style={{ borderRadius: 8 }} />
              </>
            )}
            {recent?.map((r) => (
              <Link key={r.conversationId} href={`/leads/${r.conversationId}`} className={s.activityRow}>
                <span className={s.activityAvatar}>{initialsOf(r.name ?? r.waId)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink-900)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name ?? r.waId}</div>
                  <div className="caption">{fmtDate(r.lastContactAt)}</div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flex: "none" }}>
                  <StatusPill status={r.status} />
                  <ScoreTag score={r.score} />
                </div>
              </Link>
            ))}
            {recent?.length === 0 && !error && <span className="muted" style={{ fontSize: 13 }}>Sem leads ainda.</span>}
          </div>
        </Card>
      </div>
    </div>
  );
}
