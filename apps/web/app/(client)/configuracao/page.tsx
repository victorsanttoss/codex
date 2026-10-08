"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { getAgentSettings, getConnectionStatus, getVerticalInfo, saveAgentSettings, type AgentSettings } from "../../../lib/api";
import { Badge, Button, Card, ErrorState, SkeletonBlock, Td, Textarea } from "../../../components/ui";
import { KnowledgeManager } from "../../../components/knowledge-manager";
import { CalendarPoolManager } from "../../../components/calendar-pool-manager";
import { BrokersManager } from "../../../components/brokers-manager";
import { useToast } from "../../../components/toast";
import { IconBell, IconChat, IconCheckShield, IconGlobe, IconLayers, IconUser } from "../../../components/icons";

const HUB: Array<{ id: string; title: string; desc: string; href?: string; icon: ReactNode; badge?: string }> = [
  // Modo REVISÃO do wizard (?revisar=1): o cliente vê e altera tudo que
  // preencheu no onboarding — cada card leva direto à etapa correspondente.
  { id: "onboarding", title: "Dados do onboarding", desc: "Revise e altere tudo que você preencheu.", href: "/onboarding?revisar=1", icon: <IconLayers /> },
  { id: "whatsapp", title: "Conexão WhatsApp", desc: "Status, número e reconexão.", href: "/conectar", icon: <IconChat /> },
  { id: "knowledge", title: "Base de conhecimento", desc: "FAQs e materiais que a SDR usa.", href: "#conhecimento", icon: <IconLayers /> },
  { id: "persona", title: "Persona & guardrails", desc: "Tom de voz e o que pode/não pode.", href: "#persona", icon: <IconUser /> },
  { id: "qualify", title: "Qualificação", desc: "Campos, pesos e pontuação mínima.", href: "/onboarding?revisar=1&etapa=4", icon: <IconCheckShield /> },
  // Vertical imobiliária: quem recebe os leads (a distribuição depende disto).
  { id: "corretores", title: "Corretores parceiros", desc: "Números de WhatsApp que recebem os leads.", href: "#corretores", icon: <IconUser /> },
  { id: "cadence", title: "Cadência & templates", desc: "Follow-up e aprovação Meta.", href: "/onboarding?revisar=1&etapa=7", icon: <IconBell /> },
  // Sem href: ainda não há tela de integrações — apontava p/ a própria página
  // (auditoria: link circular parecia bug). Card informativo até existir.
  { id: "crm", title: "Integrações", desc: "CRM e agenda.", icon: <IconGlobe />, badge: "em breve" },
];

export default function ConfiguracaoPage() {
  const toast = useToast();
  const [cfg, setCfg] = useState<AgentSettings | null>(null);
  const [cfgError, setCfgError] = useState("");
  const [persona, setPersona] = useState("");
  const [handoff, setHandoff] = useState("");
  const [saving, setSaving] = useState(false);
  // null = verificando; depois reflete o status REAL da conexão do WhatsApp.
  const [connected, setConnected] = useState<boolean | null>(null);
  // vertical do tenant: a seção de corretores só aparece no imobiliário
  const [vertical, setVertical] = useState<string | null>(null);

  function loadCfg() {
    setCfgError("");
    getAgentSettings()
      .then((c) => { setCfg(c); setPersona(c.persona); setHandoff(c.handoffMessage); })
      .catch((e: Error) => setCfgError(e.message));
  }

  useEffect(() => {
    loadCfg();
    getConnectionStatus().then((c) => setConnected(c.connected)).catch(() => setConnected(null));
    getVerticalInfo().then((v) => setVertical(v.vertical)).catch(() => setVertical(null));
  }, []);

  const isImob = vertical === "imobiliario";
  const hub = isImob ? HUB : HUB.filter((h) => h.id !== "corretores");

  async function save() {
    setSaving(true);
    try {
      await saveAgentSettings({ persona, handoffMessage: handoff });
      toast("✓ Salvo");
    } catch {
      toast("Não foi possível salvar — tente de novo");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1 className="h1-page" style={{ marginBottom: 6 }}>Configuração</h1>
      <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>Ajuste como a sua SDR atende, qualifica e dá follow-up.</p>

      {/* Banner de conexão ligado ao status real */}
      {connected !== false && (
        <Card style={{ marginBottom: 20, background: "var(--success-tint)", borderColor: "rgba(82,204,90,0.5)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: connected === null ? "var(--neutral-dot)" : "var(--success)" }} />
          <strong style={{ fontSize: 13, color: connected === null ? "var(--text-muted)" : "var(--success-text)" }}>
            {connected === null ? "Verificando conexão do WhatsApp…" : "WhatsApp conectado"}
          </strong>
          <Link href="/conectar" style={{ marginLeft: "auto", fontSize: 12.5, fontWeight: 700, color: "var(--red-700)" }}>Gerenciar conexão →</Link>
        </Card>
      )}
      {connected === false && (
        <Card style={{ marginBottom: 20, background: "var(--error-bg)", borderColor: "var(--error-border)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--red-600)" }} />
          <strong style={{ fontSize: 13, color: "var(--error-text)" }}>WhatsApp desconectado — sua SDR não está atendendo</strong>
          <Link href="/conectar" style={{ marginLeft: "auto" }}><Button size="sm">Reconectar</Button></Link>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 14, marginBottom: 28 }}>
        {hub.map((h) => {
          const card = (
            <Card hover={Boolean(h.href)} style={{ height: "100%", ...(h.href ? {} : { opacity: 0.75 }) }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <span style={{ width: 34, height: 34, borderRadius: 9, background: "#f5f5f6", color: "var(--ink-900)", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }} aria-hidden>
                  {h.icon}
                </span>
                {h.badge && <Badge tone="warning">{h.badge}</Badge>}
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 12 }}>
                <strong style={{ fontSize: 14, color: "var(--ink-900)" }}>{h.title}</strong>
                {h.href && <span style={{ color: "var(--text-subtle)", fontWeight: 700 }} aria-hidden>→</span>}
              </div>
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{h.desc}</p>
            </Card>
          );
          return h.href ? <Link key={h.id} href={h.href}>{card}</Link> : <div key={h.id}>{card}</div>;
        })}
      </div>

      {/* Subtela: Persona & guardrails (editável, escrita real) */}
      <h2 className="h2" id="persona" style={{ marginBottom: 12 }}>Persona &amp; guardrails</h2>
      <Card>
        {!cfg && !cfgError && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <SkeletonBlock height={12} width={160} />
            <SkeletonBlock height={80} style={{ borderRadius: 8 }} />
            <SkeletonBlock height={12} width={220} />
            <SkeletonBlock height={80} style={{ borderRadius: 8 }} />
          </div>
        )}
        {cfgError && <ErrorState message="Não conseguimos buscar as configurações da sua SDR." detail={cfgError} onRetry={loadCfg} />}
        {cfg && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <label className="field">
              <span className="eyebrow">Persona / tom de voz</span>
              <Textarea value={persona} onChange={(e) => setPersona(e.target.value)} style={{ marginTop: 6 }} />
            </label>
            <label className="field">
              <span className="eyebrow">Mensagem ao passar para humano</span>
              <Textarea value={handoff} onChange={(e) => setHandoff(e.target.value)} style={{ marginTop: 6 }} />
            </label>
            <div style={{ display: "flex", gap: 14, fontSize: 12.5 }} className="muted">
              <span>Teto de iterações: <strong>{cfg.guardrails.maxToolIterations}</strong></span>
              <span>Teto de custo/turno: <strong>R$ {((cfg.guardrails.maxCostMicrosPerTurn / 1_000_000) * 5.5).toFixed(3)}</strong></span>
              <span>RAG topK: <strong>{cfg.knowledge.topK}</strong></span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Button disabled={saving} onClick={save}>{saving ? "Salvando…" : "Salvar"}</Button>
            </div>
          </div>
        )}
      </Card>

      {cfg && cfg.qualification.enabled === false && (
        <>
          <h2 className="h2" style={{ margin: "26px 0 12px" }}>Qualificação</h2>
          <Card style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Badge tone="neutral">desligada</Badge>
            <span className="muted" style={{ fontSize: 13 }}>A SDR atende e responde normalmente, sem pontuar leads.</span>
            <Link href="/onboarding?revisar=1&etapa=4" style={{ marginLeft: "auto", fontSize: 12.5, fontWeight: 700, color: "var(--red-700)" }}>Ligar qualificação →</Link>
          </Card>
        </>
      )}
      {cfg && cfg.qualification.enabled !== false && (
        <>
          <h2 className="h2" style={{ margin: "26px 0 12px" }}>Qualificação</h2>
          <Card pad={false}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {cfg.qualification.fields.map((f) => (
                  <tr key={f.key}>
                    <Td style={{ fontWeight: 600 }}>{f.key}</Td>
                    <Td style={{ textAlign: "right" }}>
                      {f.eliminatory ? <Badge tone="danger">eliminatório</Badge> : f.required ? <Badge tone="warning">obrigatório</Badge> : <Badge tone="neutral">peso {f.weight ?? 1}</Badge>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
            Para editar campos e pesos, use <Link href="/onboarding?revisar=1&etapa=4" style={{ fontWeight: 700, color: "var(--red-700)" }}>Dados do onboarding → Qualificação</Link>.
          </p>
        </>
      )}

      {/* Base de conhecimento: mesmos arquivos do wizard (etapa 8) — o cliente
          vê, sobe e apaga materiais também DEPOIS do onboarding. */}
      <h2 className="h2" id="conhecimento" style={{ margin: "26px 0 12px" }}>Base de conhecimento</h2>
      <Card>
        <KnowledgeManager />
      </Card>

      {/* Agendas do pool: conectar/remover as agendas Google (uma por recurso)
          também DEPOIS do onboarding — mesmo gerenciador da etapa 5. */}
      <h2 className="h2" id="agenda" style={{ margin: "26px 0 12px" }}>Agendas de atendimento</h2>
      <CalendarPoolManager />

      {/* Corretores parceiros (vertical imobiliária): os números de WhatsApp
          que RECEBEM os leads qualificados — mesmo gerenciador da etapa 6 do
          wizard. O acompanhamento do atendimento fica no painel da parceria. */}
      {isImob && (
        <>
          <h2 className="h2" id="corretores" style={{ margin: "26px 0 12px" }}>Corretores parceiros</h2>
          <BrokersManager />
        </>
      )}
    </div>
  );
}
