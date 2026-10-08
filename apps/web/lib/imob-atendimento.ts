// Funil do atendimento imobiliário — rótulos, colunas do kanban e formatadores
// PUROS (client-safe). Portado da Central Menin quando a área de atendimento
// migrou para dentro do painel SDR (visão do empreendimento logado).

import type { ImobAssignmentJoined } from "./api";

export const ROTULO_STATUS_ATENDIMENTO: Record<string, string> = {
  offered: "Aguardando aceite",
  accepted: "Em atendimento",
  declined: "Recusado",
  expired: "Expirado",
  closed: "Encerrado",
};

export const ROTULO_ETAPA: Record<string, string> = {
  em_atendimento: "Em atendimento",
  visita_agendada: "Visita agendada",
  em_negociacao: "Em negociação",
  sem_contato: "Sem contato",
  proposta: "Proposta enviada",
  contrato: "Contrato assinado 🎉",
  sem_interesse: "Sem interesse",
};

/**
 * `agoraMs` estável por render evita divergência SSR/client na virada do
 * minuto (aprendizado da Central — achado Codex de hydration mismatch).
 */
export function tempoRelativo(iso: string | null, agoraMs: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const min = Math.round((agoraMs - t) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60 > 0 ? ` ${min % 60}min` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 > 0 ? ` ${h % 24}h` : ""}`;
}

export function duracaoAceite(offeredAt: string, respondedAt: string | null): string {
  if (!respondedAt) return "—";
  const t0 = new Date(offeredAt).getTime();
  const t1 = new Date(respondedAt).getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return "—";
  const s = Math.round((t1 - t0) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)} min`;
}

export function nomeLead(a: ImobAssignmentJoined): string {
  const nome = a.leadFields?.nome;
  if (typeof nome === "string" && nome.trim()) return nome.trim();
  return a.contactName?.trim() || a.contactPhone || "Lead sem nome";
}

export interface KanbanColuna {
  id: string;
  titulo: string;
  cor: string; // faixa superior da coluna
}

export const KANBAN_COLUNAS: KanbanColuna[] = [
  { id: "aguardando", titulo: "Aguardando aceite", cor: "#f59e0b" },
  { id: "em_atendimento", titulo: "Em atendimento", cor: "#10b981" },
  { id: "visita_agendada", titulo: "Visita agendada", cor: "#3b82f6" },
  { id: "em_negociacao", titulo: "Em negociação", cor: "#8b5cf6" },
  { id: "proposta", titulo: "Proposta enviada", cor: "#06b6d4" },
  { id: "contrato", titulo: "Contrato assinado", cor: "#22c55e" },
  { id: "perdidos", titulo: "Perdidos / encerrados", cor: "#9ca3af" },
];

/** Coluna do kanban para uma atribuição (a MAIS RECENTE de cada lead). */
export function colunaDe(a: ImobAssignmentJoined): string {
  if (a.status === "offered") return "aguardando";
  if (a.status === "accepted") {
    if (a.stage === "visita_agendada") return "visita_agendada";
    if (a.stage === "em_negociacao") return "em_negociacao";
    if (a.stage === "proposta") return "proposta";
    return "em_atendimento"; // em_atendimento | sem_contato | null
  }
  if (a.status === "closed" && a.stage === "contrato") return "contrato";
  // closed+sem_interesse, declined, expired
  return "perdidos";
}

/**
 * Uma linha por LEAD (a atribuição mais recente vence): o kanban mostra o
 * estado ATUAL; o histórico completo (redistribuições) fica na visão em lista.
 * Desempate determinístico: offeredAt → attempt → id.
 */
export function ultimaPorLead(atendimentos: ImobAssignmentJoined[]): ImobAssignmentJoined[] {
  const vence = (a: ImobAssignmentJoined, b: ImobAssignmentJoined): boolean => {
    const ta = new Date(a.offeredAt).getTime();
    const tb = new Date(b.offeredAt).getTime();
    if (ta !== tb) return ta > tb;
    if (a.attempt !== b.attempt) return a.attempt > b.attempt;
    return a.id > b.id;
  };
  const porConversa = new Map<string, ImobAssignmentJoined>();
  for (const a of atendimentos) {
    const atual = porConversa.get(a.conversationId);
    if (!atual || vence(a, atual)) porConversa.set(a.conversationId, a);
  }
  return [...porConversa.values()];
}

/** Busca sem acento/caixa ("Jose" acha "José"). */
export function normalizarBusca(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
