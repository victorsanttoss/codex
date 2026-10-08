import { describe, expect, it } from "vitest";
import { bubblePauseMs, formatWhatsAppReply, sanitizeWhatsAppText } from "./reply-format";

describe("sanitizeWhatsAppText (o WhatsApp não é markdown)", () => {
  it("converte **negrito** markdown para *negrito* do WhatsApp", () => {
    expect(sanitizeWhatsAppText("A clínica faz **implantes** e **próteses**.")).toBe(
      "A clínica faz *implantes* e *próteses*.",
    );
  });

  it("remove títulos markdown e marcadores de fonte [n]", () => {
    expect(sanitizeWhatsAppText("## Sobre\nFazemos tomografia na própria unidade. [1]")).toBe(
      "Sobre\nFazemos tomografia na própria unidade.",
    );
  });

  it("não toca *negrito* já no formato do WhatsApp", () => {
    expect(sanitizeWhatsAppText("Avaliação *gratuita* amanhã")).toBe("Avaliação *gratuita* amanhã");
  });
});

describe("formatWhatsAppReply (picote em bolhas, como humano)", () => {
  it("parágrafos viram mensagens separadas", () => {
    const bubbles = formatWhatsAppReply(
      "Fazemos implantes sim! A tomografia é feita na própria unidade.\n\nQuer que eu veja um horário de avaliação com o especialista?",
    );
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toContain("própria unidade");
    expect(bubbles[1]).toContain("avaliação");
  });

  it("texto de um parágrafo só = uma bolha (nada muda)", () => {
    expect(formatWhatsAppReply("Oi! Qual é o seu nome? 😊")).toEqual(["Oi! Qual é o seu nome? 😊"]);
  });

  it("respeita o teto de bolhas (excedente agrega na última)", () => {
    const text = ["Primeiro bloco com tamanho ok.", "Segundo bloco com tamanho ok.", "Terceiro bloco com tamanho ok.", "Quarto bloco que estoura o teto."].join("\n\n");
    const bubbles = formatWhatsAppReply(text, 3);
    expect(bubbles).toHaveLength(3);
    expect(bubbles[2]).toContain("Quarto bloco");
  });

  it("bolha muito curta cola na anterior (não spamma mensagem de 2 palavras)", () => {
    const bubbles = formatWhatsAppReply("Perfeito, já registrei seu interesse por aqui!\n\nCombinado! 😊");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain("Combinado");
  });

  it("string vazia → nenhuma bolha", () => {
    expect(formatWhatsAppReply("   ")).toEqual([]);
  });

  it("modelo repetiu saudação+pergunta → dedup verbatim (bug real 06/10)", () => {
    const bubbles = formatWhatsAppReply(
      "Olá! Eu sou a assistente do Residencial Horizonte 😊\n\nMe fala seu nome, por favor?\nOlá! Eu sou a assistente do Residencial Horizonte 😊\n\nMe fala seu nome, por favor?",
    );
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toContain("assistente do Residencial Horizonte");
    expect(bubbles[1]).toBe("Me fala seu nome, por favor?");
  });

  it("remove preâmbulo de raciocínio em inglês vazado (bug real 06/10)", () => {
    const bubbles = formatWhatsAppReply(
      "Need answer about hours and offer available options; no tool needed.\nÀ noite a gente não atende, Victor — o decorado funciona das 9h às 18h.",
    );
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).not.toContain("tool");
    expect(bubbles[0]).toContain("À noite a gente não atende");
  });

  it("NÃO remove 1ª linha PT legítima com 'tool' em nome próprio (acento + \\b do JS)", () => {
    const bubbles = formatWhatsAppReply(
      "Vila Toolé é um dos bairros mais valorizados!\n\nQuer que eu te mostre as unidades?",
    );
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toContain("Vila Toolé");
  });

  it("pausa 'digitando' cresce com a bolha e tem teto", () => {
    expect(bubblePauseMs("oi")).toBeLessThan(600);
    expect(bubblePauseMs("x".repeat(500))).toBe(2_200);
  });
});
