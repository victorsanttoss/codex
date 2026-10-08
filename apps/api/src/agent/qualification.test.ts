import { describe, expect, it } from "vitest";
import {
  coerceField,
  decideQualification,
  decisionToLeadState,
  missingQualificationFields,
  normalizeLeadFields,
  qualificationActive,
  type QualificationSchema,
} from "./qualification";
import { IMOBILIARIO_KIT } from "../verticals/kits/imobiliario";

const schema: QualificationSchema = {
  qualifyAtScore: 3,
  fields: [
    { key: "necessidade", type: "string", required: true, weight: 1 },
    { key: "autoridade", type: "string", required: true, weight: 1 },
    { key: "orcamento", type: "number", weight: 1, eliminatory: { min: 1000 } },
    { key: "prazo", type: "string", weight: 1 },
  ],
};

describe("decideQualification (determinístico)", () => {
  it("obrigatório faltando → pending (continue_discovery)", () => {
    const r = decideQualification(schema, { necessidade: "CRM" });
    expect(r.decision).toBe("pending");
    expect(r.route).toBe("continue_discovery");
    expect(r.missingRequired).toContain("autoridade");
  });

  it("eliminatório violado → disqualified (mesmo com obrigatórios presentes)", () => {
    const r = decideQualification(schema, {
      necessidade: "CRM",
      autoridade: "decisor",
      orcamento: 500, // < min 1000 → elimina
    });
    expect(r.decision).toBe("disqualified");
    expect(r.eliminatedBy).toContain("orcamento");
  });

  it("todos obrigatórios + score >= limite → qualified (handoff)", () => {
    const r = decideQualification(schema, {
      necessidade: "CRM",
      autoridade: "decisor",
      orcamento: 5000,
      prazo: "30 dias",
    });
    expect(r.decision).toBe("qualified");
    expect(r.route).toBe("handoff");
    expect(r.score).toBe(4);
  });

  it("obrigatórios presentes mas score abaixo do limite → disqualified", () => {
    const lean: QualificationSchema = { qualifyAtScore: 5, fields: schema.fields };
    const r = decideQualification(lean, { necessidade: "x", autoridade: "y" });
    expect(r.decision).toBe("disqualified");
  });

  it("kit imobiliário: obrigatórios primeiro mantêm descoberta; opcional posterior qualifica", () => {
    const imob = IMOBILIARIO_KIT.qualificationSchema;
    const firstTurn = { nome: "Ana", renda_familiar: 4500, possui_imovel: false };
    const pending = decideQualification(imob, firstTurn);
    expect(pending).toMatchObject({ decision: "pending", route: "continue_discovery", score: 4, missingRequired: [] });
    expect(decisionToLeadState(pending)).toEqual({ stage: "qualifying", status: "new", score: 4 });
    // A negativa explícita é um dado preenchido, não ausência.
    expect(decideQualification(imob, { ...firstTurn, fgts_disponivel: false }))
      .toMatchObject({ decision: "qualified", score: 5, route: "handoff" });
    expect(imob.qualifyAtScore).toBe(5);
  });

  it("score abaixo da meta só fica pendente enquanto falta pontuação recuperável", () => {
    expect(decideQualification(schema, { necessidade: "CRM", autoridade: "decisor" }).decision).toBe("pending");
    // Os opcionais ausentes não conseguem atingir a meta impossível de 5.
    expect(decideQualification({ ...schema, qualifyAtScore: 5 }, { necessidade: "CRM", autoridade: "decisor" }).decision)
      .toBe("disqualified");
    const fullBelowTarget = { ...schema, qualifyAtScore: 5 };
    expect(decideQualification(fullBelowTarget, { necessidade: "CRM", autoridade: "decisor", orcamento: 5000, prazo: "30 dias" }))
      .toMatchObject({ decision: "disqualified", score: 4 });
  });

  it("eliminatório continua imediato e uma correção explícita é reavaliada", () => {
    expect(decideQualification(schema, { orcamento: 500 }).eliminatedBy).toEqual(["orcamento"]);
    const fields = { necessidade: "CRM", autoridade: "decisor", orcamento: 500 };
    expect(decideQualification(schema, fields).decision).toBe("disqualified");
    expect(decideQualification(schema, { ...fields, orcamento: 5000 }).decision).toBe("qualified");
  });

  it("coage tipo: número como string conta corretamente (não desqualifica)", () => {
    const r = decideQualification(schema, {
      necessidade: "CRM",
      autoridade: "decisor",
      orcamento: "5000", // string numérica → 5000 >= min 1000
      prazo: "30 dias",
    });
    expect(r.decision).toBe("qualified");
    expect(r.eliminatedBy).not.toContain("orcamento");
  });

  it("tipo incoercível → tratado como ausente (não pontua nem elimina)", () => {
    const r = decideQualification(schema, {
      necessidade: "CRM",
      autoridade: "decisor",
      orcamento: { moeda: "BRL" }, // objeto em campo number → ausente
    });
    expect(r.eliminatedBy).not.toContain("orcamento"); // não elimina por engano
    expect(r.score).toBe(2); // só necessidade + autoridade
  });

  it("é PURO: mesma entrada → mesma saída", () => {
    const input = { necessidade: "a", autoridade: "b", orcamento: 2000, prazo: "x" };
    expect(decideQualification(schema, input)).toEqual(decideQualification(schema, input));
  });

  it("decisionToLeadState mapeia decisão → estado", () => {
    expect(decisionToLeadState(decideQualification(schema, {})).status).toBe("new"); // pending
    expect(
      decisionToLeadState(
        decideQualification(schema, { necessidade: "a", autoridade: "b", orcamento: 5000, prazo: "x" }),
      ).status,
    ).toBe("qualified");
  });

  it("DESLIGADA (enabled=false) → decisão NEUTRA: nunca qualifica nem desqualifica", () => {
    const off: QualificationSchema = { ...schema, enabled: false };
    // Mesmo com todos os campos preenchidos (que qualificariam) — neutro.
    const r = decideQualification(off, { necessidade: "a", autoridade: "b", orcamento: 5000, prazo: "x" });
    expect(r).toEqual({ decision: "pending", score: 0, route: "continue_discovery", missingRequired: [], eliminatedBy: [] });
    expect(decisionToLeadState(r).status).toBe("new"); // lead não muda de estágio
  });

  it("sem NENHUM campo → decisão neutra (score 0 não desqualifica tenant sem qualificação)", () => {
    const empty: QualificationSchema = { qualifyAtScore: 3, fields: [] };
    expect(decideQualification(empty, {}).decision).toBe("pending");
  });

  it("qualificationActive: chamadores pulam o applyLeadDecision quando inativa", () => {
    expect(qualificationActive(schema)).toBe(true);
    expect(qualificationActive({ ...schema, enabled: false })).toBe(false);
    expect(qualificationActive({ qualifyAtScore: 3, fields: [] })).toBe(false);
  });
});

describe("validade compartilhada dos campos", () => {
  it("false e zero são presentes; espaços e números inválidos precisam de reparo", () => {
    expect(coerceField(false, "boolean")).toEqual({ present: true, value: false });
    expect(coerceField(" false ", "boolean")).toEqual({ present: true, value: false });
    expect(coerceField(0, "number")).toEqual({ present: true, value: 0 });
    expect(coerceField("   ", "string").present).toBe(false);
    expect(coerceField("muito", "number").present).toBe(false);
    expect(coerceField(Infinity, "number").present).toBe(false);
    const imob = IMOBILIARIO_KIT.qualificationSchema;
    expect(missingQualificationFields(imob, { nome: "Ana", renda_familiar: "muito", possui_imovel: false, fgts_disponivel: false }))
      .toEqual(["renda_familiar", "composicao_familiar", "prazo", "regiao"]);
  });

  it("normaliza só chaves do schema e não transforma entrada incoercível em dado", () => {
    expect(normalizeLeadFields({ necessidade: " CRM ", orcamento: "5000", autoridade: {}, prazo: "  ", extra: "x" }, schema.fields))
      .toEqual({ necessidade: "CRM", orcamento: 5000 });
    expect(normalizeLeadFields(null, schema.fields)).toEqual({});
    expect(normalizeLeadFields([], schema.fields)).toEqual({});
  });
});
