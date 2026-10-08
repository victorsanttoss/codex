/**
 * Motor de qualificação DETERMINÍSTICO. A IA apenas PREENCHE os campos (via tool
 * `update_lead_fields`); a DECISÃO (qualificado/desqualificado/pendente, score,
 * rota) é esta função PURA — auditável e repetível (mesma entrada → mesma saída).
 * Nada de LLM aqui.
 */

export type QualType = "string" | "number" | "boolean";

export interface EliminatoryRule {
  /** valor deve ser >= min */
  min?: number;
  /** valor deve ser exatamente igual */
  equals?: string | number | boolean;
  /** valor deve estar nesta lista */
  oneOf?: Array<string | number | boolean>;
}

export interface QualificationField {
  key: string;
  type: QualType;
  required?: boolean;
  /** Se presente e VIOLADA → desqualifica imediatamente (eliminatório). */
  eliminatory?: EliminatoryRule;
  /** Peso somado ao score quando o campo está satisfatoriamente preenchido. */
  weight?: number;
  /**
   * O que o campo significa, em linguagem natural (ex.: "o tratamento que o
   * cliente quer"). Vai no prompt de extração/tool — modelos pequenos não
   * conectam a chave nua ao conteúdo da conversa sem isso.
   */
  description?: string;
}

export interface QualificationSchema {
  fields: QualificationField[];
  /** Score mínimo (com todos os obrigatórios presentes) para `qualified`. */
  qualifyAtScore: number;
  /**
   * Qualificação automática LIGADA? (ausente = true — retrocompatível com
   * configs/kits existentes). Desligada, a SDR só atende: nenhuma extração,
   * nenhuma decisão, lead não muda de estágio (promessa da etapa 4 do wizard).
   */
  enabled?: boolean;
}

/**
 * Qualificação ATIVA? (ligada e com ao menos um campo). Inativa, a decisão é
 * NEUTRA e não deve tocar o lead — o chamador pula o applyLeadDecision (não
 * move estágio nem reabre desqualificado).
 */
export function qualificationActive(schema: QualificationSchema): boolean {
  return schema.enabled !== false && schema.fields.length > 0;
}

export type QualDecision = "qualified" | "disqualified" | "pending";
export type QualRoute = "handoff" | "continue_discovery" | "nurture";

export interface QualificationResult {
  decision: QualDecision;
  score: number;
  route: QualRoute;
  missingRequired: string[];
  /** chaves de campos eliminatórios violados (motivo da desqualificação). */
  eliminatedBy: string[];
}

/**
 * Coage o valor extraído ao TIPO do campo. A IA pode preencher número como
 * string ("5000") ou tipo errado; aqui normalizamos. Tipo incoercível →
 * `present: false` (não pontua e NÃO elimina por engano).
 */
export function coerceField(raw: unknown, type: QualType): { present: boolean; value: unknown } {
  if (raw === undefined || raw === null || raw === "") return { present: false, value: undefined };
  if (type === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) return { present: true, value: raw };
    if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
      return { present: true, value: Number(raw) };
    }
    return { present: false, value: undefined };
  }
  if (type === "boolean") {
    if (typeof raw === "boolean") return { present: true, value: raw };
    if (typeof raw === "string" && raw.trim() === "true") return { present: true, value: true };
    if (typeof raw === "string" && raw.trim() === "false") return { present: true, value: false };
    return { present: false, value: undefined };
  }
  // string: aceita string não-vazia ou número (coage p/ string); objeto/array → ausente.
  if (typeof raw === "string" && raw.trim() !== "") return { present: true, value: raw.trim() };
  if ((typeof raw === "number" && Number.isFinite(raw)) || typeof raw === "boolean") {
    return { present: true, value: String(raw) };
  }
  return { present: false, value: undefined };
}

/** Mesma definição de ausência para decisão, seleção da extração e reparo. */
export function missingQualificationFields(
  schema: QualificationSchema,
  fields: Record<string, unknown>,
): string[] {
  return schema.fields
    .filter((f) => !coerceField(fields[f.key], f.type).present)
    .map((f) => f.key);
}

/** Whitelist e coerção de entrada antes da persistência, sem apagar dados válidos. */
export function normalizeLeadFields(
  raw: unknown,
  fields: QualificationField[],
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const entries: Array<[string, unknown]> = [];
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(input, f.key)) continue;
    const coerced = coerceField(input[f.key], f.type);
    if (coerced.present) entries.push([f.key, coerced.value]);
  }
  return Object.fromEntries(entries);
}

/** O valor satisfaz a regra eliminatória? (sem regra → satisfaz por vacuidade). */
function satisfiesEliminatory(value: unknown, rule: EliminatoryRule | undefined): boolean {
  if (!rule) return true;
  if (rule.min !== undefined) {
    if (typeof value !== "number" || value < rule.min) return false;
  }
  if (rule.equals !== undefined && value !== rule.equals) return false;
  if (rule.oneOf !== undefined && !rule.oneOf.includes(value as string | number | boolean)) {
    return false;
  }
  return true;
}

/**
 * Decide a qualificação a partir do schema (data-driven) e dos campos extraídos.
 * Ordem: ELIMINATÓRIOS primeiro → obrigatórios faltando = pendente → score.
 * Abaixo da meta, permanece pendente enquanto campos não preenchidos puderem
 * atingir a meta. Nenhum peso, limiar ou regra comercial é modificado.
 */
export function decideQualification(
  schema: QualificationSchema,
  fields: Record<string, unknown>,
): QualificationResult {
  // Desligada (ou sem nenhum campo — nada a pontuar): decisão NEUTRA. Sem isto,
  // score 0 < qualifyAtScore desqualificaria todo lead de um tenant que só quer
  // a SDR atendendo. Centralizado AQUI: todos os chamadores (handler, playground)
  // herdam o comportamento.
  if (schema.enabled === false || schema.fields.length === 0) {
    return { decision: "pending", score: 0, route: "continue_discovery", missingRequired: [], eliminatedBy: [] };
  }
  const eliminatedBy: string[] = [];
  const missingRequired: string[] = [];
  let score = 0;
  let remainingScore = 0;

  for (const f of schema.fields) {
    const { present, value } = coerceField(fields[f.key], f.type);

    // eliminatório só vale quando o campo está PREENCHIDO (não pune o que falta).
    if (present && f.eliminatory && !satisfiesEliminatory(value, f.eliminatory)) {
      eliminatedBy.push(f.key);
    }
    if (f.required && !present) missingRequired.push(f.key);
    if (present && satisfiesEliminatory(value, f.eliminatory)) score += f.weight ?? 0;
    if (!present) remainingScore += f.weight ?? 0;
  }

  if (eliminatedBy.length > 0) {
    return { decision: "disqualified", score, route: "nurture", missingRequired, eliminatedBy };
  }
  if (missingRequired.length > 0) {
    return { decision: "pending", score, route: "continue_discovery", missingRequired, eliminatedBy };
  }
  if (score >= schema.qualifyAtScore) {
    return { decision: "qualified", score, route: "handoff", missingRequired, eliminatedBy };
  }
  if (score + remainingScore >= schema.qualifyAtScore) {
    return { decision: "pending", score, route: "continue_discovery", missingRequired, eliminatedBy };
  }
  return { decision: "disqualified", score, route: "nurture", missingRequired, eliminatedBy };
}

/** Mapeia a decisão para o estado do lead (governado por CÓDIGO, não pela IA). */
export function decisionToLeadState(r: QualificationResult): {
  stage: string;
  status: string;
  score: number;
} {
  if (r.decision === "qualified") return { stage: "qualified", status: "qualified", score: r.score };
  if (r.decision === "disqualified") {
    return { stage: "disqualified", status: "disqualified", score: r.score };
  }
  return { stage: "qualifying", status: "new", score: r.score };
}
