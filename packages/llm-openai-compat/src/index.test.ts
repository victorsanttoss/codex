import { describe, expect, it } from "vitest";
import { LlmError } from "@sdr/core";
import { runLLMProviderContract } from "../../core/src/ports/testing/llm-provider.contract";
import { OpenAiCompatProvider } from "./openai-adapter";
import type { OpenAiHttp } from "./http";

const OK_COMPLETE = {
  status: 200,
  json: {
    choices: [{ message: { content: "olá" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  },
};
const OK_STREAM = [
  JSON.stringify({ choices: [{ delta: { content: "olá " } }] }),
  JSON.stringify({
    choices: [{ delta: { content: "mundo" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }),
];

function fakeHttp(opts: { complete?: { status: number; json: unknown }; streamData?: string[] }) {
  const captured: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
  const http: OpenAiHttp = {
    async complete(url, headers, body) {
      captured.url = url;
      captured.headers = headers;
      captured.body = body;
      return opts.complete ?? OK_COMPLETE;
    },
    async *stream(url, headers, body) {
      captured.url = url;
      captured.body = body;
      for (const d of opts.streamData ?? OK_STREAM) yield d;
    },
  };
  return { http, captured };
}

function make(opts: Parameters<typeof fakeHttp>[0] = {}, extra: Record<string, unknown> = {}) {
  const { http, captured } = fakeHttp(opts);
  const provider = new OpenAiCompatProvider({ baseURL: "http://llm.local/v1", http, ...extra });
  return { provider, captured };
}

// 1) Contrato reutilizável.
runLLMProviderContract("openai_compat", () => make().provider);

describe("OpenAiCompatProvider", () => {
  it("mapeia conteúdo e usage; usa baseURL e Bearer", async () => {
    const { provider, captured } = make({}, { apiKey: "sk-x" });
    const res = await provider.complete({ model: "gpt-x", messages: [{ role: "user", content: "oi" }] });
    expect(res.content).toBe("olá");
    expect(res.usage).toEqual({ tokensIn: 5, tokensOut: 2 });
    expect(captured.url).toBe("http://llm.local/v1/chat/completions");
    expect(captured.headers!.authorization).toBe("Bearer sk-x");
  });

  it("família reasoning (gpt-5*/o*) usa max_completion_tokens e omite temperature", async () => {
    const { provider, captured } = make();
    await provider.complete({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "oi" }],
      maxTokens: 500,
      temperature: 0.3,
    });
    expect(captured.body!.max_completion_tokens).toBe(500);
    expect(captured.body!.max_tokens).toBeUndefined();
    expect(captured.body!.temperature).toBeUndefined();
  });

  it("modelo clássico (gpt-4o/self-hosted) segue com max_tokens e temperature", async () => {
    const { provider, captured } = make();
    await provider.complete({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "oi" }],
      maxTokens: 500,
      temperature: 0.3,
    });
    expect(captured.body!.max_tokens).toBe(500);
    expect(captured.body!.max_completion_tokens).toBeUndefined();
    expect(captured.body!.temperature).toBe(0.3);
  });

  it("tool-calling: normaliza tool_calls + finishReason", async () => {
    const { provider } = make({
      complete: {
        status: 200,
        json: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"SP"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 3 },
        },
      },
    });
    const res = await provider.complete({
      model: "m",
      messages: [{ role: "user", content: "clima?" }],
      tools: [{ name: "get_weather", description: "x", parameters: { type: "object" } }],
    });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls).toEqual([{ id: "c1", name: "get_weather", arguments: { city: "SP" } }]);
  });

  it("erro permanente (401) e transiente (503) viram LlmError tipado", async () => {
    const perm = make({ complete: { status: 401, json: { error: { message: "bad key" } } } });
    await expect(perm.provider.complete({ model: "m", messages: [{ role: "user", content: "x" }] }))
      .rejects.toMatchObject({ name: "LlmError", transient: false, status: 401 });

    const trans = make({ complete: { status: 503, json: {} } });
    await expect(trans.provider.complete({ model: "m", messages: [{ role: "user", content: "x" }] }))
      .rejects.toMatchObject({ name: "LlmError", transient: true, status: 503 });
    expect(LlmError).toBeDefined();
  });

  it("args de tool inválidos NÃO viram {} silencioso — lança LlmError permanente", async () => {
    const { provider } = make({
      complete: {
        status: 200,
        json: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: "c1", function: { name: "f", arguments: "{not-json" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      },
    });
    await expect(
      provider.complete({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "f", description: "x", parameters: { type: "object" } }],
      }),
    ).rejects.toMatchObject({ name: "LlmError", transient: false });
  });

  it("stream emite deltas e termina com done+usage", async () => {
    const chunks = [];
    for await (const c of make().provider.stream({ model: "m", messages: [{ role: "user", content: "s" }] })) {
      chunks.push(c);
    }
    expect(chunks.filter((c) => c.type === "delta").length).toBe(2);
    expect(chunks.at(-1)).toMatchObject({ type: "done", usage: { tokensIn: 5, tokensOut: 2 } });
  });
});
