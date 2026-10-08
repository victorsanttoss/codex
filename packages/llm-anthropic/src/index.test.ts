import { describe, expect, it } from "vitest";
import { runLLMProviderContract } from "../../core/src/ports/testing/llm-provider.contract";
import { AnthropicLLMProvider, type AnthropicLike } from "./anthropic-adapter";

interface FakeMsg {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

const TEXT_MSG: FakeMsg = {
  content: [{ type: "text", text: "olá" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 2 },
};

/** Fake do cliente Anthropic; captura os params da última chamada. */
function fakeClient(respond: (p: Record<string, unknown>) => FakeMsg) {
  const captured: { params?: Record<string, unknown> } = {};
  const client: AnthropicLike = {
    messages: {
      async create(params) {
        captured.params = params;
        return respond(params);
      },
      stream(params) {
        captured.params = params;
        const events = [
          { type: "content_block_delta", delta: { type: "text_delta", text: "olá " } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "mundo" } },
        ];
        const final = respond(params);
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
          async finalMessage() {
            return final;
          },
        };
      },
    },
  };
  return { client, captured };
}

// 1) Contrato reutilizável.
runLLMProviderContract("anthropic", () => new AnthropicLLMProvider({ client: fakeClient(() => TEXT_MSG).client }));

describe("AnthropicLLMProvider", () => {
  it("mapeia conteúdo e usage corretamente", async () => {
    const res = await new AnthropicLLMProvider({ client: fakeClient(() => TEXT_MSG).client }).complete({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "oi" }],
    });
    expect(res.content).toBe("olá");
    expect(res.usage).toEqual({ tokensIn: 5, tokensOut: 2 });
    expect(res.finishReason).toBe("stop");
  });

  it("tool-calling: normaliza tool_use e finishReason 'tool_calls'", async () => {
    const toolMsg: FakeMsg = {
      content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "SP" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 4 },
    };
    const res = await new AnthropicLLMProvider({ client: fakeClient(() => toolMsg).client }).complete({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "clima em SP?" }],
      tools: [{ name: "get_weather", description: "clima", parameters: { type: "object" } }],
    });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls).toEqual([{ id: "tu_1", name: "get_weather", arguments: { city: "SP" } }]);
  });

  it("round-trip: reenvia tool_use do assistant + tool_result", async () => {
    const { client, captured } = fakeClient(() => TEXT_MSG);
    await new AnthropicLLMProvider({ client }).complete({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "clima?" },
        { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "get_weather", arguments: { city: "SP" } }] },
        { role: "tool", toolCallId: "tu_1", content: "ensolarado" },
      ],
    });
    const msgs = captured.params!.messages as Array<{ role: string; content: any[] }>;
    expect(msgs[1]!.content[0]).toMatchObject({ type: "tool_use", id: "tu_1", name: "get_weather" });
    expect(msgs[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
  });

  it("NÃO envia temperature em Opus 4.8 (400), mas envia em Sonnet 4.6", async () => {
    const a = fakeClient(() => TEXT_MSG);
    await new AnthropicLLMProvider({ client: a.client }).complete({
      model: "claude-opus-4-8",
      temperature: 0.7,
      messages: [{ role: "user", content: "x" }],
    });
    expect(a.captured.params!.temperature).toBeUndefined();

    const b = fakeClient(() => TEXT_MSG);
    await new AnthropicLLMProvider({ client: b.client }).complete({
      model: "claude-sonnet-4-6",
      temperature: 0.7,
      messages: [{ role: "user", content: "x" }],
    });
    expect(b.captured.params!.temperature).toBe(0.7);
  });

  it("finishReason 'length' em max_tokens; system extraído", async () => {
    const { client, captured } = fakeClient(() => ({ ...TEXT_MSG, stop_reason: "max_tokens" }));
    const res = await new AnthropicLLMProvider({ client }).complete({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "Você é um SDR." },
        { role: "user", content: "oi" },
      ],
    });
    expect(res.finishReason).toBe("length");
    expect(captured.params!.system).toBe("Você é um SDR.");
  });

  it("stream emite deltas e termina com done+usage", async () => {
    const chunks = [];
    for await (const c of new AnthropicLLMProvider({ client: fakeClient(() => TEXT_MSG).client }).stream({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "stream" }],
    })) {
      chunks.push(c);
    }
    expect(chunks.filter((c) => c.type === "delta").length).toBe(2);
    expect(chunks.at(-1)).toMatchObject({ type: "done", usage: { tokensIn: 5, tokensOut: 2 } });
  });
});

describe("AnthropicLLMProvider — timeout do SDK", () => {
  it("client default nasce com timeout de 60s (socket pendurado não trava o turno)", () => {
    const provider = new AnthropicLLMProvider({ apiKey: "test-key" });
    // acessa o client interno só p/ verificar a config do SDK (sem rede).
    expect((provider as unknown as { client: { timeout: number } }).client.timeout).toBe(60_000);
  });

  it("timeoutMs da config é repassado ao SDK", () => {
    const provider = new AnthropicLLMProvider({ apiKey: "test-key", timeoutMs: 5_000 });
    expect((provider as unknown as { client: { timeout: number } }).client.timeout).toBe(5_000);
  });
});
