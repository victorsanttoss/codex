import { Injectable, Logger } from "@nestjs/common";
import { runWithTenant } from "@sdr/core";
import { getConversationHistory, getTenantNicheId, listConvertedConversationIds } from "@sdr/db";
import { redactPII } from "./anonymization";
import { CurationService } from "./curation.service";

/**
 * Extrator de insight: recebe a transcrição (texto) e devolve um PADRÃO
 * GENERALIZÁVEL (não verbatim, sem PII) ou null. A implementação default usa o
 * LLM de plataforma; testes injetam um fake. É o ponto sensível — conservador.
 */
export interface InsightExtractor {
  extract(transcript: string): Promise<{ candidateType: string; content: string } | null>;
}

export const INSIGHT_EXTRACTOR = "INSIGHT_EXTRACTOR";

/**
 * Mineração de candidatos a partir de conversas que CONVERTERAM. Lê os dados do
 * tenant SOB `withTenant` (RLS), extrai um padrão generalizado e cria um
 * candidato ANONIMIZADO (via CurationService) para revisão humana. NUNCA promove
 * automaticamente; `source_tenant_id` fica só para auditoria.
 */
@Injectable()
export class CurationMiningService {
  private readonly logger = new Logger(CurationMiningService.name);

  constructor(
    private readonly curation: CurationService,
    private readonly extractor: InsightExtractor,
  ) {}

  /** Minera uma conversa específica (deve rodar no contexto do tenant). */
  async mineConversation(
    nicheId: string,
    conversationId: string,
    sourceTenantId: string,
  ): Promise<{ created: boolean }> {
    const history = await getConversationHistory(conversationId, 50);
    const raw = history
      .map((m) => `${m.direction === "inbound" ? "Lead" : "SDR"}: ${asText(m.content)}`)
      .filter((l) => l.length > 6)
      .join("\n");
    if (!raw) return { created: false };
    // PRÉ-REDAÇÃO: o LLM extrator NÃO recebe PII crua (defesa antes do modelo).
    const transcript = redactPII(raw).redacted;

    const insight = await this.extractor.extract(transcript);
    if (!insight) return { created: false };

    // CurationService re-anonimiza e recusa se sobrar PII.
    await this.curation.createCandidate(nicheId, {
      candidateType: insight.candidateType,
      content: insight.content,
      sourceTenantId, // auditoria-only
      sourceRefs: [{ conversationId }],
    });
    return { created: true };
  }

  /** Minera todas as conversas convertidas de um tenant do nicho. */
  async mineTenant(nicheId: string, tenantId: string, limit = 20): Promise<{ created: number }> {
    // GUARDA cross-nicho: o tenant DEVE pertencer ao nicho alvo (resolvido no servidor).
    const tenantNiche = await runWithTenant({ tenantId }, () => getTenantNicheId());
    if (tenantNiche !== nicheId) {
      throw new Error(`Tenant ${tenantId} não pertence ao nicho ${nicheId} (é ${tenantNiche ?? "nenhum"}).`);
    }
    let created = 0;
    const convIds = await runWithTenant({ tenantId }, () => listConvertedConversationIds(limit));
    for (const conversationId of convIds) {
      try {
        const r = await runWithTenant({ tenantId }, () =>
          this.mineConversation(nicheId, conversationId, tenantId),
        );
        if (r.created) created++;
      } catch (err) {
        this.logger.warn(`Mineração ${conversationId} falhou: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { created };
  }
}

function asText(content: Record<string, unknown>): string {
  return typeof content.text === "string" ? content.text : "";
}
