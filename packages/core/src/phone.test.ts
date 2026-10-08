import { describe, expect, it } from "vitest";
import { toE164 } from "./phone";

describe("toE164", () => {
  it("wa_id internacional (só dígitos) vira +<dígitos>", () => {
    expect(toE164("5511987654321")).toBe("+5511987654321");
  });

  it("normaliza formatação variada para a MESMA chave", () => {
    const canonical = "+5511987654321";
    expect(toE164("+55 11 98765-4321")).toBe(canonical);
    expect(toE164("55 (11) 98765 4321")).toBe(canonical);
    expect(toE164("005511987654321")).toBe(canonical); // discagem internacional 00
  });

  it("+ preserva os dígitos internacionais (não trata 00 interno)", () => {
    expect(toE164("+100...")).toBe(null); // curto demais após limpar
    expect(toE164("+441632960961")).toBe("+441632960961");
  });

  it("prefixa o país default só para número local (sem +/00)", () => {
    expect(toE164("11987654321", "55")).toBe("+5511987654321"); // 11 dígitos, local
    expect(toE164("5511987654321", "55")).toBe("+5511987654321"); // já tem CC → não duplica
    expect(toE164("+11987654321", "55")).toBe("+11987654321"); // veio com + → não prefixa
  });

  it("rejeita comprimentos implausíveis (E.164 = 8–15 dígitos)", () => {
    expect(toE164("12345")).toBe(null);
    expect(toE164("1234567890123456")).toBe(null);
    expect(toE164("")).toBe(null);
    expect(toE164("abc")).toBe(null);
  });
});

describe("toE164 — wa_id internacional sem default de país (regressão Codex)", () => {
  it("NÃO corrompe wa_id de outros países quando não há defaultCountryCode", () => {
    expect(toE164("15551234567")).toBe("+15551234567"); // EUA, 11 dígitos
    expect(toE164("447911123456")).toBe("+447911123456"); // UK
  });
});
