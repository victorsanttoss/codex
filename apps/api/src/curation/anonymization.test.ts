import { describe, expect, it } from "vitest";
import { hasPII, redactPII } from "./anonymization";

describe("anonimização (zero PII no nicho)", () => {
  it("redige e-mail, telefone, CPF, CNPJ e valores", () => {
    const cases: Array<[string, string]> = [
      ["fale com joao@empresa.com", "email"],
      ["meu zap é +55 11 98765-4321", "phone"],
      ["(11) 3456-7890", "phone"],
      ["CPF 123.456.789-00", "cpf"],
      ["CNPJ 12.345.678/0001-99", "cnpj"],
      ["custa R$ 1.299,90", "money"],
      ["fechamos por 5 mil reais", "money"],
    ];
    for (const [text, type] of cases) {
      const r = redactPII(text);
      expect(r.found, text).toContain(type);
      expect(hasPII(r.redacted), `redigido ainda tem PII: ${r.redacted}`).toBe(false);
    }
  });

  it("texto generalizável (sem PII) passa intacto", () => {
    const text = "Na objeção de preço, ancore no retorno do investimento e no custo evitado.";
    const r = redactPII(text);
    expect(r.found).toHaveLength(0);
    expect(r.redacted).toBe(text);
    expect(hasPII(text)).toBe(false);
  });

  it("redige MÚLTIPLA PII na mesma frase", () => {
    const r = redactPII("cliente joao@x.com, fone 11 99999-8888, fechou R$ 10.000");
    expect(r.found).toEqual(expect.arrayContaining(["email", "phone", "money"]));
    expect(hasPII(r.redacted)).toBe(false);
  });
});
