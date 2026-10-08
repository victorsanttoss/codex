import { describe, expect, it } from "vitest";
import type { ToolCall } from "@sdr/core";
import { AgentService } from "./agent.service";
import type { LlmService } from "../llm/llm.service";
import type { AgentTool, AgentToolContext } from "./tools";

function outcome(content: string, toolCalls: ToolCall[] = [], costMicros = 10) {
  return { content, toolCalls, usage: { tokensIn: 1, tokensOut: 1 }, finishReason: "stop" as const, providerId: "fake", model: "m", costMicros };
}

/** LlmService fake que devolve respostas roteirizadas por chamada. */
function fakeLlm(script: Array<ReturnType<typeof outcome>>): LlmService {
  let i = 0;
  return {
    async complete() {
      const r = script[Math.min(i, script.length - 1)]!;
      i++;
      return r;
    },
  } as unknown as LlmService;
}

const noopTool: AgentTool = {
  definition: { name: "noop", description: "x", parameters: { type: "object", properties: {} } },
  async execute() {
    return "ok";
  },
};

const toolCtx = {} as AgentToolContext;
const guardrails = { maxToolIterations: 3, maxCostMicrosPerTurn: 50_000 };

describe("AgentService (loop + guardrails)", () => {
  it("round-trip: executa tool e finaliza com texto", async () => {
    const svc = new AgentService(
      fakeLlm([
        outcome("", [{ id: "c1", name: "noop", arguments: {} }]),
        outcome("Pronto!"),
      ]),
    );
    const res = await svc.run({ systemPrompt: "s", conversation: [{ role: "user", content: "oi" }], tools: [noopTool], toolCtx, guardrails });
    expect(res.text).toBe("Pronto!");
    expect(res.stopReason).toBe("completed");
  });

  it("GUARDRAIL teto de tools: LLM sempre pede tool → encerra com close (tool_cap), sem loop infinito", async () => {
    const svc = new AgentService(fakeLlm([outcome("", [{ id: "c", name: "noop", arguments: {} }])]));
    const res = await svc.run({ systemPrompt: "s", conversation: [{ role: "user", content: "oi" }], tools: [noopTool], toolCtx, guardrails });
    expect(res.stopReason).toBe("tool_cap");
    expect(res.iterations).toBe(3);
  });

  it("GUARDRAIL teto de custo: custo alto encerra cedo (cost_cap)", async () => {
    const svc = new AgentService(
      fakeLlm([outcome("", [{ id: "c", name: "noop", arguments: {} }], 60_000), outcome("fim")]),
    );
    const res = await svc.run({ systemPrompt: "s", conversation: [{ role: "user", content: "oi" }], tools: [noopTool], toolCtx, guardrails });
    expect(res.stopReason).toBe("cost_cap");
  });
});
