"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getLeads, type LeadRow, type Paged } from "../../../lib/api";
import { Button, Card, EmptyState, ErrorState, Input, Pager, Select, SkeletonRows, StatusPill, tableClass, rowClickable } from "../../../components/ui";
import { IconLeads } from "../../../components/icons";
import { ScoreTag, fmtDate } from "../../../components/lead-bits";

const STATUSES = [
  { v: "", l: "Todos os status" },
  { v: "new", l: "Novo" },
  { v: "qualified", l: "Qualificado" },
  { v: "scheduled", l: "Agendado" },
  { v: "handoff", l: "Atendimento humano" },
  { v: "disqualified", l: "Desqualificado" },
];
const SCORES = [
  { v: "", l: "Score ≥ 0" },
  { v: "40", l: "Score ≥ 40" },
  { v: "70", l: "Score ≥ 70" },
];
const PAGE = 20;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const ini = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : name.slice(0, 2);
  return ini.toUpperCase() || "?";
}

export default function LeadsPage() {
  const router = useRouter();
  const [data, setData] = useState<Paged<LeadRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState(""); // valor com debounce de 300ms
  const [status, setStatus] = useState("");
  const [minScore, setMinScore] = useState("");
  const [page, setPage] = useState(0);

  // Debounce da busca (300ms) para não martelar a API a cada tecla.
  useEffect(() => {
    const t = setTimeout(() => { setPage(0); setSearch(searchInput); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    getLeads({ search, status, minScore: minScore || undefined, limit: PAGE, offset: page * PAGE })
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [search, status, minScore, page]);

  useEffect(() => { load(); }, [load]);

  const pageCount = useMemo(() => (data ? Math.ceil(data.total / PAGE) : 0), [data]);

  const [exporting, setExporting] = useState(false);
  /** Exporta CSV com os FILTROS atuais. O botão existia sem handler
   *  (auditoria) — clique morto virava "não funciona". Pagina de 100 em 100
   *  (teto REAL do backend — pedir 1000 devolvia 100 em silêncio) até 2000. */
  async function exportCsv() {
    setExporting(true);
    try {
      const rows: LeadRow[] = [];
      for (let offset = 0; offset < 2000; offset += 100) {
        const p = await getLeads({ search, status, minScore: minScore || undefined, limit: 100, offset });
        rows.push(...p.rows);
        if (rows.length >= p.total || p.rows.length === 0) break;
      }
      // Escapa aspas E neutraliza fórmula do Excel (=, +, -, @ no início —
      // CSV injection; o ' prefixado força texto).
      const esc = (v: unknown) => {
        const s = String(v ?? "");
        return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
      };
      const lines = [
        ["nome", "telefone", "etapa", "status", "score", "ultimo_contato", "resumo"].join(";"),
        ...rows.map((r) =>
          [esc(r.name), esc(r.phone), esc(r.stage), esc(r.status), r.score, esc(r.lastContactAt ?? ""), esc(r.summary ?? "")].join(";"),
        ),
      ];
      // ﻿ (BOM): Excel pt-BR abre UTF-8 com acento correto.
      const blob = new Blob([`﻿${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Não conseguimos exportar os leads. Tente de novo.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <h1 className="h1-page">Leads</h1>
        <Button variant="secondary" size="sm" disabled={exporting} onClick={() => void exportCsv()}>{exporting ? "Exportando…" : "Exportar"}</Button>
      </div>

      <Card pad={false} style={{ marginBottom: 14, padding: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <Input placeholder="Buscar por nome ou telefone…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} style={{ maxWidth: 280 }} />
        <Select value={status} onChange={(e) => { setPage(0); setStatus(e.target.value); }} style={{ width: "auto" }}>
          {STATUSES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
        </Select>
        <Select value={minScore} onChange={(e) => { setPage(0); setMinScore(e.target.value); }} style={{ width: "auto" }} aria-label="Filtrar por score mínimo">
          {SCORES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
        </Select>
      </Card>

      <Card pad={false}>
        <table className={tableClass}>
          <thead>
            <tr><th>Lead</th><th>Status</th><th>Score</th><th>Último contato</th></tr>
          </thead>
          <tbody>
            {loading && <SkeletonRows cols={4} />}
            {!loading && data?.rows.map((r) => (
              <tr key={r.conversationId} className={rowClickable} onClick={() => router.push(`/leads/${r.conversationId}`)}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--ink-800)", color: "#fff", fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                      {initialsOf(r.name ?? r.waId)}
                    </span>
                    <span>
                      <span style={{ display: "block", fontWeight: 700, color: "var(--ink-900)" }}>{r.name ?? r.waId}</span>
                      <span className="caption">{r.phone ?? r.waId}</span>
                    </span>
                  </div>
                </td>
                <td><StatusPill status={r.status} /></td>
                <td><ScoreTag score={r.score} /></td>
                <td className="muted">{fmtDate(r.lastContactAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && data?.rows.length === 0 && (
          <EmptyState
            title="Nenhum lead ainda"
            hint="Quando seus leads chegarem pelo WhatsApp, eles aparecem aqui qualificados pela SDR."
            icon={<IconLeads />}
            action={<Link href="/playground"><Button>Testar no Playground</Button></Link>}
          />
        )}
        {error && (
          <div style={{ padding: 16 }}>
            <ErrorState message="Não conseguimos buscar seus leads agora." detail={error} onRetry={load} />
          </div>
        )}
      </Card>

      <Pager page={page} pageCount={pageCount} onPage={setPage} />
    </div>
  );
}
