/**
 * PORT de EMBEDDINGS. O núcleo não sabe se por trás há um modelo aberto
 * auto-hospedado (vLLM/Ollama) ou um provedor por token — fala somente com esta
 * interface. Toda resposta carrega USO (tokens de entrada) para alimentar o
 * metering por tenant. Nenhum adaptador concreto neste módulo (M5 implementa).
 */

export interface EmbeddingUsage {
  /** Embeddings cobram só entrada (não há "saída" de tokens). */
  tokensIn: number;
}

export interface EmbeddingResult {
  /** Um vetor por texto de entrada, NA MESMA ORDEM. */
  vectors: number[][];
  usage: EmbeddingUsage;
}

export interface EmbeddingProvider {
  readonly id: string;
  /**
   * Gera embeddings para `texts`. DEVE devolver um vetor por texto, na ordem.
   * Lotes grandes são fatiados internamente pelo adaptador (transparente).
   */
  embed(texts: string[]): Promise<EmbeddingResult>;
}

/**
 * Erro de provedor de embeddings, agnóstico — espelha `LlmError` (M4).
 * `transient` decide retry/fallback. A `message` é categoria segura (sem detalhe
 * cru do fornecedor); o texto bruto fica em `detail` (não enumerável), só p/ log
 * redigido — nunca cruza a borda agnóstica.
 */
export class EmbeddingError extends Error {
  readonly detail?: string;
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status?: number,
    detail?: string,
  ) {
    super(message);
    this.name = "EmbeddingError";
    if (detail !== undefined) {
      Object.defineProperty(this, "detail", { value: detail, enumerable: false });
    }
  }

  static fromStatus(status: number | undefined, transient: boolean, detail?: string): EmbeddingError {
    return new EmbeddingError(embeddingErrorCategory(status), transient, status, detail);
  }
}

/** Categoria PÚBLICA e segura a partir do status HTTP (sem body/headers/chave). */
export function embeddingErrorCategory(status?: number): string {
  if (status === undefined) return "Embeddings: erro de rede";
  if (status === 401 || status === 403) return "Embeddings: falha de autenticação";
  if (status === 429) return "Embeddings: rate limit";
  if (status >= 500) return "Embeddings: erro do provedor";
  if (status === 400) return "Embeddings: requisição inválida";
  return `Embeddings: erro (HTTP ${status})`;
}
