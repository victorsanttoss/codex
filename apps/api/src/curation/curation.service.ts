import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { ProviderRegistry } from "@sdr/core";
import {
  createCandidate,
  getCandidate,
  promoteCandidate,
  recordPlatformUsage,
  retireNicheKnowledge,
  setCandidateStatus,
} from "@sdr/db";
import { DEFAULT_EMBEDDING_PRICING, embeddingCostMicros } from "@sdr/llm-router";
import { APP_CONFIG } from "../config/config.module";
import { EMBEDDING_REGISTRY } from "../knowledge/embeddings.registry";
import { AnonymizationService } from "./anonymization.service";

export class CurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurationError";
  }
}

/**
 * Loop de curadoria: criar candidato (anonimizado), aprovar/rejeitar (humano) e
 * PROMOVER ao conhecimento de nicho. INEGOCIÁVEIS: zero PII (re-checado na
 * promoção) e curadoria humana obrigatória (só `approved` promove). Custo da
 * curadoria é da PLATAFORMA (recordPlatformUsage), nunca do tenant.
 */
@Injectable()
export class CurationService {
  private readonly logger = new Logger(CurationService.name);

  constructor(
    @Inject(EMBEDDING_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly anonymizer: AnonymizationService,
  ) {}

  /** Cria candidato — ANONIMIZA antes de gravar; recusa se sobrar PII. */
  async createCandidate(
    nicheId: string,
    input: { candidateType: string; content: string; sourceTenantId?: string; sourceRefs?: unknown[]; evidenceCount?: number },
  ): Promise<{ id: string }> {
    const { redacted, clean } = this.anonymizer.process(input.content);
    if (!clean) throw new CurationError("Conteúdo ainda contém PII após anonimização.");
    return createCandidate(nicheId, {
      candidateType: input.candidateType,
      content: redacted,
      redactionChecked: true,
      ...(input.sourceTenantId ? { sourceTenantId: input.sourceTenantId } : {}),
      ...(input.sourceRefs ? { sourceRefs: input.sourceRefs } : {}),
      ...(input.evidenceCount !== undefined ? { evidenceCount: input.evidenceCount } : {}),
    });
  }

  /** Aprova (curador humano). Conteúdo editado é re-anonimizado. */
  async approve(nicheId: string, id: string, curatorId: string, editedContent?: string): Promise<void> {
    let content: string | undefined;
    if (editedContent !== undefined) {
      const { redacted, clean } = this.anonymizer.process(editedContent);
      if (!clean) throw new CurationError("Edição contém PII.");
      content = redacted;
    }
    await setCandidateStatus(nicheId, id, "approved", curatorId, content);
  }

  async reject(nicheId: string, id: string, curatorId: string): Promise<void> {
    await setCandidateStatus(nicheId, id, "rejected", curatorId);
  }

  /**
   * PROMOVE um candidato APROVADO ao conhecimento de nicho (versionado). Gate
   * humano obrigatório: candidato não-aprovado lança. Re-checa PII antes de gravar.
   */
  async promote(nicheId: string, id: string): Promise<{ knowledgeId: string }> {
    const cand = await getCandidate(nicheId, id);
    if (!cand) throw new CurationError("Candidato não encontrado.");
    if (cand.status !== "approved") {
      throw new CurationError(`Só candidato 'approved' promove (atual: ${cand.status}).`);
    }
    if (this.anonymizer.hasPII(cand.content)) {
      throw new CurationError("Candidato contém PII — promoção bloqueada.");
    }
    const embedding = await this.platformEmbed(cand.content);
    // Promoção ATÔMICA: re-valida 'approved' na MESMA transação da escrita (sem bypass).
    const { knowledgeId } = await promoteCandidate(nicheId, id, embedding);
    this.logger.log(`Candidato ${id} promovido ao nicho ${nicheId} (knowledge ${knowledgeId}).`);
    return { knowledgeId };
  }

  /** Rollback: aposenta um item de conhecimento de nicho. */
  async retire(nicheId: string, knowledgeId: string): Promise<void> {
    await retireNicheKnowledge(nicheId, knowledgeId);
  }

  /** Embedding via provedor de PLATAFORMA (sem tenant) + metering de plataforma. */
  private async platformEmbed(text: string): Promise<number[]> {
    const provider = this.registry.embeddingFor({
      embeddingAdapter: "openai_compat",
      embeddingConfig: {
        baseURL: this.cfg.embeddings.baseURL,
        model: this.cfg.embeddings.defaultModel,
        maxBatch: this.cfg.embeddings.maxBatch,
        timeoutMs: this.cfg.embeddings.timeoutMs,
        ...(this.cfg.embeddings.apiKey ? { apiKey: this.cfg.embeddings.apiKey } : {}),
      },
    });
    const res = await provider.embed([text]);
    const model = this.cfg.embeddings.defaultModel;
    const cost = embeddingCostMicros(model, res.usage.tokensIn, DEFAULT_EMBEDDING_PRICING);
    await recordPlatformUsage({
      type: "curation_embedding",
      tokensIn: res.usage.tokensIn,
      costMicros: cost,
      metadata: { model },
    });
    const vec = res.vectors[0];
    if (!vec) throw new CurationError("Embedding vazio na promoção.");
    return vec;
  }
}
