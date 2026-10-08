import { describe, expect, it } from "vitest";
import { mapMetaFieldData, normalizeBrPhone } from "./lead-intake.service";

describe("normalizeBrPhone", () => {
  it("BR sem DDI ganha 55; com DDI passa; formatação é ignorada", () => {
    expect(normalizeBrPhone("(44) 99900-1234")).toBe("5544999001234");
    expect(normalizeBrPhone("44 9900-1234")).toBe("554499001234");
    expect(normalizeBrPhone("+55 44 99900-1234")).toBe("5544999001234");
    expect(normalizeBrPhone("005544999001234")).toBe("5544999001234");
  });
  it("curto demais é inválido; 12+ dígitos passa como veio", () => {
    expect(normalizeBrPhone("99900123")).toBeNull();
    expect(normalizeBrPhone("")).toBeNull();
    // limitação documentada: 10-11 dígitos são assumidos BR (DDD+nº)
    expect(normalizeBrPhone("14155550123")).toBe("5514155550123");
    // internacional com DDI (12+ dígitos) não é tocado
    expect(normalizeBrPhone("+1 415 555 0123 9")).toBe("141555501239");
  });
});

describe("mapMetaFieldData (formato leadgen da Meta)", () => {
  it("mapeia campos padrão e transforma perguntas custom em chaves slug", () => {
    const out = mapMetaFieldData([
      { name: "full_name", values: ["Ana Souza"] },
      { name: "phone_number", values: ["+55 44 99900-1234"] },
      { name: "email", values: ["ana@x.com"] },
      { name: "Qual sua renda familiar?", values: ["R$ 3.500"] },
      { name: "possui imóvel?", values: ["não"] },
      { name: "vazio", values: [] },
    ]);
    expect(out.nome).toBe("Ana Souza");
    expect(out.telefone).toBe("+55 44 99900-1234");
    expect(out.email).toBe("ana@x.com");
    expect(out.qual_sua_renda_familiar).toBe("R$ 3.500");
    expect(out.possui_imovel).toBe("não");
    expect(out).not.toHaveProperty("vazio");
  });
});
