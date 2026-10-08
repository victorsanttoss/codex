import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentTools, type AgentToolContext } from "./tools";
import { decideQualification, type QualificationSchema } from "./qualification";
import { DEFAULT_AGENT_CONFIG } from "./agent-config";
import { ODONTO_KIT } from "../verticals/kits/odonto";

const { mergeLeadFields } = vi.hoisted(() => ({ mergeLeadFields: vi.fn() }));
vi.mock("@sdr/db", () => ({ mergeLeadFields }));

const qualification: QualificationSchema = {
  qualifyAtScore: 2,
  fields: [
    { key: "orcamento", type: "number", required: true, weight: 1, eliminatory: { min: 1000 } },
    { key: "possui_imovel", type: "boolean", required: true, weight: 1 },
    { key: "nome", type: "string" },
  ],
};
const update = buildAgentTools().find((t) => t.definition.name === "update_lead_fields")!;
const context = (): AgentToolContext => ({
  conversationId: "conversation-test",
  retriever: {} as AgentToolContext["retriever"],
  knowledge: { topK: 4, minScore: 0.2 },
  qualification,
  turn: { handoffRequested: false, fieldsUpdated: {} },
});

describe("update_lead_fields", () => {
  beforeEach(() => mergeLeadFields.mockReset());

  it("persiste apenas campos permitidos e coercíveis, incluindo false", async () => {
    const ctx = context();
    await update.execute({ fields: { orcamento: "5000", possui_imovel: false, nome: " Ana ", extra: "x" } }, ctx);
    expect(mergeLeadFields).toHaveBeenCalledWith("conversation-test", { orcamento: 5000, possui_imovel: false, nome: "Ana" });
    expect(ctx.turn.fieldsUpdated).toEqual({ orcamento: 5000, possui_imovel: false, nome: "Ana" });
  });

  it("entrada inválida não persiste e não impede o registro posterior correto", async () => {
    const ctx = context();
    await update.execute({ fields: { orcamento: "muito", nome: "   ", possui_imovel: {} } }, ctx);
    expect(mergeLeadFields).not.toHaveBeenCalled();
    expect(ctx.turn.fieldsUpdated).toEqual({});
    await update.execute({ fields: { orcamento: 5000, possui_imovel: false } }, ctx);
    expect(mergeLeadFields).toHaveBeenCalledOnce();
    expect(decideQualification(qualification, ctx.turn.fieldsUpdated).decision).toBe("qualified");
  });

  it("aceita correção válida do lead sem permitir apagar campo com valor inválido", async () => {
    const ctx = context();
    await update.execute({ fields: { orcamento: 500, possui_imovel: false } }, ctx);
    expect(decideQualification(qualification, ctx.turn.fieldsUpdated).decision).toBe("disqualified");
    await update.execute({ fields: { orcamento: "5000" } }, ctx);
    expect(decideQualification(qualification, ctx.turn.fieldsUpdated).decision).toBe("qualified");
    await update.execute({ fields: { orcamento: "não sei" } }, ctx);
    expect(ctx.turn.fieldsUpdated.orcamento).toBe(5000);
    expect(mergeLeadFields).toHaveBeenCalledTimes(2);
  });

  it("qualificação desligada e payload malformado não gravam campos", async () => {
    const ctx = context();
    await update.execute({ fields: null }, ctx);
    await update.execute({ fields: [] }, ctx);
    await update.execute({ fields: "5000" }, ctx);
    await update.execute({ fields: { orcamento: 5000 } }, { ...ctx, qualification: { ...qualification, enabled: false } });
    expect(mergeLeadFields).not.toHaveBeenCalled();
  });

  it("preserva nomes no default e na odontologia sem acrescentar pontos de qualificação", async () => {
    for (const schema of [DEFAULT_AGENT_CONFIG.qualification, ODONTO_KIT.qualificationSchema]) {
      const ctx = { ...context(), qualification: schema };
      await update.execute({ fields: { nome: " Ana ", name: " Ana ", extra: "x" } }, ctx);
      expect(ctx.turn.fieldsUpdated).toEqual({ nome: "Ana", name: "Ana" });
      expect(decideQualification(schema, ctx.turn.fieldsUpdated).score).toBe(0);
    }
    expect(mergeLeadFields).toHaveBeenCalledTimes(2);
  });

  it("identidade aceita somente string não vazia, limita tamanho e não apaga nome válido", async () => {
    const ctx = context();
    await update.execute({ fields: { nome: "Ana" } }, ctx);
    await update.execute({ fields: { nome: 42, name: {} } }, ctx);
    expect(ctx.turn.fieldsUpdated).toEqual({ nome: "Ana" });
    expect(mergeLeadFields).toHaveBeenCalledOnce();
    await update.execute({ fields: { nome: `  ${"a".repeat(100)} ` } }, ctx);
    expect(ctx.turn.fieldsUpdated.nome).toBe("a".repeat(80));
  });

  it("qualificação desligada preserva captura de identidade sem gravar critérios comerciais", async () => {
    const ctx = { ...context(), qualification: { ...qualification, enabled: false } };
    await update.execute({ fields: { nome: "Ana", orcamento: 5000 } }, ctx);
    expect(mergeLeadFields).toHaveBeenCalledWith("conversation-test", { nome: "Ana" });
    expect(ctx.turn.fieldsUpdated).toEqual({ nome: "Ana" });
  });
});
