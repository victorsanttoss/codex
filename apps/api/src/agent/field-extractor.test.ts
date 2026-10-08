import { describe, expect, it } from "vitest";
import type { LlmService } from "../llm/llm.service";
import { FieldExtractor, filterExtracted, parseExtractionJson, renderTranscript } from "./field-extractor";
import type { QualificationField } from "./qualification";

const FIELDS: QualificationField[] = [
  { key: "procedimento", type: "string", required: true, weight: 1 },
  { key: "convenio", type: "string", required: true, weight: 1 },
  { key: "orcamento", type: "number", weight: 1 },
];

describe("parseExtractionJson (parse robusto p/ modelos pequenos)", () => {
  it("JSON puro", () => {
    expect(parseExtractionJson('{"a": 1}')).toEqual({ a: 1 });
  });
  it("cerca de código + texto em volta", () => {
    expect(parseExtractionJson('Claro! Aqui está:\n```json\n{"procedimento": "implante"}\n```\nEspero ter ajudado.'))
      .toEqual({ procedimento: "implante" });
  });
  it("chaves dentro de strings não quebram o balanceamento", () => {
    expect(parseExtractionJson('{"a": "tem { e } aqui", "b": 2}')).toEqual({ a: "tem { e } aqui", b: 2 });
  });
  it("sem objeto JSON → null (array, texto, inválido)", () => {
    expect(parseExtractionJson("não sei")).toBeNull();
    expect(parseExtractionJson("[1,2]")).toBeNull();
    expect(parseExtractionJson('{"a": }')).toBeNull();
  });
});

describe("filterExtracted (whitelist + nunca sobrescreve)", () => {
  it("whitelist pelas chaves pedidas; descarta null/vazio/objeto", () => {
    const out = filterExtracted(
      { procedimento: "implante", convenio: null, orcamento: "", extra: "x", obj: { a: 1 } },
      FIELDS,
      {},
    );
    expect(out).toEqual({ procedimento: "implante" });
  });
  it("não sobrescreve campo já preenchido (a tool vence)", () => {
    const out = filterExtracted(
      { procedimento: "OUTRO", convenio: "unimed" },
      FIELDS,
      { procedimento: "implante" },
    );
    expect(out).toEqual({ convenio: "unimed" });
  });
  it("repara número legado inválido e rejeita a nova extração quando também inválida", () => {
    expect(filterExtracted({ orcamento: "5000" }, FIELDS, { orcamento: "não informado" }))
      .toEqual({ orcamento: 5000 });
    expect(filterExtracted({ orcamento: "não sei" }, FIELDS, { orcamento: "não informado" })).toEqual({});
    expect(filterExtracted({ procedimento: "implante" }, FIELDS, { procedimento: "   " }))
      .toEqual({ procedimento: "implante" });
  });
  it("false e zero válidos não são sobrescritos pelo fallback paralelo", () => {
    const boolField: QualificationField = { key: "possui_imovel", type: "boolean" };
    expect(filterExtracted({ orcamento: 5000, possui_imovel: true }, [...FIELDS, boolField], { orcamento: 0, possui_imovel: false }))
      .toEqual({});
    expect(filterExtracted({ possui_imovel: "false" }, [boolField], {})).toEqual({ possui_imovel: false });
  });
});

describe("renderTranscript", () => {
  it("só user/assistant, últimas N, rotulado", () => {
    const t = renderTranscript(
      [
        { role: "system", content: "regras" },
        { role: "user", content: "quero implante" },
        { role: "assistant", content: "qual convênio?" },
      ],
      12,
    );
    expect(t).toBe("Cliente: quero implante\nAtendente: qual convênio?");
  });
});

describe("FieldExtractor.extract", () => {
  const fakeLlm = (content: string): LlmService =>
    ({ async complete() { return { content, toolCalls: [], usage: { tokensIn: 1, tokensOut: 1 }, finishReason: "stop", providerId: "fake", model: "m", costMicros: 7 }; } }) as unknown as LlmService;

  const conversation = [{ role: "user" as const, content: "quero implante, tenho unimed" }];

  it("extrai de resposta suja (cerca de código) e devolve o custo", async () => {
    const ex = new FieldExtractor(fakeLlm('```json\n{"procedimento":"implante","convenio":"unimed","orcamento":null}\n```'));
    const res = await ex.extract({ conversation, fields: FIELDS, missingKeys: ["procedimento", "convenio", "orcamento"], existing: {} });
    expect(res.fields).toEqual({ procedimento: "implante", convenio: "unimed" });
    expect(res.costMicros).toBe(7);
  });

  it("LLM falhou / resposta sem JSON → extrai nada (best-effort, não lança)", async () => {
    const throwing = { async complete() { throw new Error("down"); } } as unknown as LlmService;
    expect((await new FieldExtractor(throwing).extract({ conversation, fields: FIELDS, missingKeys: ["convenio"], existing: {} })).fields).toEqual({});
    expect((await new FieldExtractor(fakeLlm("não sei dizer")).extract({ conversation, fields: FIELDS, missingKeys: ["convenio"], existing: {} })).fields).toEqual({});
  });

  it("sem campos faltando ou sem transcript → nem chama o LLM", async () => {
    const ex = new FieldExtractor({ async complete() { throw new Error("não deveria chamar"); } } as unknown as LlmService);
    expect((await ex.extract({ conversation, fields: FIELDS, missingKeys: [], existing: {} })).fields).toEqual({});
    expect((await ex.extract({ conversation: [], fields: FIELDS, missingKeys: ["convenio"], existing: {} })).fields).toEqual({});
  });
});
