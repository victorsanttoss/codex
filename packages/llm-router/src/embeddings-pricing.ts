/**
 * Catálogo de preços de EMBEDDINGS (plataforma). Embeddings cobram só ENTRADA
 * (USD por 1M tokens). Dado de plataforma, NÃO tenant-scoped — fica em
 * código/config, atualizável; nunca vira tabela com RLS de tenant.
 *
 * Modelo aberto/self-hosted entra com `{input:0}` EXPLÍCITO (grátis intencional).
 * Valores conferir periodicamente na doc do provedor.
 */
export interface EmbeddingPrice {
  /** USD por 1M tokens de entrada. */
  input: number;
}

export const DEFAULT_EMBEDDING_PRICING: Record<string, EmbeddingPrice> = {
  // self-hosted (vLLM/Ollama) — grátis intencional (custa infra, não por-token)
  "bge-m3": { input: 0 },
  "multilingual-e5-large": { input: 0 },
  "nomic-embed-text": { input: 0 },
  // provedores por token
  "text-embedding-3-small": { input: 0.02 },
  "text-embedding-3-large": { input: 0.13 },
};

export type EmbeddingPricing = Record<string, EmbeddingPrice>;

/** Há preço cadastrado para o modelo de embeddings? */
export function hasEmbeddingPrice(model: string, pricing: EmbeddingPricing): boolean {
  return pricing[model] !== undefined;
}

/**
 * Custo em MICROS (millionésimos de USD). FAIL-CLOSED: modelo sem preço LANÇA
 * (custo 0 silencioso vira subcobrança). Self-hosted/grátis deve entrar no
 * catálogo com `{input:0}` explícito.
 */
export function embeddingCostMicros(
  model: string,
  tokensIn: number,
  pricing: EmbeddingPricing,
): number {
  const p = pricing[model];
  if (!p) {
    throw new Error(
      `Sem preço cadastrado para o modelo de embeddings "${model}". Adicione ao catálogo (use {input:0} para grátis/self-hosted).`,
    );
  }
  return Math.round(tokensIn * p.input);
}
