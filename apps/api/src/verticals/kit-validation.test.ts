import { describe, expect, it } from "vitest";
import { compareSemver, validateKit } from "./kit-validation";
import { ALL_KITS, resourceNounForVertical, SOLAR_KIT } from "./kits";

describe("kit validation", () => {
  it("compareSemver ordena corretamente", () => {
    expect(compareSemver("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compareSemver("1.2.0", "1.10.0")).toBeLessThan(0);
  });

  it("TODOS os kits embutidos passam na validação (sem PII, semver, estrutura)", () => {
    // achado Codex: validar só o solar deixava os kits imobiliários sem gate
    for (const [id, kit] of Object.entries(ALL_KITS)) {
      expect(() => validateKit(kit), `kit '${id}'`).not.toThrow();
    }
  });

  it("valores monetários (R$) são PERMITIDOS em kit (tabela pública ≠ PII)", () => {
    expect(() =>
      validateKit({ ...SOLAR_KIT, knowledge: [{ type: "faq", content: "subsídio de até R$ 55 mil na Faixa 1" }] }),
    ).not.toThrow();
  });

  it("rejeita version não-semver", () => {
    expect(() => validateKit({ ...SOLAR_KIT, version: "v1" })).toThrow(/semver/i);
  });

  it("rejeita PII em QUALQUER campo textual (ex.: guidance)", () => {
    expect(() => validateKit({ ...SOLAR_KIT, guidance: "fale com joao@x.com" })).toThrow(/PII/i);
    expect(() =>
      validateKit({ ...SOLAR_KIT, knowledge: [{ type: "faq", content: "ligue 11 99999-8888" }] }),
    ).toThrow(/PII/i);
  });
});

describe("resourceNounForVertical (rótulo do pool de agendas, 0036)", () => {
  it("cada vertical tem o seu termo", () => {
    expect(resourceNounForVertical("odontologia")).toEqual({ singular: "profissional", plural: "profissionais" });
    expect(resourceNounForVertical("imobiliario")).toEqual({ singular: "corretor", plural: "corretores" });
    expect(resourceNounForVertical("energia_solar")).toEqual({ singular: "consultor", plural: "consultores" });
  });

  it("vertical desconhecida/ausente cai no fallback neutro 'agenda'", () => {
    expect(resourceNounForVertical("qualquer_outra")).toEqual({ singular: "agenda", plural: "agendas" });
    expect(resourceNounForVertical(null)).toEqual({ singular: "agenda", plural: "agendas" });
    expect(resourceNounForVertical(undefined)).toEqual({ singular: "agenda", plural: "agendas" });
  });
});
