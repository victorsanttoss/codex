import { describe, expect, it } from "vitest";
import type { HistoryMessage } from "@sdr/db";
import { buildConversationMessages } from "./context-builder";
import {
  baseLayer,
  businessLayer,
  composeSystemPrompt,
  conversationLayer,
  nicheLayer,
  tenantLayer,
} from "./prompt-builder";
import { DEFAULT_AGENT_CONFIG } from "./agent-config";

function hist(direction: "inbound" | "outbound", text: string): HistoryMessage {
  return { direction, type: "text", content: { text }, createdAt: new Date(0) };
}

describe("context-builder", () => {
  it("mapeia histórico para user/assistant na ordem", () => {
    const msgs = buildConversationMessages([
      hist("inbound", "oi"),
      hist("outbound", "olá, tudo bem?"),
      hist("inbound", "quero um orçamento"),
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[2]!.content).toBe("quero um orçamento");
  });

  it("ignora mensagens não-texto", () => {
    const msgs = buildConversationMessages([
      { direction: "inbound", type: "media", content: { mediaId: "x" }, createdAt: new Date(0) },
      hist("inbound", "texto"),
    ]);
    expect(msgs).toHaveLength(1);
  });

  it("respeita o orçamento de tokens mantendo as mais recentes", () => {
    const many: HistoryMessage[] = Array.from({ length: 50 }, (_, i) =>
      hist(i % 2 === 0 ? "inbound" : "outbound", "x".repeat(40)),
    );
    const msgs = buildConversationMessages(many, 50); // orçamento pequeno
    expect(msgs.length).toBeLessThan(50);
    expect(msgs.at(-1)!.content).toBe("x".repeat(40)); // manteve a última
  });
});

describe("prompt-builder (camadas componíveis)", () => {
  it("compõe camadas não-vazias; nicho vazio é omitido", () => {
    const prompt = composeSystemPrompt([
      baseLayer,
      nicheLayer(null), // sem nicho → render() = null (omitida)
      tenantLayer(DEFAULT_AGENT_CONFIG),
      conversationLayer({
        stage: "discovery",
        summary: "lead quer CRM",
        retrieved: [
          { chunkId: "1", sourceId: "s", title: "FAQ", externalRef: "faq", content: "preço sob consulta", score: 0.9 },
        ],
        qualification: DEFAULT_AGENT_CONFIG.qualification,
      }),
    ]);
    expect(prompt).toContain("SDR"); // base/tenant
    expect(prompt).toContain("lead quer CRM"); // resumo
    expect(prompt).toContain("FAQ"); // conhecimento recuperado (com fonte)
    expect(prompt).toContain("update_lead_fields"); // instrução de extração
  });

  it("nicheLayer com orientação injeta a camada de nicho (entre base e tenant)", () => {
    const prompt = composeSystemPrompt([
      baseLayer,
      nicheLayer("Em solar, ancore no payback e na conta de luz."),
      tenantLayer(DEFAULT_AGENT_CONFIG),
    ]);
    expect(prompt).toContain("payback"); // orientação de nicho presente
    expect(prompt.indexOf("payback")).toBeLessThan(prompt.indexOf("SDR (pré-vendas)")); // antes do tenant
  });

  it("businessLayer vazio é omitido (tenant sem onboarding não muda o prompt)", () => {
    expect(businessLayer(DEFAULT_AGENT_CONFIG).render()).toBeNull();
  });

  it("businessLayer injeta o que o cliente ensinou, entre nicho e persona", () => {
    const cfg = {
      ...DEFAULT_AGENT_CONFIG,
      business: {
        products: "Implante dentário e clareamento",
        tone: "Acolhedora, chama pelo primeiro nome",
        canSay: "Primeira avaliação gratuita",
        cannotSay: "Prometer resultado de tratamento",
      },
    };
    const prompt = composeSystemPrompt([
      baseLayer,
      nicheLayer("Em odontologia, pergunte o procedimento."),
      businessLayer(cfg),
      tenantLayer(cfg),
    ]);
    expect(prompt).toContain("Implante dentário");
    expect(prompt).toContain("NUNCA deve falar/prometer");
    expect(prompt).toContain("Prometer resultado de tratamento");
    // ordem: nicho → negócio → persona
    expect(prompt.indexOf("odontologia")).toBeLessThan(prompt.indexOf("Implante dentário"));
    expect(prompt.indexOf("Implante dentário")).toBeLessThan(prompt.indexOf("SDR (pré-vendas)"));
  });

  it("businessLayer com só um campo preenchido omite os demais rótulos", () => {
    const cfg = {
      ...DEFAULT_AGENT_CONFIG,
      business: { products: "", tone: "", canSay: "", cannotSay: "Nada de diagnóstico" },
    };
    const rendered = businessLayer(cfg).render();
    expect(rendered).toContain("Nada de diagnóstico");
    expect(rendered).not.toContain("PODE falar");
    expect(rendered).not.toContain("Tom de voz");
  });
});
