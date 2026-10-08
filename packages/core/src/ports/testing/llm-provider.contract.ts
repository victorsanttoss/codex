import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../llm-provider";

/**
 * Suíte de contrato REUTILIZÁVEL para `LLMProvider`. Garante que qualquer
 * adaptador (modelo aberto auto-hospedado ou provedor por token) devolva
 * conteúdo E uso (tokens in/out) para alimentar o metering, além de suportar
 * streaming. Exercitada com o `FakeLLMProvider`.
 */
export function runLLMProviderContract(
  name: string,
  makeProvider: () => LLMProvider,
): void {
  describe(`LLMProvider contract :: ${name}`, () => {
    it("complete() devolve conteúdo e uso com tokens in/out >= 0", async () => {
      const p = makeProvider();
      const res = await p.complete({
        model: "any",
        messages: [{ role: "user", content: "oi" }],
      });
      expect(typeof res.content).toBe("string");
      expect(res.usage.tokensIn).toBeGreaterThanOrEqual(0);
      expect(res.usage.tokensOut).toBeGreaterThanOrEqual(0);
      expect(["stop", "length", "tool_calls", "content_filter"]).toContain(res.finishReason);
      expect(Array.isArray(res.toolCalls)).toBe(true);
    });

    it("stream() emite deltas e termina com um chunk 'done' contendo uso", async () => {
      const p = makeProvider();
      const chunks = [];
      for await (const c of p.stream({
        model: "any",
        messages: [{ role: "user", content: "stream isto" }],
      })) {
        chunks.push(c);
      }
      expect(chunks.length).toBeGreaterThan(0);
      const last = chunks.at(-1);
      expect(last?.type).toBe("done");
      if (last?.type === "done") {
        expect(last.usage.tokensIn).toBeGreaterThanOrEqual(0);
        expect(last.usage.tokensOut).toBeGreaterThanOrEqual(0);
      }
    });
  });
}
