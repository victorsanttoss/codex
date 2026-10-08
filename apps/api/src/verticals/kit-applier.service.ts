import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { ProviderRegistry } from "@sdr/core";
import {
  createNiche,
  getNicheByName,
  getNicheConfig,
  insertNicheKnowledge,
  recordPlatformUsage,
  retirePlatformAuthoredKnowledge,
  setNicheGuidance,
  upsertMessageTemplate,
  upsertNicheConfig,
} from "@sdr/db";
import { DEFAULT_EMBEDDING_PRICING, embeddingCostMicros } from "@sdr/llm-router";
import { APP_CONFIG } from "../config/config.module";
import { EMBEDDING_REGISTRY } from "../knowledge/embeddings.registry";
import type { VerticalKit } from "./vertical-kit";
import { compareSemver, KitError, validateKit } from "./kit-validation";

export interface ApplyResult {
  nicheId: string;
  applied: boolean;
  version: string;
  knowledgeCount: number;
}

/**
 * Aplica um KIT de vertical pelos seams do M9 (sem bypass): cria/atualiza o nicho,
 * promove o conhecimento como `platform_authored` (versionado), grava o schema de
 * qualificação no nível de nicho e o catálogo de templates. IDEMPOTENTE por
 * `version` (reaplicar a mesma versão é no-op; versão maior versiona e aposenta a
 * anterior — não duplica). Custo de embedding é da PLATAFORMA.
 */
@Injectable()
export class KitApplierService {
  private readonly logger = new Logger(KitApplierService.name);

  constructor(
    @Inject(EMBEDDING_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async apply(kit: VerticalKit): Promise<ApplyResult> {
    // 0) validação CENTRAL: semver + estrutura + PII em TODOS os textos (antes de
    //    qualquer write/embedding).
    validateKit(kit);

    // 1) nicho (idempotente por nome)
    const existing = await getNicheByName(kit.niche.name);
    const nicheId = existing
      ? existing.id
      : (await createNiche({ name: kit.niche.name, vertical: kit.niche.vertical, motion: kit.niche.motion, guidance: kit.guidance })).id;

    // 2) idempotência/versionamento: igual = no-op; só aplica versão MAIOR (semver);
    //    recusa downgrade.
    const current = await getNicheConfig(nicheId);
    if (current?.kitVersion) {
      const cmp = compareSemver(kit.version, current.kitVersion);
      if (cmp === 0) {
        this.logger.log(`Kit ${kit.niche.name}@${kit.version} já aplicado — no-op.`);
        return { nicheId, applied: false, version: kit.version, knowledgeCount: 0 };
      }
      if (cmp < 0) {
        throw new KitError(`Downgrade recusado: ${kit.version} < ${current.kitVersion} (nicho ${kit.niche.name}).`);
      }
    }

    // 4) guidance + reaplicação sem duplicar (aposenta o platform_authored anterior)
    await setNicheGuidance(nicheId, kit.guidance);
    await retirePlatformAuthoredKnowledge(nicheId);

    // 5) promove o conhecimento como platform_authored (versionado)
    let knowledgeCount = 0;
    for (const k of kit.knowledge) {
      const embedding = await this.platformEmbed(`${k.type}: ${k.content}`);
      await insertNicheKnowledge(nicheId, k.content, embedding, "platform_authored");
      knowledgeCount++;
    }

    // 6) schema de qualificação do nicho + versão do kit + catálogo de templates
    await upsertNicheConfig(nicheId, {
      qualification: kit.qualificationSchema,
      kitVersion: kit.version,
      config: {
        templates: kit.templates,
        ...(kit.compliance ? { compliance: kit.compliance } : {}),
        motion: kit.niche.motion,
        vertical: kit.niche.vertical,
      },
    });

    this.logger.log(`Kit ${kit.niche.name}@${kit.version} aplicado: ${knowledgeCount} itens.`);
    return { nicheId, applied: true, version: kit.version, knowledgeCount };
  }

  /**
   * Materializa os templates do nicho no catálogo do TENANT ATIVO (status
   * 'pending' — a aprovação HSM na Meta é externa). Roda no contexto do tenant.
   */
  async materializeTemplatesForTenant(nicheId: string): Promise<{ count: number }> {
    const cfg = await getNicheConfig(nicheId);
    const templates = (cfg?.config?.templates ?? []) as Array<{
      name: string;
      languageCode: string;
      variables: string[];
      category: string;
    }>;
    for (const t of templates) {
      await upsertMessageTemplate({
        name: t.name,
        languageCode: t.languageCode,
        category: t.category,
        variables: t.variables,
        status: "pending", // aprovação na Meta é externa
      });
    }
    return { count: templates.length };
  }

  private async platformEmbed(text: string): Promise<number[]> {
    const provider = this.registry.embeddingFor({
      embeddingAdapter: "openai_compat",
      embeddingConfig: {
        baseURL: this.cfg.embeddings.baseURL,
        model: this.cfg.embeddings.defaultModel,
        timeoutMs: this.cfg.embeddings.timeoutMs,
        // mesma razão do EmbeddingService: OpenAI devolve 1536 sem 'dimensions'
        // e a coluna é vector(1024) — este é o caminho PLATAFORMA (kit apply)
        dimensions: this.cfg.embeddings.dim,
        ...(this.cfg.embeddings.apiKey ? { apiKey: this.cfg.embeddings.apiKey } : {}),
      },
    });
    const res = await provider.embed([text]);
    await recordPlatformUsage({
      type: "kit_embedding",
      tokensIn: res.usage.tokensIn,
      costMicros: embeddingCostMicros(this.cfg.embeddings.defaultModel, res.usage.tokensIn, DEFAULT_EMBEDDING_PRICING),
      metadata: { model: this.cfg.embeddings.defaultModel },
    });
    const v = res.vectors[0];
    if (!v) throw new Error("Embedding vazio no kit.");
    return v;
  }
}
