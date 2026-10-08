/** HTTP injetável para o endpoint /embeddings (testes mockam; prod usa fetch). */
export interface EmbeddingsHttp {
  post(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }>;
}

/** Timeout default (15s): embeddings são rápidos; pendurar aqui trava a ingestão. */
export const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 15_000;

/**
 * Fábrica do cliente fetch com TIMEOUT (AbortSignal). Timeout vira Error SEM
 * status — o adaptador o classifica como EmbeddingError transiente (retry).
 */
export function makeFetchEmbeddingsHttp(
  timeoutMs: number = DEFAULT_EMBEDDINGS_TIMEOUT_MS,
): EmbeddingsHttp {
  return {
    async post(url, headers, body) {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err) => {
        const name = (err as { name?: string } | null)?.name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new Error(`Embeddings: timeout de rede após ${timeoutMs}ms`);
        }
        throw err;
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
  };
}

export const fetchEmbeddingsHttp: EmbeddingsHttp = makeFetchEmbeddingsHttp();
