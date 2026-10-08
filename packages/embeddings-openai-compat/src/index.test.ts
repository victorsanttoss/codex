import { describe, expect, it } from "vitest";
import { EmbeddingError } from "@sdr/core";
import { runEmbeddingProviderContract } from "../../core/src/ports/testing/embedding-provider.contract";
import { OpenAiCompatEmbeddingsProvider } from "./embeddings-adapter";
import type { EmbeddingsHttp } from "./http";

const noSleep = async () => {};

/** Mock que devolve um vetor [len, i] por input (dim 2), capturando as chamadas. */
function fakeHttp(
  handler: (body: Record<string, unknown>, call: number) => { status: number; json: unknown },
) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const http: EmbeddingsHttp = {
    async post(url, _headers, body) {
      calls.push({ url, body });
      return handler(body, calls.length);
    },
  };
  return { http, calls };
}

function okJson(inputs: string[], offset = 0) {
  return {
    status: 200,
    json: {
      data: inputs.map((t, i) => ({ index: i, embedding: [t.length, i + offset] })),
      usage: { prompt_tokens: inputs.reduce((s, t) => s + t.length, 0) },
    },
  };
}

function make(opts: Partial<ConstructorParameters<typeof OpenAiCompatEmbeddingsProvider>[0]> = {}, http?: EmbeddingsHttp) {
  return new OpenAiCompatEmbeddingsProvider({
    baseURL: "http://emb.local/v1",
    model: "bge-m3",
    sleep: noSleep,
    ...(http ? { http } : {}),
    ...opts,
  });
}

// 1) Contrato reutilizável.
runEmbeddingProviderContract("openai_compat", () =>
  make({}, fakeHttp((body) => okJson(body.input as string[])).http),
);

describe("OpenAiCompatEmbeddingsProvider", () => {
  it("mapeia vetores/uso; usa baseURL/model e Bearer", async () => {
    const { http, calls } = fakeHttp((body) => okJson(body.input as string[]));
    const provider = make({ apiKey: "sk-e" }, http);
    const res = await provider.embed(["abc", "de"]);
    expect(res.vectors).toEqual([
      [3, 0],
      [2, 1],
    ]);
    expect(res.usage.tokensIn).toBe(5);
    expect(calls[0]!.url).toBe("http://emb.local/v1/embeddings");
    expect(calls[0]!.body.model).toBe("bge-m3");
  });

  it("faz BATCHING: lote grande é fatiado por maxBatch e concatena na ordem", async () => {
    let off = 0;
    const { http, calls } = fakeHttp((body) => {
      const r = okJson(body.input as string[], off);
      off += 100;
      return r;
    });
    const provider = make({ maxBatch: 2 }, http);
    const res = await provider.embed(["a", "bb", "ccc", "dddd", "e"]);
    expect(calls.length).toBe(3); // 2 + 2 + 1
    expect(res.vectors.length).toBe(5);
    expect(res.vectors[0]).toEqual([1, 0]); // primeiro do 1º lote
    expect(res.vectors[2]).toEqual([3, 100]); // primeiro do 2º lote (offset 100)
    expect(res.vectors[4]).toEqual([1, 200]); // único do 3º lote
  });

  it("reordena por index quando a API devolve fora de ordem", async () => {
    const { http } = fakeHttp(() => ({
      status: 200,
      json: { data: [{ index: 1, embedding: [9, 9] }, { index: 0, embedding: [1, 1] }], usage: {} },
    }));
    const res = await make({}, http).embed(["x", "y"]);
    expect(res.vectors).toEqual([
      [1, 1],
      [9, 9],
    ]);
  });

  it("rejeita 'index' duplicado/fora de faixa (não troca vetor silenciosamente)", async () => {
    const { http } = fakeHttp(() => ({
      status: 200,
      json: { data: [{ index: 0, embedding: [1, 1] }, { index: 0, embedding: [2, 2] }], usage: {} },
    }));
    await expect(make({}, http).embed(["a", "b"])).rejects.toMatchObject({
      name: "EmbeddingError",
      transient: false,
    });
  });

  it("rejeita contagem de itens diferente do esperado", async () => {
    const { http } = fakeHttp(() => ({
      status: 200,
      json: { data: [{ index: 0, embedding: [1, 1] }], usage: {} },
    }));
    await expect(make({}, http).embed(["a", "b"])).rejects.toMatchObject({ name: "EmbeddingError" });
  });

  it("embed([]) não chama o provedor", async () => {
    const { http, calls } = fakeHttp((body) => okJson(body.input as string[]));
    const res = await make({}, http).embed([]);
    expect(res.vectors).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("erro permanente (401) vira EmbeddingError tipado, sem retry", async () => {
    let n = 0;
    const { http } = fakeHttp(() => {
      n++;
      return { status: 401, json: { error: { message: "bad key" } } };
    });
    await expect(make({ maxAttempts: 3 }, http).embed(["x"])).rejects.toMatchObject({
      name: "EmbeddingError",
      transient: false,
      status: 401,
    });
    expect(n).toBe(1); // permanente não repete
    expect(EmbeddingError).toBeDefined();
  });

  it("erro transiente (503) faz retry e depois sucede", async () => {
    let n = 0;
    const { http } = fakeHttp((body) => {
      n++;
      if (n === 1) return { status: 503, json: {} };
      return okJson(body.input as string[]);
    });
    const res = await make({ maxAttempts: 3 }, http).embed(["ok"]);
    expect(n).toBe(2);
    expect(res.vectors.length).toBe(1);
  });
});
