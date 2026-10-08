import { Injectable } from "@nestjs/common";
import { requireTenantContext } from "@sdr/core";
import { getAgentConfig, getNicheConfig, getTenantNicheId } from "@sdr/db";
import type { QualificationSchema } from "./qualification";

export interface Guardrails {
  /** Teto de iterações de tool por turno (anti-loop/custo). */
  maxToolIterations: number;
  /** Teto de custo (micros USD) por turno do agente. */
  maxCostMicrosPerTurn: number;
  /**
   * Teto de custo AGREGADO (micros USD) por tenant por DIA. Acima disto o agente
   * NÃO chama o LLM (responde uma contenção canned uma vez). Protege contra custo
   * ilimitado por tenant que os guardrails por-turno não cobrem.
   */
  maxCostMicrosPerDay: number;
}

/**
 * Dados do NEGÓCIO ensinados pelo cliente no onboarding (etapa "Ensinar o
 * negócio") — viram camada própria do system prompt (entre nicho e persona).
 * Editáveis depois pelo modo revisão do wizard. Campos vazios são omitidos.
 */
export interface BusinessProfile {
  /** O que o negócio vende (produtos/serviços, diferenciais, condições). */
  products: string;
  /** Tom de voz desejado pelo cliente. */
  tone: string;
  /** O que a SDR PODE falar/prometer. */
  canSay: string;
  /** O que a SDR NÃO PODE falar/prometer. */
  cannotSay: string;
}

export interface AgentConfig {
  /** Persona/negócio/tom + guardrails de conteúdo (camada do tenant). */
  persona: string;
  /** Resposta quando o LLM falha (contenção). */
  fallbackMessage: string;
  /** Resposta a mensagem não-texto (áudio/imagem) — seam de transcrição é futuro. */
  nonTextMessage: string;
  /** Mensagem ao escalar para humano. */
  handoffMessage: string;
  /** Confirmação de opt-out (LGPD). */
  optOutMessage: string;
  knowledge: { topK: number; minScore: number };
  guardrails: Guardrails;
  qualification: QualificationSchema;
  business: BusinessProfile;
}

/** Default de PLATAFORMA — usado quando o tenant não tem config própria. */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  persona:
    "Você é um SDR (pré-vendas) cordial e objetivo, atendendo no WhatsApp em " +
    "português do Brasil. Faça perguntas de descoberta uma de cada vez, seja breve " +
    "(mensagens curtas), e use SOMENTE as informações de conhecimento fornecidas " +
    "para fatos sobre o produto. Nunca invente preços, prazos ou promessas.",
  fallbackMessage:
    "Tive uma instabilidade técnica aqui. Já vou te responder — pode aguardar um instante?",
  nonTextMessage:
    "Por enquanto consigo te ajudar melhor por mensagens de texto. Pode me escrever o que precisa?",
  handoffMessage: "Perfeito! Vou te encaminhar para um especialista do time. Já já alguém te chama. 🙌",
  optOutMessage: "Pronto, não vou mais te enviar mensagens por aqui. Se mudar de ideia, é só escrever. 👍",
  knowledge: { topK: 4, minScore: 0.2 },
  // maxCostMicrosPerDay 25_000_000 = US$25/dia/tenant: folgado para volume normal
  // de SDR (~centenas de turnos a ~US$0,05), mas corta abuso/loop desenfreado.
  guardrails: { maxToolIterations: 4, maxCostMicrosPerTurn: 50_000, maxCostMicrosPerDay: 25_000_000 },
  business: { products: "", tone: "", canSay: "", cannotSay: "" },
  qualification: {
    qualifyAtScore: 3,
    fields: [
      { key: "necessidade", type: "string", required: true, weight: 1, description: "o que o cliente precisa/procura (produto, serviço ou problema a resolver)" },
      { key: "autoridade", type: "string", required: true, weight: 1, description: "quem decide a compra (o próprio cliente, sócio, chefe...)" },
      { key: "orcamento", type: "number", weight: 1, eliminatory: { min: 1 }, description: "orçamento/valor disponível mencionado (apenas o número)" },
      { key: "prazo", type: "string", weight: 1, description: "prazo ou urgência mencionados" },
    ],
  },
};

/**
 * Cache in-process da config RESOLVIDA por tenant, com TTL curto. Motivo (perf):
 * config + nicho eram recarregados do banco a CADA mensagem. Invalidação
 * explícita no putAgentConfig/atribuição de nicho (processo local); entre
 * instâncias o TTL limita a defasagem a ~30s — aceitável para config de agente.
 */
const CONFIG_CACHE_TTL_MS = 30_000;
const configCache = new Map<string, { value: AgentConfig; expiresAt: number }>();

/** Invalida o cache de config (chamar após putAgentConfig / troca de nicho). */
export function invalidateAgentConfigCache(tenantId?: string): void {
  if (tenantId) configCache.delete(tenantId);
  else configCache.clear();
}

/**
 * Resolve a config do agente para o tenant ativo: default de plataforma com
 * override (raso) da config persistida do tenant. A camada de NICHO entra aqui
 * depois, entre o default e o tenant, sem mudar a assinatura (ADR 0022).
 */
@Injectable()
export class AgentConfigService {
  async forTenant(): Promise<AgentConfig> {
    const { tenantId } = requireTenantContext();
    const hit = configCache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const stored = (await getAgentConfig()) ?? {};
    const merged = mergeConfig(DEFAULT_AGENT_CONFIG, stored);
    // Schema de qualificação em CAMADAS: tenant > nicho > default (M10, ADR 0022).
    const tenantQual = validQualification(stored.qualification) ? (stored.qualification as QualificationSchema) : null;
    if (!tenantQual) {
      const nicheQual = await this.resolveNicheQualification();
      if (nicheQual) merged.qualification = nicheQual;
    }
    configCache.set(tenantId, { value: merged, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
    return merged;
  }

  /** Schema do nicho do tenant (se houver e for válido). */
  private async resolveNicheQualification(): Promise<QualificationSchema | null> {
    try {
      const nicheId = await getTenantNicheId();
      if (!nicheId) return null;
      const cfg = await getNicheConfig(nicheId);
      return cfg && validQualification(cfg.qualification) ? (cfg.qualification as QualificationSchema) : null;
    } catch {
      return null;
    }
  }
}

const str = (v: unknown, dflt: string): string =>
  typeof v === "string" && v.trim().length > 0 ? v : dflt;

/** Texto livre do negócio: dado não-confiável (jsonb) — só string, com teto. */
const BUSINESS_FIELD_MAX = 4_000;
const bizStr = (v: unknown): string =>
  typeof v === "string" ? v.trim().slice(0, BUSINESS_FIELD_MAX) : "";

const clampInt = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : dflt;

const clampNum = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;

const QUAL_TYPES = new Set(["string", "number", "boolean"]);

/**
 * Aceita o schema de qualificação (tenant OU nicho) SÓ se for estruturalmente
 * VÁLIDO e seguro — dado não-confiável dirige a função determinística do M6.
 * Tipos enumerados, pesos finitos ≥0, qualifyAtScore finito ≥0, no máx. 30 campos.
 */
function validQualification(v: unknown): v is QualificationSchema {
  if (typeof v !== "object" || v === null) return false;
  const q = v as Partial<QualificationSchema>;
  if (q.enabled !== undefined && typeof q.enabled !== "boolean") return false;
  // DESLIGADA pode vir sem campos (o cliente desligou sem configurar nenhum);
  // ligada continua exigindo ≥1 — sem campos não há o que pontuar.
  if (!Array.isArray(q.fields) || q.fields.length > 30) return false;
  if (q.enabled !== false && q.fields.length === 0) return false;
  if (typeof q.qualifyAtScore !== "number" || !Number.isFinite(q.qualifyAtScore) || q.qualifyAtScore < 0) {
    return false;
  }
  return q.fields.every((f) => {
    if (!f || typeof f.key !== "string" || !f.key || typeof f.type !== "string") return false;
    if (!QUAL_TYPES.has(f.type)) return false;
    if (f.required !== undefined && typeof f.required !== "boolean") return false;
    if (f.weight !== undefined && (!Number.isFinite(f.weight) || f.weight < 0 || f.weight > 1000)) return false;
    if (f.eliminatory !== undefined && (typeof f.eliminatory !== "object" || f.eliminatory === null)) return false;
    if (f.description !== undefined && (typeof f.description !== "string" || f.description.trim().length === 0 || f.description.length > 300)) return false;
    return true;
  });
}

/**
 * Merge SEGURO: a config do tenant é dado não-confiável (jsonb). Strings caem no
 * default se vazias; números são CLAMPADOS em faixas seguras (evita guardrail
 * gigante/zero); qualification só é aceita se válida. Nunca remove limites.
 * Exportado para teste.
 */
export function mergeConfig(base: AgentConfig, override: Record<string, unknown>): AgentConfig {
  const o = override as Record<string, unknown>;
  const know = (o.knowledge ?? {}) as Record<string, unknown>;
  const guard = (o.guardrails ?? {}) as Record<string, unknown>;
  const biz = (typeof o.business === "object" && o.business !== null ? o.business : {}) as Record<
    string,
    unknown
  >;
  return {
    persona: str(o.persona, base.persona),
    fallbackMessage: str(o.fallbackMessage, base.fallbackMessage),
    nonTextMessage: str(o.nonTextMessage, base.nonTextMessage),
    handoffMessage: str(o.handoffMessage, base.handoffMessage),
    optOutMessage: str(o.optOutMessage, base.optOutMessage),
    knowledge: {
      topK: clampInt(know.topK, 1, 20, base.knowledge.topK),
      minScore: clampNum(know.minScore, -1, 1, base.knowledge.minScore),
    },
    guardrails: {
      maxToolIterations: clampInt(guard.maxToolIterations, 1, 10, base.guardrails.maxToolIterations),
      maxCostMicrosPerTurn: clampInt(
        guard.maxCostMicrosPerTurn,
        1_000,
        5_000_000,
        base.guardrails.maxCostMicrosPerTurn,
      ),
      maxCostMicrosPerDay: clampInt(
        guard.maxCostMicrosPerDay,
        100_000, // piso: US$0,10/dia (nunca "desliga" o teto)
        1_000_000_000, // teto: US$1000/dia
        base.guardrails.maxCostMicrosPerDay,
      ),
    },
    qualification: validQualification(o.qualification) ? o.qualification : base.qualification,
    business: {
      products: bizStr(biz.products),
      tone: bizStr(biz.tone),
      canSay: bizStr(biz.canSay),
      cannotSay: bizStr(biz.cannotSay),
    },
  };
}
