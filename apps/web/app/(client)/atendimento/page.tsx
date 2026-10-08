"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getImobAssignmentsApi,
  getImobOverviewApi,
  type ImobAssignmentJoined,
  type ImobOverview,
} from "../../../lib/api";
import { AtendimentoBoard } from "../../../components/atendimento-board";
import { ErrorState, Kpi, SkeletonBlock } from "../../../components/ui";

const REFRESH_MS = 60_000;

/**
 * ATENDIMENTO — visão do gestor sobre a distribuição de leads aos corretores
 * (kanban + lista + KPIs). Migrada da Central Menin para DENTRO do painel:
 * um ambiente só, e cada card abre a conversa real do lead.
 */
export default function AtendimentoPage() {
  const [overview, setOverview] = useState<ImobOverview | null>(null);
  const [atendimentos, setAtendimentos] = useState<ImobAssignmentJoined[] | null>(null);
  const [agoraMs, setAgoraMs] = useState(() => Date.now());
  const [erro, setErro] = useState("");

  const carregar = useCallback(async () => {
    try {
      const [o, a] = await Promise.all([getImobOverviewApi(), getImobAssignmentsApi(500)]);
      setOverview(o);
      setAtendimentos(a.assignments);
      setAgoraMs(Date.now());
      setErro("");
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível carregar o atendimento.");
    }
  }, []);

  useEffect(() => {
    void carregar();
    const t = setInterval(() => void carregar(), REFRESH_MS);
    return () => clearInterval(t);
  }, [carregar]);

  if (erro && !atendimentos) {
    return (
      <div>
        <h1 className="h1-page" style={{ marginBottom: 18 }}>Atendimento</h1>
        <ErrorState message="Não foi possível carregar o atendimento." detail={erro} onRetry={() => void carregar()} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1 className="h1-page" style={{ margin: 0 }}>Atendimento</h1>
        <span className="muted" style={{ fontSize: 12 }}>atualiza a cada 60s</span>
      </div>

      {overview === null || atendimentos === null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
          <SkeletonBlock height={72} />
          <SkeletonBlock height={220} />
        </div>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 10,
              margin: "16px 0 18px",
            }}
          >
            <Kpi dense label="Ofertados hoje" value={overview.today.offered} />
            <Kpi dense label="Aceitos hoje" value={overview.today.accepted} />
            <Kpi
              dense
              label={`Aceites em ${overview.slaMinutes} min`}
              value={overview.today.acceptedInSla}
            />
            <Kpi dense label="Expirados hoje" value={overview.today.expired} />
            <Kpi dense label="Em atendimento agora" value={overview.active.accepted} />
            <Kpi
              dense
              label="Tempo médio de aceite"
              value={
                overview.avgAcceptSeconds === null
                  ? "—"
                  : overview.avgAcceptSeconds < 60
                    ? `${Math.round(overview.avgAcceptSeconds)}s`
                    : `${Math.round(overview.avgAcceptSeconds / 60)} min`
              }
            />
          </div>

          {erro && (
            <p role="alert" style={{ margin: "0 0 10px", fontSize: 12.5, fontWeight: 600, color: "var(--error-text)" }}>
              Falha na última atualização — mostrando dados anteriores. ({erro})
            </p>
          )}

          {atendimentos.length >= 500 && (
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
              Mostrando as 500 atribuições mais recentes — atendimentos antigos podem não aparecer no histórico.
            </p>
          )}

          <AtendimentoBoard atendimentos={atendimentos} agoraMs={agoraMs} />
        </>
      )}
    </div>
  );
}
