import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../embedding-provider";

/**
 * Suíte de contrato REUTILIZÁVEL para `EmbeddingProvider`. Garante que qualquer
 * adaptador devolva UM vetor por texto (na ordem), com dimensão consistente e
 * uso (tokens de entrada) para alimentar o metering. Exercitada com o
 * `FakeEmbeddingProvider` e por cada adaptador concreto.
 */
export function runEmbeddingProviderContract(
  name: string,
  makeProvider: () => EmbeddingProvider,
): void {
  describe(`EmbeddingProvider contract :: ${name}`, () => {
    it("embed() devolve um vetor por texto, na ordem, com dimensão consistente", async () => {
      const p = makeProvider();
      const res = await p.embed(["primeiro", "segundo", "terceiro"]);
      expect(res.vectors.length).toBe(3);
      const dim = res.vectors[0]!.length;
      expect(dim).toBeGreaterThan(0);
      for (const v of res.vectors) {
        expect(v.length).toBe(dim);
        expect(v.every((x) => typeof x === "number" && Number.isFinite(x))).toBe(true);
      }
    });

    it("embed() reporta uso com tokensIn >= 0", async () => {
      const p = makeProvider();
      const res = await p.embed(["medir uso"]);
      expect(res.usage.tokensIn).toBeGreaterThanOrEqual(0);
    });

    it("embed([]) devolve nenhum vetor (sem chamar o provedor à toa)", async () => {
      const p = makeProvider();
      const res = await p.embed([]);
      expect(res.vectors).toEqual([]);
    });
  });
}
