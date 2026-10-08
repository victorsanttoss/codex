import { ProviderRegistry } from "@sdr/core";
import {
  OpenAiCompatEmbeddingsProvider,
  type OpenAiCompatEmbeddingsConfig,
} from "@sdr/embeddings-openai-compat";

/** Token DI do registro de provedores de EMBEDDINGS (composition root). */
export const EMBEDDING_REGISTRY = "EMBEDDING_REGISTRY";

/** Registra os adaptadores concretos de embeddings no ProviderRegistry agnóstico. */
export const embeddingRegistryProvider = {
  provide: EMBEDDING_REGISTRY,
  useFactory: (): ProviderRegistry => {
    const registry = new ProviderRegistry();
    registry.registerEmbedding(
      "openai_compat",
      (cfg) => new OpenAiCompatEmbeddingsProvider(cfg as unknown as OpenAiCompatEmbeddingsConfig),
    );
    return registry;
  },
};
