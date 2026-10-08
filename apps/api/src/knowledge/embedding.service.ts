import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { ProviderRegistry, requireTenantContext, type EmbeddingProvider } from "@sdr/core";
import { KNOWLEDGE_VECTOR_DIM, makeCipherFromEnv, recordUsage, TenantSecretsStore } from "@sdr/db";
import { DEFAULT_EMBEDDING_PRICING, embeddingCostMicros } from "@sdr/llm-router";
import { APP_CONFIG } from "../config/config.module";
import { EMBEDDING_REGISTRY } from "./embeddings.registry";

export interface EmbedOutcome {
  vectors: number[][];
  model: string;
}

/** Origem do embedding (p/ análise de custo no metering). */
export type EmbedPurpose = "ingest" | "retrieval";

/**
 * Serviço de embeddings por tenant. Resolve a chave (tenant: embedding_api_key
 * → llm_api_key; senão plataforma; self-hosted pode não ter), monta o adaptador
 * e grava metering (type 'embedding', fail-closed de preço). A dimensão é
 * validada contra cfg.embeddings.dim (que casa com a coluna vector(N)).
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  constructor(
    @Inject(EMBEDDING_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    // Fail-fast: a dimensão configurada DEVE casar com a coluna vector(N). Sem
    // isto, pagaríamos o embedding e só falharíamos no insert/retrieval.
    if (cfg.embeddings.dim !== KNOWLEDGE_VECTOR_DIM) {
      throw new Error(
        `EMBEDDINGS_DIM=${cfg.embeddings.dim} ≠ coluna vector(${KNOWLEDGE_VECTOR_DIM}). Alinhe a config (ou faça migração de dimensão).`,
      );
    }
  }

  get model(): string {
    return this.cfg.embeddings.defaultModel;
  }

  private async providerForTenant(purpose: EmbedPurpose): Promise<EmbeddingProvider> {
    requireTenantContext();
    const store = new TenantSecretsStore(makeCipherFromEnv());
    // self-hosted pode não ter chave — apiKey é opcional (adapter omite Bearer).
    const apiKey =
      (await store.get("embedding_api_key")) ??
      (await store.get("llm_api_key")) ??
      this.cfg.embeddings.apiKey;
    return this.registry.embeddingFor({
      embeddingAdapter: "openai_compat",
      embeddingConfig: {
        baseURL: this.cfg.embeddings.baseURL,
        model: this.cfg.embeddings.defaultModel,
        maxBatch: this.cfg.embeddings.maxBatch,
        // pede a dimensão da coluna ao provedor (OpenAI text-embedding-3-*
        // reduz p/ 1024; quem não suporta o campo ignora) — sem isto a OpenAI
        // devolve 1536 e a ingestão falha contra vector(1024)
        dimensions: this.cfg.embeddings.dim,
        // retrieval roda no caminho quente da conversa — timeout próprio, curto;
        // a folga (EMBEDDINGS_TIMEOUT_MS) vale só para a ingestão em fila.
        timeoutMs:
          purpose === "retrieval"
            ? this.cfg.embeddings.retrievalTimeoutMs
            : this.cfg.embeddings.timeoutMs,
        ...(apiKey ? { apiKey } : {}),
      },
    });
  }

  /** Gera embeddings p/ `texts` no contexto do tenant, validando dimensão e medindo custo. */
  async embed(texts: string[], purpose: EmbedPurpose = "ingest"): Promise<EmbedOutcome> {
    if (texts.length === 0) return { vectors: [], model: this.model };
    const provider = await this.providerForTenant(purpose);
    const res = await provider.embed(texts);
    const dim = this.cfg.embeddings.dim;
    for (const v of res.vectors) {
      if (v.length !== dim) {
        throw new Error(`Embedding com dimensão ${v.length} ≠ ${dim} (modelo ${this.model}).`);
      }
    }
    const cost = embeddingCostMicros(this.model, res.usage.tokensIn, DEFAULT_EMBEDDING_PRICING);
    // Metering best-effort FORA do caminho crítico (fire-and-forget com log).
    void recordUsage({
      type: "embedding",
      model: this.model,
      tokensIn: res.usage.tokensIn,
      costMicros: cost,
      metadata: { provider: provider.id, purpose },
    }).catch((err) =>
      this.logger.warn(`recordUsage(embedding) falhou: ${err instanceof Error ? err.message : err}`),
    );
    return { vectors: res.vectors, model: this.model };
  }
}
