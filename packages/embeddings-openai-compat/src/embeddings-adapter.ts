import {
  EmbeddingError,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "@sdr/core";
import { makeFetchEmbeddingsHttp, type EmbeddingsHttp } from "./http";

export const OPENAI_COMPAT_EMBEDDINGS_KEY = "openai_compat";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OpenAiCompatEmbeddingsConfig {
  /** baseURL do endpoint compatível (self-hosted vLLM/Ollama OU provedor por token). */
  baseURL: string;
  /** Modelo de embeddings (ex.: bge-m3, multilingual-e5, text-embedding-3-small). */
  model: string;
  apiKey?: string;
  http?: EmbeddingsHttp;
  /** Timeout de rede por requisição (default 15s) — usado quando `http` não é injetado. */
  timeoutMs?: number;
  /** id do provedor (default openai_compat). */
  id?: string;
  /** Teto de textos por requisição — lotes maiores são fatiados. */
  maxBatch?: number;
  /**
   * Dimensão do vetor pedida ao provedor (OpenAI text-embedding-3-* aceita
   * reduzir; ex.: 1024 p/ casar com a coluna vector(1024)). Provedores que não
   * suportam o campo o ignoram (Ollama/vLLM); modelos de dimensão fixa (bge-m3
   * = 1024) já casam por natureza.
   */
  dimensions?: number;
  /** Tentativas em erro transiente (rede/429/5xx). */
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Adaptador de embeddings para qualquer API compatível com OpenAI `/embeddings`.
 * O `baseURL` configurável cobre modelo aberto auto-hospedado (vLLM/Ollama) e
 * provedores por token. Faz **batching** (lote grande é fatiado), retry/backoff
 * em transiente, e devolve um vetor por texto NA ORDEM. Cliente HTTP injetável.
 */
export class OpenAiCompatEmbeddingsProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly base: string;
  private readonly http: EmbeddingsHttp;
  private readonly maxBatch: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: OpenAiCompatEmbeddingsConfig) {
    if (!config.model) throw new Error("OpenAiCompatEmbeddingsProvider: 'model' é obrigatório.");
    this.id = config.id ?? OPENAI_COMPAT_EMBEDDINGS_KEY;
    this.base = config.baseURL.replace(/\/$/, "");
    this.http = config.http ?? makeFetchEmbeddingsHttp(config.timeoutMs);
    this.maxBatch = Math.max(1, config.maxBatch ?? 96);
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 3);
    this.baseDelayMs = Math.max(0, config.baseDelayMs ?? 200);
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) return { vectors: [], usage: { tokensIn: 0 } };
    const vectors: number[][] = [];
    let tokensIn = 0;
    for (let i = 0; i < texts.length; i += this.maxBatch) {
      const batch = texts.slice(i, i + this.maxBatch);
      const { vectors: vs, tokensIn: t } = await this.embedBatch(batch);
      vectors.push(...vs);
      tokensIn += t;
    }
    return { vectors, usage: { tokensIn } };
  }

  private async embedBatch(batch: string[]): Promise<{ vectors: number[][]; tokensIn: number }> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const res = await this.http.post(this.url(), this.headers(), {
          model: this.config.model,
          input: batch,
          ...(this.config.dimensions ? { dimensions: this.config.dimensions } : {}),
        });
        if (res.status < 200 || res.status >= 300) throw mapHttpError(res.status, res.json);
        return parseResponse(res.json, batch.length);
      } catch (err) {
        const e = toEmbeddingError(err);
        if (!e.transient || attempt >= this.maxAttempts) throw e;
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  private url(): string {
    return `${this.base}/embeddings`;
  }
  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }
}

function parseResponse(json: unknown, expected: number): { vectors: number[][]; tokensIn: number } {
  const j = json as any;
  const data = j?.data;
  if (!Array.isArray(data)) {
    throw new EmbeddingError("Embeddings: resposta sem 'data'", false, 502);
  }
  if (data.length !== expected) {
    throw new EmbeddingError(
      `Embeddings: esperados ${expected} itens, recebidos ${data.length}`,
      false,
      502,
    );
  }
  // a API pode devolver fora de ordem — reordena por `index`. Exige o conjunto
  // EXATO {0..n-1} (sem duplicado/faltando) p/ não trocar vetor de texto
  // silenciosamente; se nenhum item traz `index`, mantém a ordem original.
  const hasIndex = data.some((d) => typeof d?.index === "number");
  let ordered = data;
  if (hasIndex) {
    const seen = new Set<number>();
    for (const d of data) {
      const idx = d?.index;
      if (typeof idx !== "number" || idx < 0 || idx >= expected || seen.has(idx)) {
        throw new EmbeddingError("Embeddings: 'index' inválido/duplicado na resposta", false, 502);
      }
      seen.add(idx);
    }
    ordered = [...data].sort((a, b) => a.index - b.index);
  }
  const vectors = ordered.map((d) => {
    const emb = d?.embedding;
    if (!Array.isArray(emb) || !emb.every((x: unknown) => typeof x === "number" && Number.isFinite(x))) {
      throw new EmbeddingError("Embeddings: vetor inválido na resposta", false, 502);
    }
    return emb as number[];
  });
  if (vectors.length !== expected) {
    throw new EmbeddingError(
      `Embeddings: esperados ${expected} vetores, recebidos ${vectors.length}`,
      false,
      502,
    );
  }
  const tokensIn = Number(j?.usage?.prompt_tokens ?? j?.usage?.total_tokens ?? 0);
  return { vectors, tokensIn: Number.isFinite(tokensIn) ? tokensIn : 0 };
}

function mapHttpError(status: number, body: unknown): EmbeddingError {
  const detail = (body as { error?: { message?: string } } | null)?.error?.message;
  return EmbeddingError.fromStatus(status, status === 429 || status >= 500, detail);
}

function toEmbeddingError(err: unknown): EmbeddingError {
  if (err instanceof EmbeddingError) return err;
  const status = (err as { status?: number } | undefined)?.status;
  const transient = status === undefined || status === 429 || status >= 500;
  return EmbeddingError.fromStatus(status, transient, err instanceof Error ? err.message : undefined);
}
