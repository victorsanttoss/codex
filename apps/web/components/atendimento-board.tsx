"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { ImobAssignmentJoined } from "../lib/api";
import {
  colunaDe,
  duracaoAceite,
  KANBAN_COLUNAS,
  nomeLead,
  normalizarBusca,
  ROTULO_ETAPA,
  ROTULO_STATUS_ATENDIMENTO,
  tempoRelativo,
  ultimaPorLead,
} from "../lib/imob-atendimento";
import { Input, Select, tableClass } from "./ui";

const COR_STATUS: Record<string, { bg: string; fg: string }> = {
  offered: { bg: "#fef3c7", fg: "#92400e" },
  accepted: { bg: "#d1fae5", fg: "#065f46" },
  declined: { bg: "#ffe4e6", fg: "#9f1239" },
  expired: { bg: "#ffe4e6", fg: "#9f1239" },
  closed: { bg: "#e5e7eb", fg: "#374151" },
};

function rotuloLinha(a: ImobAssignmentJoined): string {
  if (a.status === "accepted" && a.stage) return ROTULO_ETAPA[a.stage] ?? a.stage;
  if (a.status === "closed" && a.stage) return ROTULO_ETAPA[a.stage] ?? "Encerrado";
  return ROTULO_STATUS_ATENDIMENTO[a.status] ?? a.status;
}

/**
 * Board do atendimento (kanban + lista + filtros) — migrado da Central Menin
 * para DENTRO do painel: aqui a visão é do empreendimento logado e cada card
 * abre a conversa real em /conversas (a Central só via de fora, por API).
 */
export function AtendimentoBoard({
  atendimentos,
  agoraMs,
}: {
  atendimentos: ImobAssignmentJoined[];
  /** timestamp de quando os dados chegaram — estável entre renders */
  agoraMs: number;
}) {
  const [visao, setVisao] = useState<"kanban" | "lista">("kanban");
  const [fCorretor, setFCorretor] = useState("");
  const [fEtapa, setFEtapa] = useState("");
  const [busca, setBusca] = useState("");

  const corretores = useMemo(
    () => [...new Set(atendimentos.map((a) => a.brokerName))].sort((a, b) => a.localeCompare(b)),
    [atendimentos],
  );

  const passaFiltros = useCallback(
    (a: ImobAssignmentJoined): boolean => {
      if (fCorretor && a.brokerName !== fCorretor) return false;
      if (fEtapa && colunaDe(a) !== fEtapa) return false;
      const q = normalizarBusca(busca.trim());
      if (q) {
        const alvo = normalizarBusca(`${nomeLead(a)} ${a.contactPhone ?? ""} ${a.brokerName}`);
        if (!alvo.includes(q)) return false;
      }
      return true;
    },
    [fCorretor, fEtapa, busca],
  );

  // Lista = HISTÓRICO filtrado (linha por atribuição, redistribuições visíveis).
  const filtrados = useMemo(() => atendimentos.filter(passaFiltros), [atendimentos, passaFiltros]);

  // Kanban = estado ATUAL de cada lead: dedup PRIMEIRO, filtro DEPOIS — filtrar
  // antes "ressuscitaria" atribuição antiga de lead redistribuído (achado Codex).
  const cards = useMemo(() => ultimaPorLead(atendimentos).filter(passaFiltros), [atendimentos, passaFiltros]);
  const porColuna = useMemo(() => {
    const m = new Map<string, ImobAssignmentJoined[]>();
    for (const c of KANBAN_COLUNAS) m.set(c.id, []);
    for (const a of cards) m.get(colunaDe(a))?.push(a);
    for (const lista of m.values()) {
      lista.sort(
        (a, b) =>
          new Date(b.stageUpdatedAt ?? b.respondedAt ?? b.offeredAt).getTime() -
          new Date(a.stageUpdatedAt ?? a.respondedAt ?? a.offeredAt).getTime(),
      );
    }
    return m;
  }, [cards]);

  return (
    <div>
      {/* filtros + alternância kanban/lista */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <div
          role="group"
          aria-label="Modo de visualização"
          style={{ display: "flex", overflow: "hidden", borderRadius: 10, border: "1px solid var(--border-300)" }}
        >
          {(["kanban", "lista"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={visao === v}
              onClick={() => setVisao(v)}
              style={{
                padding: "7px 14px",
                fontSize: 13,
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
                background: visao === v ? "var(--text-strong, #111827)" : "var(--surface, #fff)",
                color: visao === v ? "#fff" : "var(--text-subtle, #6b7280)",
              }}
            >
              {v === "kanban" ? "Kanban" : "Lista"}
            </button>
          ))}
        </div>

        <Select aria-label="Filtrar por corretor" value={fCorretor} onChange={(e) => setFCorretor(e.target.value)} style={{ width: "auto" }}>
          <option value="">Todos os corretores</option>
          {corretores.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>

        <Select aria-label="Filtrar por etapa" value={fEtapa} onChange={(e) => setFEtapa(e.target.value)} style={{ width: "auto" }}>
          <option value="">Todas as etapas</option>
          {KANBAN_COLUNAS.map((c) => (
            <option key={c.id} value={c.id}>{c.titulo}</option>
          ))}
        </Select>

        <Input
          aria-label="Buscar lead"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar lead, telefone ou corretor…"
          style={{ flex: "1 1 220px" }}
        />

        {(fCorretor || fEtapa || busca) && (
          <button
            type="button"
            onClick={() => { setFCorretor(""); setFEtapa(""); setBusca(""); }}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "var(--text-subtle)" }}
          >
            Limpar filtros ✕
          </button>
        )}
      </div>

      {visao === "kanban" ? (
        <>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
            Um card por lead (estado atual). O histórico de redistribuições fica na visão em lista. Clique no card para abrir a conversa.
          </p>
          <div style={{ display: "flex", gap: 12, overflowX: "auto", padding: "12px 0 14px" }}>
            {KANBAN_COLUNAS.map((col) => {
              const itens = porColuna.get(col.id) ?? [];
              return (
                <div
                  key={col.id}
                  style={{
                    width: 250,
                    flex: "0 0 auto",
                    display: "flex",
                    flexDirection: "column",
                    borderRadius: 12,
                    border: "1px solid var(--border-300)",
                    background: "var(--bg-100, #f8f9fb)",
                  }}
                >
                  <div
                    style={{
                      borderTop: `3px solid ${col.cor}`,
                      borderBottom: "1px solid var(--border-300)",
                      borderRadius: "12px 12px 0 0",
                      background: "var(--surface, #fff)",
                      padding: "8px 12px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-subtle)" }}>
                      {col.titulo}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, background: "var(--bg-200, #eef0f3)", borderRadius: 999, padding: "2px 8px", color: "var(--text-subtle)" }}>
                      {itens.length}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 8 }}>
                    {itens.length === 0 && (
                      <p className="muted" style={{ margin: 0, padding: "12px 4px", textAlign: "center", fontSize: 12 }}>vazio</p>
                    )}
                    {itens.map((a) => (
                      <Link
                        key={a.id}
                        href={`/conversas?c=${encodeURIComponent(a.conversationId)}`}
                        style={{
                          display: "block",
                          borderRadius: 10,
                          border: "1px solid var(--border-300)",
                          background: "var(--surface, #fff)",
                          padding: "10px 12px",
                          textDecoration: "none",
                          color: "inherit",
                          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                          <strong style={{ fontSize: 13 }}>{nomeLead(a)}</strong>
                          {a.leadScore != null && (
                            <span style={{ fontSize: 11, fontWeight: 700, background: "var(--bg-200, #eef0f3)", borderRadius: 6, padding: "1px 6px", color: "var(--text-subtle)" }}>
                              {a.leadScore}
                            </span>
                          )}
                        </div>
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{a.contactPhone ?? "—"}</div>
                        {/* sub-estado que não tem coluna própria (agrupado em "Em atendimento") */}
                        {a.stage === "sem_contato" && (
                          <span style={{ display: "inline-block", marginTop: 6, fontSize: 11, fontWeight: 700, background: "#fef3c7", color: "#92400e", borderRadius: 6, padding: "1px 6px" }}>
                            Sem contato
                          </span>
                        )}
                        <div style={{ fontSize: 12, marginTop: 8 }}>
                          👤 {a.brokerName}
                          {a.agencyName ? <span className="muted"> · {a.agencyName}</span> : null}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "var(--text-subtle)" }}>
                          <span>{tempoRelativo(a.stageUpdatedAt ?? a.respondedAt ?? a.offeredAt, agoraMs)}</span>
                          {a.attempt > 1 && (
                            <span style={{ background: "#fef3c7", color: "#92400e", borderRadius: 6, padding: "1px 6px", fontWeight: 700 }}>
                              {a.attempt}ª distrib.
                            </span>
                          )}
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table className={tableClass} style={{ minWidth: 760 }}>
            <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
              Leads distribuídos aos corretores com situação e tempos de atendimento
            </caption>
            <thead>
              <tr>
                <th>Lead</th>
                <th>Corretor</th>
                <th>Situação</th>
                <th>Oferecido há</th>
                <th>Aceite em</th>
                <th>Última atualização</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: "center", padding: "28px 12px" }}>
                    {atendimentos.length === 0
                      ? "Nenhum lead distribuído ainda. Assim que a SDR qualificar o primeiro lead, ele aparece aqui."
                      : "Nenhum atendimento com os filtros atuais."}
                  </td>
                </tr>
              )}
              {filtrados.map((a) => {
                const cor = COR_STATUS[a.status] ?? { bg: "var(--bg-200, #eef0f3)", fg: "var(--text-subtle, #6b7280)" };
                return (
                  <tr key={a.id}>
                    <td>
                      <Link href={`/conversas?c=${encodeURIComponent(a.conversationId)}`} style={{ fontWeight: 600, color: "inherit", textDecoration: "none" }}>
                        {nomeLead(a)}
                      </Link>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {a.contactPhone ?? "—"}
                        {a.leadScore != null ? ` · score ${a.leadScore}` : ""}
                      </div>
                    </td>
                    <td>
                      {a.brokerName}
                      {a.agencyName && <div className="muted" style={{ fontSize: 11.5 }}>{a.agencyName}</div>}
                    </td>
                    <td>
                      <span style={{ display: "inline-block", borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 600, background: cor.bg, color: cor.fg }}>
                        {rotuloLinha(a)}
                      </span>
                      {a.attempt > 1 && <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>{a.attempt}ª distribuição</div>}
                    </td>
                    <td>{tempoRelativo(a.offeredAt, agoraMs)}</td>
                    <td>{duracaoAceite(a.offeredAt, a.respondedAt)}</td>
                    <td>{tempoRelativo(a.stageUpdatedAt ?? a.respondedAt ?? a.offeredAt, agoraMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
