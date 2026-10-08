"use client";

import { useState } from "react";
import { resetPlayground, simulatePlayground, type PlaygroundResult } from "../../../lib/api";
import { Badge, Button, Card, Select } from "../../../components/ui";

type Msg = { role: "user" | "bot"; text: string };
const NICHES = [
  { v: "", l: "Nicho do tenant" },
  { v: "solar", l: "Energia solar" },
  { v: "clinica", l: "Clínica" },
  { v: "imobiliaria", l: "Imobiliária" },
  { v: "educacao", l: "Educação" },
];

export default function PlaygroundPage() {
  const [niche, setNiche] = useState("");
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [debug, setDebug] = useState<PlaygroundResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const res = await simulatePlayground(text, niche || undefined);
      setMsgs((m) => [...m, { role: "bot", text: res.reply }]);
      setDebug(res);
    } catch (e) {
      setMsgs((m) => [...m, { role: "bot", text: `⚠️ Erro: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    await resetPlayground(niche || undefined).catch(() => {});
    setMsgs([]);
    setDebug(null);
  }

  const brl = (micros: number) => `R$ ${((micros / 1_000_000) * 5.5).toFixed(4)}`;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 className="h1-page">Playground</h1>
          <Badge tone="warning">Modo teste · não envia ao lead</Badge>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Select value={niche} onChange={(e) => setNiche(e.target.value)} style={{ width: "auto" }} aria-label="Nicho de teste">
            {NICHES.map((n) => <option key={n.v} value={n.v}>{n.l}</option>)}
          </Select>
          <Button variant="ghost" size="sm" onClick={reset}>Reiniciar</Button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 16, height: "calc(100vh - var(--topbar-h) - 110px)" }}>
        {/* Chat */}
        <Card pad={false} style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 10, background: "#ece5dd" }}>
            {msgs.length === 0 && <div style={{ margin: "auto", color: "#667781", fontSize: 13 }}>Escreva uma mensagem como se fosse um lead.</div>}
            {msgs.map((m, i) => (
              <div key={i} style={{ maxWidth: "76%", padding: "8px 11px", fontSize: 13.5, lineHeight: 1.4, borderRadius: m.role === "user" ? "10px 10px 10px 2px" : "10px 10px 2px 10px", background: m.role === "user" ? "#fff" : "#dcf8c6", alignSelf: m.role === "user" ? "flex-start" : "flex-end", boxShadow: "0 1px 0.5px rgba(0,0,0,.13)" }}>
                {m.text}
              </div>
            ))}
            {busy && <div style={{ alignSelf: "flex-end", color: "#667781", fontSize: 12 }}>SDR digitando…</div>}
          </div>
          <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border-200)", background: "var(--surface)" }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Mensagem de teste…" style={{ flex: 1, padding: "10px 12px", border: "1px solid var(--border-300)", borderRadius: 8, fontFamily: "inherit", fontSize: 14 }} />
            <Button disabled={busy} onClick={send}>Enviar</Button>
          </div>
        </Card>

        {/* Painel de debug */}
        <Card style={{ overflowY: "auto" }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>Debug da simulação</div>
          {!debug && <p className="muted" style={{ fontSize: 13 }}>Envie uma mensagem para ver o que a IA recuperou, qualificou e quanto custou.</p>}
          {debug && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Section title="Conhecimento recuperado (RAG)">
                {debug.retrieved.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>Nada recuperado.</span>}
                {debug.retrieved.map((r, i) => (
                  <div key={i} style={{ borderLeft: "2px solid var(--red-600)", paddingLeft: 9, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{r.title} <span className="caption">· match {(r.score * 100).toFixed(0)}%</span></div>
                    <div className="caption" style={{ fontStyle: "italic" }}>{r.snippet}…</div>
                  </div>
                ))}
              </Section>
              <Section title="Campos qualificados">
                {Object.keys(debug.fields).length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>Aguardando…</span>}
                {Object.entries(debug.fields).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                    <span className="muted">✓ {k}</span><strong>{String(v)}</strong>
                  </div>
                ))}
              </Section>
              <Section title="Custo da simulação">
                <Row k="Score" v={String(debug.score)} />
                <Row k="Rota" v={debug.route} />
                <Row k="Iterações IA" v={String(debug.iterations)} />
                <Row k="Custo" v={brl(debug.costMicros)} />
              </Section>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 800, color: "var(--ink-900)", marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}><span className="muted">{k}</span><strong>{v}</strong></div>;
}
