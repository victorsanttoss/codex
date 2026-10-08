import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Garante o núcleo AGNÓSTICO: nenhum import de fornecedor concreto (SDK de LLM,
 * adaptador de canal) pode vazar para packages/core. Só ports/tipos/contratos.
 */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("núcleo agnóstico a fornecedor", () => {
  it("packages/core não importa adaptadores/SDKs de fornecedor", () => {
    // pega import estático, import() dinâmico e require() — literais de fornecedor
    // (SDKs de LLM/embeddings + CRM, e adaptadores @sdr/*).
    const banned =
      /(?:from|import|require)\s*\(?\s*["'](?:@anthropic-ai\/[^"']*|openai|@hubspot\/[^"']*|@pipedrive\/[^"']*|hubspot|pipedrive|@sdr\/(?:llm-|whatsapp-cloud|embeddings-|crm-|transcription-)[^"']*)["']/;
    for (const file of tsFiles(__dirname)) {
      if (file.endsWith(".test.ts")) continue; // testes podem importar utilitários
      const src = readFileSync(file, "utf8");
      expect(banned.test(src), `${file} importa fornecedor concreto`).toBe(false);
    }
  });

  it("o package.json do core não declara dependência de fornecedor", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    const offenders = deps.filter(
      (d) =>
        d === "openai" ||
        d === "hubspot" ||
        d === "pipedrive" ||
        d.startsWith("@anthropic-ai/") ||
        d.startsWith("@hubspot/") ||
        d.startsWith("@pipedrive/") ||
        /^@sdr\/(llm-|whatsapp-cloud|embeddings-|crm-|transcription-)/.test(d),
    );
    expect(offenders, `core depende de fornecedor: ${offenders.join(", ")}`).toEqual([]);
  });
});
