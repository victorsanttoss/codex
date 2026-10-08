import { describe, expect, it } from "vitest";
import { LlmError, type CompletionRequest, type CompletionResult, type LLMProvider } from "@sdr/core";
import { LlmRouter, type UsageInfo } from "./router";
import { DEFAULT_EMBEDDING_PRICING, embeddingCostMicros } from "./embeddings-pricing";
import { DEFAULT_TRANSCRIPTION_PRICING, transcriptionCostMicros } from "./transcription-pricing";

const noSleep = async () => {};

function provider(id: string, behavior: () => CompletionResult): LLMProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    async complete(_req: CompletionRequest): Promise<CompletionResult> {
      p.calls++;
      return behavior();
    },
    async *stream() {
      yield { type: "done" as const, usage: { tokensIn: 0, tokensOut: 0 }, finishReason: "stop" as const };
    },
  };
  return p;
}

const okResult = (): CompletionResult => ({
  content: "ok",
  toolCalls: [],
  usage: { tokensIn: 1000, tokensOut: 500 },
  finishReason: "stop",
});
const throwTransient = (): CompletionResult => {
  throw new LlmError("rede", true);
};
const throwPermanent = (): CompletionResult => {
  throw new LlmError("auth", false, 401);
};

describe("LlmRouter", () => {
  it("escolhe o modelo mais barato adequado e grava metering com costMicros", async () => {
    const a = provider("anthropic", okResult);
    const usages: UsageInfo[] = [];
    const router = new LlmRouter(
      [
        { provider: a, model: "claude-opus-4-8" }, // caro (score 30)
        { provider: a, model: "claude-haiku-4-5" }, // barato (score 6) -> escolhido
      ],
      { sleep: noSleep, onUsage: (u) => void usages.push(u) },
    );
    const out = await router.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(out.model).toBe("claude-haiku-4-5");
    expect(out.costMicros).toBe(1000 * 1 + 500 * 5); // 3500 micros = $0.0035
    expect(usages[0]).toMatchObject({ model: "claude-haiku-4-5", costMicros: 3500 });
  });

  it("fallback em erro TRANSIENTE: retry no mesmo e depois próximo provedor", async () => {
    const cheap = provider("cheap", throwTransient); // sempre falha (transiente)
    const fallback = provider("fallback", okResult);
    const usages: UsageInfo[] = [];
    const router = new LlmRouter(
      [
        { provider: cheap, model: "claude-haiku-4-5" },
        { provider: fallback, model: "claude-opus-4-8" },
      ],
      { sleep: noSleep, jitter: () => 0, onUsage: (u) => void usages.push(u) },
    );
    const out = await router.complete({ messages: [{ role: "user", content: "x" }] });
    expect(out.providerId).toBe("fallback");
    expect(cheap.calls).toBe(2); // retry (maxAttempts default 2) no mesmo antes de cair
    expect(usages[0]!.providerId).toBe("fallback"); // metering do que respondeu
  });

  it("fallback em erro PERMANENTE: sem retry-storm, vai direto ao próximo", async () => {
    const cheap = provider("cheap", throwPermanent);
    const fallback = provider("fallback", okResult);
    const router = new LlmRouter(
      [
        { provider: cheap, model: "claude-haiku-4-5" },
        { provider: fallback, model: "claude-opus-4-8" },
      ],
      { sleep: noSleep },
    );
    const out = await router.complete({ messages: [{ role: "user", content: "x" }] });
    expect(out.providerId).toBe("fallback");
    expect(cheap.calls).toBe(1); // permanente NÃO faz retry
  });

  it("todos falham -> LlmError", async () => {
    const a = provider("a", throwPermanent);
    const b = provider("b", throwTransient);
    const router = new LlmRouter(
      [
        { provider: a, model: "claude-haiku-4-5" },
        { provider: b, model: "claude-opus-4-8" },
      ],
      { sleep: noSleep, jitter: () => 0 },
    );
    await expect(router.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(LlmError);
  });

  it("FAIL-CLOSED: rejeita candidato com modelo sem preço no catálogo", () => {
    const a = provider("a", okResult);
    expect(() => new LlmRouter([{ provider: a, model: "llama-self-hosted" }])).toThrow(/sem preço/i);
    // mas com preço explícito {0,0} (grátis/self-hosted) é aceito:
    expect(
      () =>
        new LlmRouter([{ provider: a, model: "llama-self-hosted" }], {
          pricing: { "llama-self-hosted": { input: 0, output: 0 } },
        }),
    ).not.toThrow();
  });

  it("preço de embeddings: custa só entrada; FAIL-CLOSED p/ modelo sem preço", () => {
    // text-embedding-3-small = $0.02/1M -> 1.000.000 tokens = 20.000 micros ($0.02)
    expect(embeddingCostMicros("text-embedding-3-small", 1_000_000, DEFAULT_EMBEDDING_PRICING)).toBe(20_000);
    // self-hosted explícito {input:0} -> grátis legítimo
    expect(embeddingCostMicros("bge-m3", 5_000, DEFAULT_EMBEDDING_PRICING)).toBe(0);
    // sem preço cadastrado -> lança (não cobra 0 silencioso)
    expect(() => embeddingCostMicros("modelo-desconhecido", 100, DEFAULT_EMBEDDING_PRICING)).toThrow(/sem preço/i);
  });

  it("preço de transcrição: custa por minuto; FAIL-CLOSED p/ modelo sem preço", () => {
    // whisper-1 = $0.006/min -> 60s = 6.000 micros ($0.006)
    expect(transcriptionCostMicros("whisper-1", 60, DEFAULT_TRANSCRIPTION_PRICING)).toBe(6_000);
    // 30s = metade
    expect(transcriptionCostMicros("whisper-1", 30, DEFAULT_TRANSCRIPTION_PRICING)).toBe(3_000);
    // self-hosted explícito { perMinute: 0 } -> grátis legítimo
    expect(transcriptionCostMicros("whisper-selfhosted", 120, DEFAULT_TRANSCRIPTION_PRICING)).toBe(0);
    // sem preço cadastrado -> lança (não cobra 0 silencioso)
    expect(() => transcriptionCostMicros("modelo-desconhecido", 60, DEFAULT_TRANSCRIPTION_PRICING)).toThrow(/sem preço/i);
  });

  it("credencial inválida (401): não tenta outros modelos do MESMO provider, mas cai p/ outro", async () => {
    const sameKey = provider("anthropic", throwPermanent); // 401 — mesma chave
    const other = provider("openai_compat", okResult);
    const router = new LlmRouter(
      [
        { provider: sameKey, model: "claude-haiku-4-5" },
        { provider: sameKey, model: "claude-opus-4-8" }, // deve ser PULADO (mesma cred morta)
        { provider: other, model: "claude-sonnet-4-6" },
      ],
      { sleep: noSleep },
    );
    const out = await router.complete({ messages: [{ role: "user", content: "x" }] });
    expect(out.providerId).toBe("openai_compat");
    expect(sameKey.calls).toBe(1); // 401 numa vez só; não repetiu com a mesma chave
  });
});
