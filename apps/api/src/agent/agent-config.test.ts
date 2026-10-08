import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG, mergeConfig } from "./agent-config";

describe("mergeConfig (config do tenant é dado não-confiável)", () => {
  it("clampa guardrails absurdos para faixa segura", () => {
    const c = mergeConfig(DEFAULT_AGENT_CONFIG, {
      guardrails: { maxToolIterations: 1_000_000, maxCostMicrosPerTurn: -5 },
    });
    expect(c.guardrails.maxToolIterations).toBe(10); // teto
    expect(c.guardrails.maxCostMicrosPerTurn).toBe(1_000); // piso
  });

  it("ignora qualification inválida (cai no default)", () => {
    const c = mergeConfig(DEFAULT_AGENT_CONFIG, { qualification: {} });
    expect(c.qualification).toBe(DEFAULT_AGENT_CONFIG.qualification);
  });

  it("aceita override válido", () => {
    const c = mergeConfig(DEFAULT_AGENT_CONFIG, {
      persona: "Persona do tenant",
      knowledge: { topK: 8, minScore: 0.5 },
      qualification: { qualifyAtScore: 2, fields: [{ key: "x", type: "string" }] },
    });
    expect(c.persona).toBe("Persona do tenant");
    expect(c.knowledge.topK).toBe(8);
    expect(c.qualification.qualifyAtScore).toBe(2);
  });

  it("string vazia cai no default", () => {
    const c = mergeConfig(DEFAULT_AGENT_CONFIG, { persona: "   " });
    expect(c.persona).toBe(DEFAULT_AGENT_CONFIG.persona);
  });

  it("business: aceita strings, descarta não-string e aplica teto de tamanho", () => {
    const c = mergeConfig(DEFAULT_AGENT_CONFIG, {
      business: {
        products: "  Implante e clareamento  ",
        tone: 42, // não-string → vazio
        canSay: "x".repeat(10_000), // acima do teto → cortado
        // cannotSay ausente → vazio
      },
    });
    expect(c.business.products).toBe("Implante e clareamento");
    expect(c.business.tone).toBe("");
    expect(c.business.canSay).toHaveLength(4_000);
    expect(c.business.cannotSay).toBe("");
  });

  it("qualification DESLIGADA aceita fields vazios; LIGADA sem campos cai no default", () => {
    const off = mergeConfig(DEFAULT_AGENT_CONFIG, {
      qualification: { enabled: false, qualifyAtScore: 2, fields: [] },
    });
    expect(off.qualification.enabled).toBe(false);
    expect(off.qualification.fields).toEqual([]);
    // ligada (enabled ausente) com fields vazios = inválida → default
    const on = mergeConfig(DEFAULT_AGENT_CONFIG, { qualification: { qualifyAtScore: 2, fields: [] } });
    expect(on.qualification).toBe(DEFAULT_AGENT_CONFIG.qualification);
    // enabled não-boolean = inválida → default
    const bad = mergeConfig(DEFAULT_AGENT_CONFIG, {
      qualification: { enabled: "sim", qualifyAtScore: 2, fields: [{ key: "x", type: "string" }] },
    });
    expect(bad.qualification).toBe(DEFAULT_AGENT_CONFIG.qualification);
  });

  it("business ausente ou inválido vira objeto vazio (nunca quebra)", () => {
    expect(mergeConfig(DEFAULT_AGENT_CONFIG, {}).business).toEqual({ products: "", tone: "", canSay: "", cannotSay: "" });
    expect(mergeConfig(DEFAULT_AGENT_CONFIG, { business: "hack" }).business).toEqual({ products: "", tone: "", canSay: "", cannotSay: "" });
  });
});
