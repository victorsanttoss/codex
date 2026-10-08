/**
 * Mensagens e parsing do fluxo corretor↔agente (funções PURAS, unit-testáveis).
 * O corretor interage só com números — nada de comando/abreviação para decorar.
 */

export interface StageMenuItem {
  n: number;
  stage: string;
  label: string;
}

/** Menu de status do atendimento (resposta numérica do corretor). */
export const IMOB_STAGE_MENU: StageMenuItem[] = [
  { n: 1, stage: "visita_agendada", label: "Visita agendada" },
  { n: 2, stage: "em_negociacao", label: "Em negociação" },
  { n: 3, stage: "sem_contato", label: "Cliente não atendeu (vou tentar de novo)" },
  { n: 4, stage: "sem_interesse", label: "Sem interesse — encerrar" },
  { n: 5, stage: "proposta", label: "Proposta enviada" },
  { n: 6, stage: "contrato", label: "Contrato assinado" },
];

export const IMOB_STAGE_LABELS: Record<string, string> = Object.fromEntries(
  IMOB_STAGE_MENU.map((i) => [i.stage, i.label]),
);

/** Primeiro token numérico da resposta ("1", " 2 ", "1 - aceito") ou null. */
export function parseNumericReply(text: string | undefined): number | null {
  if (!text) return null;
  const m = text.trim().match(/^(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

function fmtMoney(v: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/\D/g, "")) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return `R$ ${Math.round(n).toLocaleString("pt-BR")}`;
}

function s(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

export function leadDisplayName(fields: Record<string, unknown> | null, contactName: string | null): string {
  return s(fields?.nome) ?? s(contactName) ?? "Lead sem nome";
}

export interface OfferMessageInput {
  brokerName: string;
  projectName: string;
  leadName: string;
  leadPhone: string | null;
  fields: Record<string, unknown>;
  score: number | null;
  attempt: number;
  slaMinutes: number;
}

/** Ficha enviada ao corretor quando um lead qualificado é distribuído. */
export function buildOfferMessage(i: OfferMessageInput): string {
  const f = i.fields ?? {};
  const linhas: string[] = [];
  const push = (label: string, value: string | null) => {
    if (value) linhas.push(`${label}: ${value}`);
  };
  push("Nome", i.leadName);
  push("Telefone", i.leadPhone);
  // Lançamento/MCMV (kit 2.0)
  push("Renda familiar", fmtMoney(f.renda_familiar));
  if (typeof f.possui_imovel === "boolean") push("Já tem imóvel", f.possui_imovel ? "Sim" : "Não");
  if (typeof f.fgts_disponivel === "boolean") push("FGTS disponível", f.fgts_disponivel ? "Sim" : "Não");
  push("Família", s(f.composicao_familiar));
  // Compra/aluguel genérico (kit 1.x — campos só aparecem se presentes)
  push("Interesse", s(f.comprar_ou_alugar));
  push("Tipo de imóvel", s(f.tipo_imovel));
  push("Região", s(f.regiao));
  push("Faixa de preço", fmtMoney(f.faixa_preco));
  push("Prazo", s(f.prazo));
  if (typeof f.eh_decisor === "boolean") push("Decide a compra", f.eh_decisor ? "Sim" : "Não");
  if (i.score !== null && i.score !== undefined) push("Score", String(i.score));

  const reoferta = i.attempt > 1 ? `\n(Reoferta — ${i.attempt}ª tentativa de distribuição)` : "";
  return (
    `🏠 NOVO LEAD — ${i.projectName}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `${linhas.join("\n")}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `⏱ Aceite em até ${i.slaMinutes} min (depois o lead vai para outro corretor).${reoferta}\n\n` +
    `Oi ${i.brokerName}! Você pode atender este lead?\n` +
    `1 — Aceitar atendimento\n` +
    `2 — Não posso agora`
  );
}

/** Cobrança periódica de status (o corretor responde com o número). */
export function buildStatusMenuMessage(brokerName: string, leadName: string, projectName: string): string {
  const opcoes = IMOB_STAGE_MENU.map((o) => `${o.n} — ${o.label}`).join("\n");
  return (
    `Oi ${brokerName}! Como está o atendimento do lead ${leadName} (${projectName})?\n` +
    `Responda com o número:\n${opcoes}\n\n` +
    `Ou me mande um resumo por texto que eu registro.`
  );
}

export function buildAcceptedConfirmation(leadName: string, leadPhone: string | null): string {
  const tel = leadPhone ? ` Telefone: ${leadPhone}.` : "";
  return (
    `Fechado! O lead ${leadName} é seu.${tel}\n` +
    `⏱ Faça o primeiro contato em até 30 minutos. Eu volto a falar com você para acompanhar o atendimento.`
  );
}

/** Aceite no modo WORKSPACE: sem telefone — o atendimento é pelo link pessoal. */
export function buildAcceptedConfirmationWorkspace(leadName: string, link: string): string {
  return (
    `Fechado! O lead ${leadName} é seu.\n` +
    `💬 Atenda por aqui (a conversa continua de onde a assistente parou):\n${link}\n` +
    `⏱ Primeiro contato em até 30 minutos. Este link é PESSOAL — não compartilhe.`
  );
}

export function buildDeclinedConfirmation(leadName: string): string {
  return `Tudo bem! O lead ${leadName} será encaminhado a outro corretor. Obrigado por avisar.`;
}

export function buildStageConfirmation(stage: string, leadName: string): string {
  const label = IMOB_STAGE_LABELS[stage] ?? stage;
  if (stage === "contrato") return `🎉 Excelente, ${label.toLowerCase()} do lead ${leadName} registrado! Parabéns pela venda!`;
  if (stage === "sem_interesse") return `Registrado: ${leadName} sem interesse. O atendimento foi encerrado.`;
  return `Registrado: ${label} — lead ${leadName}. Obrigado!`;
}

export function buildUnknownReply(hasPending: boolean): string {
  return hasPending
    ? "Não entendi 🙂 Responda com o NÚMERO de uma das opções que enviei acima."
    : "Oi! Não há pendências suas no momento. Quando eu tiver um lead novo ou precisar de status, te chamo por aqui.";
}

export function buildNoteSaved(leadName: string): string {
  return `Anotado no histórico do lead ${leadName}. Obrigado!`;
}
