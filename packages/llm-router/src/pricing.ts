import type { TokenUsage } from "@sdr/core";

/** Preço por modelo em USD por 1M de tokens (input/output). Dado de PLATAFORMA. */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * Catálogo de preços (seed). É dado de plataforma, NÃO tenant-scoped — fica em
 * código/config, atualizável; nunca vira tabela com RLS de tenant.
 * Valores conferidos na doc oficial (skill claude-api) — revisar periodicamente.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // OpenAI (via branch openai-compat) — preços públicos da OpenAI; revisar
  // periodicamente como os demais. Residual consciente: cached input tokens
  // não são descontados (superestima = conservador p/ o teto de custo).
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  // Geração 5.4 (2026) — preços públicos em 2026-07; snapshot datado idem.
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-mini-2026-03-17": { input: 0.75, output: 4.5 },
};

export type Pricing = Record<string, ModelPrice>;

/** Há preço cadastrado para o modelo? Modelo aberto/grátis usa entrada `{0,0}`. */
export function hasPrice(model: string, pricing: Pricing): boolean {
  return pricing[model] !== undefined;
}

/** Score de custo do modelo (input+output por 1M) — menor = mais barato. */
export function priceScore(model: string, pricing: Pricing): number {
  const p = pricing[model];
  return p ? p.input + p.output : Number.POSITIVE_INFINITY; // modelo sem preço = mais caro (último)
}

/**
 * Custo em MICROS (millionésimos de USD). Como o preço é USD por 1M tokens,
 * costMicros = tokensIn*inputPerM + tokensOut*outputPerM (a multiplicação por
 * 1e6 dos micros cancela o /1e6 do "por milhão").
 *
 * FAIL-CLOSED: modelo sem preço cadastrado LANÇA — custo 0 silencioso vira
 * subcobrança. Modelo aberto/self-hosted deve entrar no catálogo com `{0,0}`
 * explícito (grátis intencional), nunca por omissão.
 */
export function costMicros(model: string, usage: TokenUsage, pricing: Pricing): number {
  const p = pricing[model];
  if (!p) {
    throw new Error(
      `Sem preço cadastrado para o modelo "${model}". Adicione ao catálogo (use {input:0,output:0} para grátis/self-hosted).`,
    );
  }
  return Math.round(usage.tokensIn * p.input + usage.tokensOut * p.output);
}
