import type { VerticalKit } from "../vertical-kit";

/**
 * VERTICAL: Imobiliário — PRONTOS/USADOS E LOCAÇÃO (imobiliária tradicional).
 * Pesquisa ago/2026: a diferença deste padrão é a URGÊNCIA — locação decide em
 * DIAS (lead não respondido em minutos vai pro concorrente; meta = visita na
 * primeira conversa); compra de usado matura semanas e frequentemente depende
 * de VENDER o imóvel atual (abre avaliação/permuta). Genérico (sem PII).
 */
export const IMOBILIARIO_USADOS_KIT: VerticalKit = {
  version: "1.0.0",
  niche: { name: "imobiliario_usados_br", vertical: "imobiliario", motion: "orcamento_cotacao" },
  resourceNoun: { singular: "corretor", plural: "corretores" },
  guidance:
    "Você é a SDR de uma imobiliária (imóveis prontos: venda de usados e locação). Objetivo: " +
    "qualificar rápido e AGENDAR VISITA — na locação, idealmente na primeira conversa. " +
    "TÉCNICA: (1) UMA pergunta por mensagem, tom leve e ágil; (2) primeira bifurcação: " +
    "'comprar ou alugar?' — muda o funil inteiro; (3) VELOCIDADE é o maior conversor deste " +
    "segmento: seja direto, ofereça visita cedo ('posso te mostrar hoje às 18h?'); (4) máximo " +
    "de 2-3 opções curadas por vez — nunca catálogo inteiro; (5) termine todo turno com " +
    "próximo passo (visita, envio de opções, retorno com data); (6) na compra, pergunte cedo " +
    "se depende de vender o imóvel atual (abre avaliação gratuita/permuta); (7) na locação, " +
    "resolva a garantia logo (fiador × caução × seguro-fiança) e a regra de renda ~3x o " +
    "aluguel; (8) escassez só verdadeira: usado é peça única e não tem reserva — dizer isso " +
    "com transparência é honesto E cria urgência real. Não invente valor, disponibilidade ou " +
    "condições: consulte a base; se não souber, o corretor confirma.",
  knowledge: [
    { type: "qualifying_question", content: "Bifurcação: 'Você procura pra comprar ou pra alugar?' Depois: região preferida (com segunda opção), casa × apartamento, quantos quartos." },
    { type: "qualifying_question", content: "Valor com contexto: compra → 'Qual faixa de valor fica confortável?'; locação → 'Qual valor por mês, já pensando no pacote com condomínio e IPTU?'" },
    { type: "qualifying_question", content: "Urgência (define o ritmo): 'Pra quando você precisa? Está pensando em visitar essa semana ou ainda pesquisando?' — locação urgente = visita HOJE/amanhã." },
    { type: "qualifying_question", content: "Locação — garantia cedo: 'Sobre a garantia: você teria fiador, prefere caução ou seguro-fiança? E sua renda comprovada dá cerca de 3x o aluguel?'" },
    { type: "qualifying_question", content: "Compra — troca: 'Você depende de vender ou dar seu imóvel atual na negociação? Posso pedir uma avaliação sem custo.'" },
    { type: "qualifying_question", content: "Fechamento de turno: 'Achando 2-3 opções dentro disso, te mando hoje e já deixo uma visita reservada?'" },
    { type: "objection_handling", content: "'Está caro': validar e reancorar — 'vamos ver o que faz esse imóvel valer o investimento' + comparação de R$/m² da região + margem de proposta ('o proprietário analisa propostas')." },
    { type: "objection_handling", content: "'Vou pensar': prazo + honestidade de mercado — 'Claro! Só te aviso com transparência: usado não tem reserva; se aparecer proposta, ele vai. Te retorno quinta, pode ser?'" },
    { type: "objection_handling", content: "'Preciso falar com marido/esposa': 'Agendo uma revisita pros dois juntos? Sábado de manhã tenho horário.'" },
    { type: "objection_handling", content: "'Não tenho fiador' (locação): 'Sem problema — temos caução (até 3 aluguéis, devolvida corrigida) e seguro-fiança (mensal, sem depender de ninguém). Qual encaixa melhor?'" },
    { type: "objection_handling", content: "'Preciso vender o meu antes': 'A gente resolve os dois juntos: avaliação gratuita do seu, e dá para estudar seu imóvel como parte de pagamento (permuta com torna) — uma transação só, mais rápida.'" },
    { type: "objection_handling", content: "'Precisa de reforma / não gostei de X': transformar em vantagem de preço ('margem pra negociar e reformar do seu jeito') OU oferecer alternativa imediata — na locação, mandar outra opção NA HORA do feedback da visita." },
    { type: "objection_handling", content: "'Custos extras pesam (ITBI, cartório, condomínio)': transparência antecipada com a planilha de custos; condomínio como acesso a lazer/segurança que casa avulsa não tem." },
    { type: "faq", content: "Argumentos que convertem em prontos/locação: (1) VELOCIDADE — responder em minutos é o maior conversor do segmento; (2) visita sem fricção ('posso te mostrar hoje'); (3) disponibilidade imediata — pronto pra morar, sem esperar obra; (4) escassez verdadeira (usado é peça única, sem reserva); (5) processo digital descomplicado (ficha, docs e assinatura online)." },
    { type: "vocabulary", content: "Locação: ficha/análise cadastral, garantia locatícia, fiador, caução, seguro-fiança, Lei do Inquilinato, vistoria de entrada, pacote (aluguel+condomínio+IPTU), reajuste (IGP-M/IPCA). Venda: avaliação, ITBI, escritura, matrícula, financiamento SBPE, proposta, sinal, permuta/torna, 'aceita financiamento/FGTS'." },
    { type: "document_request", content: "Locação: documento com foto, comprovante de renda (~3x o aluguel) e a garantia escolhida. Compra: documento, comprovante de renda p/ financiamento e, na troca, matrícula do imóvel atual. Orientar a separar — sem enviar documentos no chat." },
  ],
  qualificationSchema: {
    qualifyAtScore: 5,
    fields: [
      { key: "nome", type: "string", required: true, weight: 1, description: "nome da pessoa interessada" },
      { key: "comprar_ou_alugar", type: "string", required: true, weight: 2, description: "se quer comprar ou alugar" },
      { key: "tipo_imovel", type: "string", weight: 1, description: "casa ou apartamento e quantos quartos" },
      { key: "regiao", type: "string", weight: 1, description: "bairro/região preferida" },
      { key: "faixa_valor", type: "number", weight: 1, description: "valor confortável em reais (aluguel: pacote mensal; compra: valor do imóvel) — apenas o número" },
      { key: "urgencia", type: "string", weight: 1, description: "para quando precisa (essa semana, este mês, pesquisando)" },
    ],
  },
  templates: [
    { name: "imob_usados_opcoes", languageCode: "pt_BR", variables: ["nome"], category: "marketing" },
  ],
};
