import { describe, expect, it } from "vitest";
import { chunkText, contentHash, normalizeContent } from "./chunking";

describe("chunking", () => {
  it("texto curto vira um único chunk normalizado", () => {
    const chunks = chunkText("  olá   mundo  ");
    expect(chunks).toEqual(["olá mundo"]);
  });

  it("texto longo é fatiado com sobreposição, sem partir no meio quando possível", () => {
    const word = "palavra ";
    const text = word.repeat(1000); // ~8000 chars
    const chunks = chunkText(text, { maxChars: 1000, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    // sobreposição: o início do 2º chunk reaparece no fim do 1º
    expect(chunks[0]!.endsWith("palavra")).toBe(true);
  });

  it("content_hash é estável sob diferenças de espaço em branco", () => {
    expect(contentHash("a  b\r\n\r\n\r\nc")).toBe(contentHash("a b\n\nc"));
    expect(normalizeContent("x\r\ny")).toBe("x\ny");
  });

  it("texto vazio não gera chunks", () => {
    expect(chunkText("   \n  ")).toEqual([]);
  });
});
